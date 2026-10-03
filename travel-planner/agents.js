import db from "./db.js";
import { GoogleGenAI } from "@google/genai";
import "dotenv/config";

/**
 * 9 Deterministic Multi-Agent Definitions
 * Each agent is a pure worker that takes (trip, state) and returns:
 * {
 *   decision: string,
 *   confidence: number,
 *   reasoning: string,
 *   payload: object
 * }
 */

// Helper to normalize destination string
function cleanDest(dest) {
  if (!dest) return "Ooty";
  if (/ooty/i.test(dest)) return "Ooty";
  if (/munnar/i.test(dest)) return "Munnar";
  if (/kodaikanal|kodai/i.test(dest)) return "Kodaikanal";
  if (/kochin|cochin/i.test(dest)) return "Kochin";
  if (/goa/i.test(dest)) return "Goa";
  if (/manali/i.test(dest)) return "Manali";
  if (/dubai/i.test(dest)) return "Dubai";
  if (/paris/i.test(dest)) return "Paris";
  if (/hill\s*station/i.test(dest)) return "Ooty";
  return dest.split(" ")[0];
}

// Helper to parse dates
function getTripDays(startDate, endDate) {
  if (!startDate) return 3;
  const start = new Date(startDate);
  const end = endDate ? new Date(endDate) : new Date(start.getTime() + 3 * 86400000);
  const diffTime = Math.abs(end - start);
  const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
  return diffDays > 0 ? diffDays : 3;
}

export const AGENTS = {
  // 1. IntakeAgent: Validate trip record, check dates and travelers, trigger clarification if info is missing
  IntakeAgent(trip, state) {
    const isVagueDest = !trip.destination || /unknown|somewhere|anywhere/i.test(trip.destination);
    const isVagueOrigin = !trip.origin || /unknown/i.test(trip.origin);
    const isMissingDate = !trip.start_date;

    if (isVagueDest || isVagueOrigin || isMissingDate) {
      const missing = [];
      if (isVagueOrigin) missing.push("origin departure city");
      if (isVagueDest) missing.push("destination preference");
      if (isMissingDate) missing.push("travel dates");

      return {
        decision: "needs_info",
        confidence: 0.95,
        reasoning: `Inquiry is ambiguous. Missing: ${missing.join(", ")}. Initiated clarification question back to customer.`,
        payload: {
          missing_fields: missing,
          clarification_prompt: `Hi! We'd love to help plan your getaway. Could you tell us your ${missing.join(" and ")}?`
        }
      };
    }

    const start = new Date(trip.start_date);
    if (isNaN(start.getTime())) {
      return {
        decision: "invalid",
        confidence: 0.95,
        reasoning: "Invalid date format for start_date",
        payload: { error: "Unparseable date" }
      };
    }

    return {
      decision: "valid",
      confidence: 0.98,
      reasoning: `Trip parameters verified: ${trip.origin} ➔ ${trip.destination} for ${trip.travelers} traveler(s)`,
      payload: {
        normalized_origin: trip.origin.trim(),
        normalized_destination: cleanDest(trip.destination),
        days: getTripDays(trip.start_date, trip.end_date)
      }
    };
  },

  // 2. BudgetAgent: dest_costs * days * travelers vs budget_usd
  BudgetAgent(trip, state) {
    const dest = cleanDest(trip.destination);
    const days = getTripDays(trip.start_date, trip.end_date);
    const travelers = trip.travelers || 1;

    // Look up dest_costs table
    const costRow = db.prepare("SELECT daily_cost_usd FROM dest_costs WHERE destination LIKE ?").get(`%${dest}%`);
    const dailyRate = costRow ? costRow.daily_cost_usd : 60;
    const estimatedCost = dailyRate * days * travelers;
    const budget = trip.budget_usd || 500;

    if (budget < estimatedCost * 0.5) {
      return {
        decision: "impossible",
        confidence: 0.92,
        reasoning: `Budget $${budget} is far below minimum estimated cost $${estimatedCost} (${travelers} travelers × ${days} days in ${dest})`,
        payload: { estimatedCost, budget, shortfall: estimatedCost - budget }
      };
    }

    if (budget < estimatedCost * 0.85) {
      return {
        decision: "tight",
        confidence: 0.85,
        reasoning: `Budget $${budget} is tight compared to estimated cost $${estimatedCost} for ${dest}. Triggering Alternative negotiation.`,
        payload: { estimatedCost, budget, variance: estimatedCost - budget, reason: "budget_tight" }
      };
    }

    return {
      decision: "ok",
      confidence: 0.94,
      reasoning: `Budget $${budget} is sufficient for estimated cost $${estimatedCost} (${travelers} pax, ${days} days in ${dest}).`,
      payload: { estimatedCost, budget, surplus: budget - estimatedCost }
    };
  },

  // 3. VisaAgent: Look up visa_rules for origin -> destination
  VisaAgent(trip, state) {
    const dest = cleanDest(trip.destination);
    const origin = trip.origin.trim();

    // Query visa_rules
    const rule = db.prepare("SELECT requirement, notes FROM visa_rules WHERE destination LIKE ?").get(`%${dest}%`);

    if (rule && rule.requirement === "blocked") {
      return {
        decision: "blocked",
        confidence: 0.99,
        reasoning: `Travel from ${origin} to ${dest} is restricted or blocked: ${rule.notes}`,
        payload: { destination: dest, requirement: rule.requirement, reason: "visa_blocked" }
      };
    }

    return {
      decision: "ok",
      confidence: 0.96,
      reasoning: `Visa status clear for ${origin} ➔ ${dest}: ${rule ? rule.requirement : "visa_free / domestic"}`,
      payload: { requirement: rule ? rule.requirement : "visa_free" }
    };
  },

  // 4. WeatherAgent: Check weather_profile for trip month
  WeatherAgent(trip, state) {
    const dest = cleanDest(trip.destination);
    const date = new Date(trip.start_date);
    const month = isNaN(date.getTime()) ? 12 : date.getMonth() + 1;

    const weather = db.prepare("SELECT suitability, avg_temp_c, notes FROM weather_profile WHERE destination LIKE ? AND month = ?").get(`%${dest}%`, month);

    if (weather && weather.suitability === "bad") {
      return {
        decision: "bad",
        confidence: 0.88,
        reasoning: `Unfavorable weather in ${dest} during month ${month}: ${weather.notes} (${weather.avg_temp_c}°C)`,
        payload: { month, weather, reason: "weather_bad" }
      };
    }

    return {
      decision: "good",
      confidence: 0.93,
      reasoning: `Favorable weather in ${dest} for month ${month}: ${weather ? weather.notes : "Pleasant climate"} (${weather ? weather.avg_temp_c : 20}°C)`,
      payload: { month, weather }
    };
  },

  // 5. AlternativeAgent: Dynamic negotiation (replaces destination with nearby budget-friendly spot OR shifts dates)
  AlternativeAgent(trip, state) {
    const tries = (state.alternative_tries || 0) + 1;
    if (tries > (state.max_alternatives || 2)) {
      return {
        decision: "give_up",
        confidence: 0.95,
        reasoning: `Exceeded maximum alternative attempts (${tries - 1}/${state.max_alternatives}). Negotiations exhausted.`,
        payload: { alternative_tries: tries }
      };
    }

    // Dynamic destination substitution map
    const destinationSubstitutes = {
      Ooty: { alt: "Kodaikanal", savings: "20% cheaper stays & serene pine forests" },
      Munnar: { alt: "Wayanad", savings: "Budget-friendly tea plantations and treehouse resorts" },
      Goa: { alt: "Gokarna", savings: "Pristine, less crowded beaches and lower tariff" },
      Manali: { alt: "Dharamshala", savings: "Quiet Himalayan valley with lower peak-season rates" },
      Dubai: { alt: "Kochin", savings: "Rich culture and luxury resorts at fraction of flight cost" }
    };

    const currentDest = cleanDest(trip.destination);
    const substitute = destinationSubstitutes[currentDest];

    // Attempt 1: If destination substitute exists, negotiate location
    if (substitute && tries === 1) {
      // Temporarily swap trip destination in memory/run
      trip.destination = substitute.alt;
      return {
        decision: "retry",
        confidence: 0.90,
        reasoning: `Negotiated alternative destination: Switched ${currentDest} ➔ ${substitute.alt} (${substitute.savings}). Re-checking budget and itinerary.`,
        payload: {
          strategy: "location_substitution",
          original_destination: currentDest,
          proposed_destination: substitute.alt,
          benefit: substitute.savings,
          attempt: tries
        }
      };
    }

    // Attempt 2: Date shift +3 days / off-peak shift
    const currentStart = new Date(trip.start_date);
    currentStart.setDate(currentStart.getDate() + 3);
    const newStartDate = currentStart.toISOString().split("T")[0];
    trip.start_date = newStartDate;

    return {
      decision: "retry",
      confidence: 0.86,
      reasoning: `Negotiated alternative travel window: Shifted travel dates to ${newStartDate} to capture mid-week rates and better weather (Attempt #${tries})`,
      payload: {
        strategy: "date_shift",
        adjusted_start_date: newStartDate,
        attempt: tries
      }
    };
  },

  // 6. FlightAgent: Query mock_flights within budget slice
  FlightAgent(trip, state) {
    const dest = cleanDest(trip.destination);
    // Find flight matching origin and destination
    let flight = db.prepare("SELECT * FROM mock_flights WHERE destination LIKE ? LIMIT 1").get(`%${dest}%`);
    if (!flight) {
      // Find fallback or regional flight
      flight = db.prepare("SELECT * FROM mock_flights LIMIT 1").get();
    }

    if (!flight) {
      return {
        decision: "none",
        confidence: 0.8,
        reasoning: `No matching flight inventory found for ${trip.origin} ➔ ${dest}`,
        payload: {}
      };
    }

    return {
      decision: "found",
      confidence: 0.91,
      reasoning: `Flight identified: ${flight.airline} from ${flight.origin} to ${flight.destination} ($${flight.price_usd})`,
      payload: { flight }
    };
  },

  // 7. HotelAgent: Query mock_hotels within destination
  HotelAgent(trip, state) {
    const dest = cleanDest(trip.destination);
    let hotel = db.prepare("SELECT * FROM mock_hotels WHERE destination LIKE ? ORDER BY rating DESC LIMIT 1").get(`%${dest}%`);
    if (!hotel) {
      hotel = db.prepare("SELECT * FROM mock_hotels ORDER BY rating DESC LIMIT 1").get();
    }

    if (!hotel) {
      return {
        decision: "none",
        confidence: 0.8,
        reasoning: `No accommodation inventory found in ${dest}`,
        payload: {}
      };
    }

    return {
      decision: "found",
      confidence: 0.94,
      reasoning: `Selected accommodation: ${hotel.name} ($${hotel.nightly_usd}/night, Rating: ${hotel.rating}⭐)`,
      payload: { hotel }
    };
  },

  // 8. ItineraryAgent: Assemble final structured plan
  async ItineraryAgent(trip, state) {
    const dest = cleanDest(trip.destination);
    const days = getTripDays(trip.start_date, trip.end_date);

    // Try generating a brief customized itinerary with Gemini if key exists
    let aiItinerary = null;
    if (process.env.GEMINI_API_KEY) {
      try {
        const ai = new GoogleGenAI();
        const prompt = `Write a crisp ${days}-day travel itinerary for ${trip.travelers} traveler(s) from ${trip.origin} to ${dest} (${trip.trip_type}). Budget: $${trip.budget_usd}. Include 3 daily bullet points, 1 food tip, and 1 safety tip. Keep it under 150 words.`;
        const res = await ai.models.generateContent({
          model: "gemini-3.5-flash",
          contents: prompt
        });
        aiItinerary = res.text;
      } catch (e) {
        console.warn("ItineraryAgent Gemini prompt failed, using structured template:", e.message);
      }
    }

    const plan = {
      trip_id: trip.id,
      route: `${trip.origin} ➔ ${dest}`,
      duration: `${days} Days / ${days - 1} Nights`,
      dates: `${trip.start_date} to ${trip.end_date || 'Flexible'}`,
      travelers: `${trip.travelers} (${trip.companions || 'Standard'})`,
      total_budget: `$${trip.budget_usd || 500}`,
      status: "CONFIRMED_ITINERARY",
      custom_plan: aiItinerary || `Day 1: Arrival in ${dest}, hotel check-in and leisure sunset.\nDay 2: Full day sightseeing and local cuisine tasting.\nDay 3: Scenic viewpoints and return journey to ${trip.origin}.`
    };

    return {
      decision: "complete",
      confidence: 0.97,
      reasoning: `Full itinerary assembled successfully for ${dest}`,
      payload: plan
    };
  },

  // 9. RejectAgent: Produce structured rejection with reasons
  RejectAgent(trip, state) {
    return {
      decision: "rejected",
      confidence: 0.99,
      reasoning: `Trip request cannot be fulfilled: ${state.last_reasoning || "Failed requirements or loop limit reached"}`,
      payload: {
        reason: state.last_reasoning || "Requirements not met",
        trip_id: trip.id,
        suggested_action: "Please revise budget, adjust travel season, or choose an alternate destination."
      }
    };
  }
};

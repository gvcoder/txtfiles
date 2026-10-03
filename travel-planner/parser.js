import { classifyWithLaya } from "./laya_classifier.js";
import { extractWithGemini } from "./gemini_service.js";

// Message parser combining Gemini Deep Extraction + Laya validation
/**
 * Extracts structured travel request fields from natural language messages.
 * Uses Gemini LLM for deep entity extraction, and Laya systemOne for classification.
 */
export async function extractTripDetails(text) {
  // 1. Try Gemini LLM extraction first if available
  let geminiData = null;
  try {
    geminiData = await extractWithGemini(text);
  } catch (e) {
    console.warn("Gemini extraction error:", e.message);
  }
  const result = {
    raw_message: text,
    user_id: "whatsapp_user",
    origin: "",
    destination: "",
    start_date: "",
    end_date: "",
    travelers: 1,
    budget_usd: 500, // reasonable default
    trip_type: "leisure",
    companions: "",
    preferences: "",
    status: "pending"
  };

  const lower = text.toLowerCase();

  // 1. Origin extraction ("from <origin>")
  const fromMatch = text.match(/\bfrom\s+([A-Za-z\s]+?)(?=\s+(?:to|on|with|for|around|by|this|next|\d{1,2}|$))/i);
  if (fromMatch) {
    result.origin = fromMatch[1].trim();
  }

  // 2. Destination extraction
  // Pattern a: "around <place>" or "near <place>"
  const aroundMatch = text.match(/\b(?:around|near)\s+([A-Za-z\s]+?)(?=\s+(?:-|–|on|with|for|from|by|this|next|\d{1,2}|can\s+you|$))/i);
  // Pattern b: "to <destination>" (avoid matching words like "travel" in "want to travel")
  const toMatch = text.match(/\bto\s+(?:some\s+)?([A-Za-z\s]+?)(?=\s+(?:-|–|on|with|for|from|around|by|this|next|\d{1,2}|can\s+you|$))/i);

  if (aroundMatch) {
    result.destination = aroundMatch[1].trim();
  } else if (toMatch && !['travel', 'visit', 'go'].includes(toMatch[1].trim().toLowerCase())) {
    result.destination = toMatch[1].trim();
  }

  // Fallbacks based on category if destination is vague or empty
  if (!result.destination || ['travel', 'visit', 'go'].includes(result.destination.toLowerCase())) {
    if (/hill\s*station/i.test(lower)) {
      result.destination = "Hill Station (e.g. Ooty/Munnar/Kodaikanal)";
    } else if (/kochin|cochin/i.test(lower)) {
      result.destination = "Kochin";
    } else {
      result.destination = "Resort / Scenic Getaway";
    }
  }

  // 3. Trip type hints
  if (/hill\s*station/i.test(lower)) {
    result.trip_type = "hill station";
  } else if (/resort/i.test(lower)) {
    result.trip_type = "resort stay";
  } else if (/beach/i.test(lower)) {
    result.trip_type = "beach";
  } else if (/pilgrim|temple/i.test(lower)) {
    result.trip_type = "pilgrimage";
  } else if (/adventure|trek/i.test(lower)) {
    result.trip_type = "adventure";
  }

  // 4. Travelers & Companions
  if (/\b(?:with\s+my\s+wife|wife|spouse|partner|couple)\b/i.test(lower)) {
    result.companions = "Couple (Wife/Partner)";
    result.travelers = 2;
  }
  
  const familyMatch = text.match(/family\s+of\s+(\d+)/i);
  if (familyMatch) {
    result.travelers = parseInt(familyMatch[1], 10);
    result.companions = `Family of ${result.travelers}`;
  } else {
    const membersMatch = text.match(/(\d+)\s*(?:people|members|persons|pax|adults)/i);
    if (membersMatch) {
      result.travelers = parseInt(membersMatch[1], 10);
      result.companions = `${result.travelers} members`;
    }
  }

  if (/\bsolo\b/i.test(lower)) {
    result.travelers = 1;
    result.companions = "Solo";
  } else if (/\bfriends\b/i.test(lower)) {
    result.companions = "Friends";
    if (result.travelers === 1) result.travelers = 3;
  }

  // 5. Date extraction
  // Format: "24 Dec 2026" or "24th Dec 2026" or "24-12-2026" or "2026-12-24"
  const dateRegex = /\b(\d{1,2})(?:st|nd|rd|th)?\s+(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(\d{4})\b/i;
  const matchDate = text.match(dateRegex);
  if (matchDate) {
    const day = matchDate[1].padStart(2, "0");
    const monthNames = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
    const monthIdx = monthNames.findIndex(m => matchDate[2].toLowerCase().startsWith(m)) + 1;
    const month = String(monthIdx).padStart(2, "0");
    const year = matchDate[3];
    result.start_date = `${year}-${month}-${day}`;
    // Default 3-day trip
    const d = new Date(`${year}-${month}-${day}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 3);
    result.end_date = d.toISOString().split("T")[0];
  } else if (/\bthis\s+weekend\b/i.test(lower)) {
    const now = new Date();
    // Calculate upcoming Saturday
    const dayOfWeek = now.getDay();
    const daysUntilSaturday = (6 - dayOfWeek + 7) % 7 || 7;
    const sat = new Date(now);
    sat.setDate(now.getDate() + daysUntilSaturday);
    const sun = new Date(sat);
    sun.setDate(sat.getDate() + 1);

    result.start_date = sat.toISOString().split("T")[0];
    result.end_date = sun.toISOString().split("T")[0];
    result.preferences = "Weekend getaway";
  } else {
    // Default fallback to 1 month from now
    const d = new Date();
    d.setDate(d.getDate() + 14);
    result.start_date = d.toISOString().split("T")[0];
    d.setDate(d.getDate() + 3);
    result.end_date = d.toISOString().split("T")[0];
  }

  // Budget detection if mentioned like "budget 20000" or "$500"
  const budgetMatch = text.match(/(?:budget|cost|price|max|under)\s*(?:of|is|:)?\s*(?:rs\.?|inr|\$)?\s*(\d+(?:,\d+)*(?:\.\d+)?)/i);
  if (budgetMatch) {
    const val = parseFloat(budgetMatch[1].replace(/,/g, ""));
    // Convert INR rough estimate if > 1000
    result.budget_usd = val > 2000 ? Math.round(val / 85) : val;
  }

  // Default origin if missing
  if (!result.origin) {
    result.origin = "Chennai";
  }
  if (!result.destination) {
    result.destination = "Resort / Hill Station";
  }

  // 6. If Gemini succeeded, prioritize its high-accuracy reasoning on places and dates
  if (geminiData) {
    if (geminiData.origin) result.origin = geminiData.origin;
    if (geminiData.destination) result.destination = geminiData.destination;
    if (geminiData.start_date) result.start_date = geminiData.start_date;
    if (geminiData.end_date) result.end_date = geminiData.end_date;
    if (geminiData.travelers) result.travelers = geminiData.travelers;
    if (geminiData.companions) result.companions = geminiData.companions;
    if (geminiData.trip_type) result.trip_type = geminiData.trip_type;
    if (geminiData.budget_usd) result.budget_usd = geminiData.budget_usd;
    if (geminiData.preferences) result.preferences = geminiData.preferences;
    result.llm_model = geminiData._llm_model;
  }

  // 7. Augment with Laya SystemOne ML Classification for validation & confidence
  try {
    const layaResult = await classifyWithLaya(text);
    if (layaResult) {
      if (!result.trip_type && layaResult.trip_category) {
        result.trip_type = layaResult.trip_category;
      }
      if (!result.companions && layaResult.traveler_type) {
        result.companions = layaResult.traveler_type;
      }
      result.laya_meta = {
        category_confidence: layaResult.trip_category_probs ? layaResult.trip_category_probs[layaResult.trip_category] : null,
        traveler_type: layaResult.traveler_type,
        timeframe: layaResult.timeframe,
        tokens_used: layaResult.tokens_used
      };
    }
  } catch (err) {
    console.error("Laya parsing step error:", err);
  }

  return result;
}


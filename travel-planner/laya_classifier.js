import { Laya } from "@receptron/laya";

let layaInstance = null;

export async function getLaya() {
  if (!layaInstance) {
    layaInstance = await Laya.load();
  }
  return layaInstance;
}

/**
 * Uses Laya systemOne classification to categorize intent, trip category,
 * traveler type, and timeframe urgency with probabilities.
 */
export async function classifyWithLaya(text) {
  try {
    const laya = await getLaya();
    const result = await laya.systemOne(
      { message: text },
      {
        trip_category: {
          type: "choice",
          instructions: "What category of trip or destination is the user inquiring about?",
          criteria: {
            "hill station": "Mountains, hill stations, cool climates like Ooty, Munnar, Kodaikanal, Shimla, Manali",
            "resort stay": "Relaxing luxury or nature resort stay, private villa, retreat around Kochin, Kabini, Wayanad",
            "beach": "Coastal beaches, sea view, beach resorts, islands like Goa, Gokarna, Pondicherry",
            "heritage": "Historical monuments, temple pilgrimage, cultural cities, architecture",
            "adventure": "Trekking, hiking, jungle safari, camping, outdoor sports"
          }
        },
        traveler_type: {
          type: "choice",
          instructions: "Who are the travelers mentioned in this inquiry?",
          criteria: {
            "couple": "Husband and wife, spouse, couple, partner, girlfriend/boyfriend",
            "family": "Family with kids, family members, parents",
            "solo": "Solo traveler, myself alone, backpacking solo",
            "friends": "Group of friends, buddies, colleagues, gang"
          }
        },
        timeframe: {
          type: "choice",
          instructions: "When is the trip planned for?",
          criteria: {
            "weekend": "Happening this weekend or immediate coming weekend",
            "near_term": "Planned within this month or coming 2-4 weeks",
            "future_date": "Specific future date or several months ahead"
          }
        }
      }
    );

    return {
      trip_category: result.answers.trip_category?.choice || null,
      trip_category_probs: result.answers.trip_category?.probabilities || null,
      traveler_type: result.answers.traveler_type?.choice || null,
      traveler_type_probs: result.answers.traveler_type?.probabilities || null,
      timeframe: result.answers.timeframe?.choice || null,
      tokens_used: result.usage?.input_tokens || 0
    };
  } catch (err) {
    console.error("Laya classification error:", err);
    return null;
  }
}

import "dotenv/config";
import { GoogleGenAI } from "@google/genai";

let aiInstance = null;

function getClient() {
  if (!aiInstance && process.env.GEMINI_API_KEY) {
    aiInstance = new GoogleGenAI();
  }
  return aiInstance;
}

/**
 * Extracts comprehensive structured travel entities using Gemini LLM.
 */
export async function extractWithGemini(text) {
  const ai = getClient();
  if (!ai) return null;

  const todayStr = new Date().toISOString().split("T")[0];

  const systemInstruction = `
You are an expert travel assistant data extractor.
Given a raw customer travel inquiry message (e.g. from WhatsApp), extract all relevant travel entities into a strict JSON object.
Today's reference date is: ${todayStr}.

Return ONLY valid JSON matching this schema:
{
  "origin": "string (e.g. Chennai, Bangalore)",
  "destination": "string (e.g. Ooty, Munnar, Goa, Kochin resort)",
  "start_date": "YYYY-MM-DD",
  "end_date": "YYYY-MM-DD",
  "travelers": number (integer >= 1),
  "companions": "string (e.g. Couple/Wife, Family of 3, 4 Friends, Solo)",
  "trip_type": "hill station | resort stay | beach | heritage | adventure | leisure",
  "budget_usd": number (estimate in USD, convert approx 1 USD = 85 INR if given in Rupees),
  "preferences": "string (specific interests, requests, dietary, hotel style)",
  "summary": "string (1 sentence concise summary)"
}

Do not include markdown ticks or explanations. Just pure JSON.
`;

  const models = ["gemini-3.5-flash", "gemini-3.5-flash-lite", "gemini-3-flash-preview"];
  for (const model of models) {
    try {
      const response = await ai.models.generateContent({
        model,
        contents: [
          { role: "user", parts: [{ text: `${systemInstruction}\n\nCustomer Message: "${text}"` }] }
        ]
      });

      let raw = response.text?.trim() || "";
      if (raw.startsWith("```json")) {
        raw = raw.replace(/^```json/, "").replace(/```$/, "").trim();
      } else if (raw.startsWith("```")) {
        raw = raw.replace(/^```/, "").replace(/```$/, "").trim();
      }

      const parsed = JSON.parse(raw);
      parsed._llm_model = model;
      return parsed;
    } catch (err) {
      console.warn(`Gemini model ${model} failed:`, err.message || err);
    }
  }
  return null;
}

/**
 * Chat with customer about their trip request to iterate on itinerary or preferences.
 */
export async function chatAboutTrip(trip, chatHistory, userMessage) {
  const ai = getClient();
  if (!ai) {
    return { reply: "Gemini API key is not configured.", role: "assistant" };
  }

  const systemInstruction = `
You are WanderWise, an enthusiastic, knowledgeable travel advisor.
You are chatting with a customer regarding their trip request:
- Route: ${trip.origin} to ${trip.destination}
- Dates: ${trip.start_date} to ${trip.end_date || 'Flexible'}
- Travelers: ${trip.travelers} (${trip.companions || 'Standard'})
- Category: ${trip.trip_type || 'Leisure'}
- Budget: $${trip.budget_usd || 0}
- Current Notes: ${trip.preferences || 'None'}

Provide helpful, personalized travel recommendations, suggest scenic spots, pacing, resort ideas, and ask clarifying questions to refine their custom itinerary. Keep responses warm, structured, and easy to read.
`;

  const contents = [
    { role: "user", parts: [{ text: systemInstruction }] },
    ...chatHistory.map(m => ({
      role: m.sender === "user" ? "user" : "model",
      parts: [{ text: m.message }]
    })),
    { role: "user", parts: [{ text: userMessage }] }
  ];

  const models = ["gemini-3.5-flash", "gemini-3.5-flash-lite"];
  for (const model of models) {
    try {
      const response = await ai.models.generateContent({
        model,
        contents
      });
      return { reply: response.text, role: "assistant" };
    } catch (err) {
      console.warn(`Chat model ${model} failed:`, err.message);
    }
  }

  return { reply: "I'm temporarily having trouble connecting to the travel intelligence service. Please try again shortly.", role: "assistant" };
}

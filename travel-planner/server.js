import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import db, { initDB } from "./db.js";
import { extractTripDetails } from "./parser.js";
import { chatAboutTrip } from "./gemini_service.js";
import { runTripPipeline } from "./orchestrator.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// Initialize SQLite table
initDB();

// Insert initial demo records if table is empty
const countStmt = db.prepare("SELECT COUNT(*) as count FROM trips");
const { count } = countStmt.get();
if (count === 0) {
  const samples = [
    {
      raw_message: "I want to travel from Chennai to some hill station on 24 Dec 2026 with my wife - can you suggest some ideas",
      origin: "Chennai",
      destination: "Hill Station (Ooty / Munnar)",
      start_date: "2026-12-24",
      end_date: "2026-12-27",
      travelers: 2,
      budget_usd: 500,
      trip_type: "hill station",
      companions: "Couple (Wife)",
      preferences: "Cool climate, scenic views",
      status: "pending"
    },
    {
      raw_message: "This weekend me and my family of 3 members want to visit some resort around Kochin - can you suggest",
      origin: "Chennai",
      destination: "Kochin",
      start_date: "2026-10-10",
      end_date: "2026-10-11",
      travelers: 3,
      budget_usd: 450,
      trip_type: "resort stay",
      companions: "Family of 3",
      preferences: "Weekend getaway, resort pool",
      status: "pending"
    },
    {
      raw_message: "Planning a trip from Bangalore to Goa next month for 4 friends, budget 40000",
      origin: "Bangalore",
      destination: "Goa",
      start_date: "2026-11-15",
      end_date: "2026-11-19",
      travelers: 4,
      budget_usd: 470,
      trip_type: "beach",
      companions: "4 Friends",
      preferences: "Beach parties and bike rentals",
      status: "pending"
    }
  ];
  const insertStmt = db.prepare(`
    INSERT INTO trips (
      raw_message, user_id, origin, destination, start_date, end_date,
      travelers, budget_usd, trip_type, companions, preferences, status
    ) VALUES (
      @raw_message, 'whatsapp_user', @origin, @destination, @start_date, @end_date,
      @travelers, @budget_usd, @trip_type, @companions, @preferences, @status
    )
  `);

  for (const sample of samples) {
    insertStmt.run(sample);
  }
  console.log(`Seeded ${samples.length} sample trips into SQLite`);
}

// ================= API ROUTES =================

// 1. Get all trips
app.get("/api/trips", (req, res) => {
  try {
    const { status, search } = req.query;
    let query = "SELECT * FROM trips WHERE 1=1";
    const params = [];

    if (status && status !== "all") {
      query += " AND status = ?";
      params.push(status);
    }

    if (search) {
      query += " AND (origin LIKE ? OR destination LIKE ? OR raw_message LIKE ? OR trip_type LIKE ?)";
      const pattern = `%${search}%`;
      params.push(pattern, pattern, pattern, pattern);
    }

    query += " ORDER BY id DESC";
    const trips = db.prepare(query).all(...params);
    res.json({ success: true, trips });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 2. Extract details from raw message (preview before save)
app.post("/api/extract", async (req, res) => {
  try {
    const { text } = req.body;
    if (!text || !text.trim()) {
      return res.status(400).json({ success: false, error: "Text is required" });
    }
    const extracted = await extractTripDetails(text);
    res.json({ success: true, extracted });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 3. Create trip (either directly or via WhatsApp message extraction)
app.post("/api/trips", async (req, res) => {
  try {
    let payload = req.body;
    if (payload.raw_message && (!payload.origin || !payload.destination || !payload.start_date)) {
      const extracted = await extractTripDetails(payload.raw_message);
      payload = { ...extracted, ...payload };
    }

    const insertStmt = db.prepare(`
      INSERT INTO trips (
        raw_message, user_id, origin, destination, start_date, end_date,
        travelers, budget_usd, trip_type, companions, preferences, status
      ) VALUES (
        ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?
      )
    `);

    const result = insertStmt.run(
      payload.raw_message || "",
      payload.user_id || "whatsapp_user",
      payload.origin || "Unknown",
      payload.destination || "Unknown",
      payload.start_date || new Date().toISOString().split("T")[0],
      payload.end_date || null,
      payload.travelers ? parseInt(payload.travelers, 10) : 1,
      payload.budget_usd ? parseFloat(payload.budget_usd) : 0,
      payload.trip_type || "leisure",
      payload.companions || "",
      payload.preferences || "",
      payload.status || "pending"
    );

    const newTrip = db.prepare("SELECT * FROM trips WHERE id = ?").get(result.lastInsertRowid);
    res.json({ success: true, trip: newTrip });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 4. Update trip
app.put("/api/trips/:id", (req, res) => {
  try {
    const id = req.params.id;
    const {
      origin, destination, start_date, end_date, travelers,
      budget_usd, trip_type, companions, preferences, status
    } = req.body;

    const updateStmt = db.prepare(`
      UPDATE trips SET
        origin = COALESCE(?, origin),
        destination = COALESCE(?, destination),
        start_date = COALESCE(?, start_date),
        end_date = COALESCE(?, end_date),
        travelers = COALESCE(?, travelers),
        budget_usd = COALESCE(?, budget_usd),
        trip_type = COALESCE(?, trip_type),
        companions = COALESCE(?, companions),
        preferences = COALESCE(?, preferences),
        status = COALESCE(?, status),
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `);

    updateStmt.run(
      origin, destination, start_date, end_date,
      travelers !== undefined ? parseInt(travelers, 10) : null,
      budget_usd !== undefined ? parseFloat(budget_usd) : null,
      trip_type, companions, preferences, status, id
    );

    const updated = db.prepare("SELECT * FROM trips WHERE id = ?").get(id);
    res.json({ success: true, trip: updated });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 5. Delete trip
app.delete("/api/trips/:id", (req, res) => {
  try {
    const id = req.params.id;
    db.prepare("DELETE FROM trips WHERE id = ?").run(id);
    res.json({ success: true, message: `Trip ${id} deleted` });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 6. Stats summary
app.get("/api/stats", (req, res) => {
  try {
    const total = db.prepare("SELECT COUNT(*) as count FROM trips").get().count;
    const pending = db.prepare("SELECT COUNT(*) as count FROM trips WHERE status = 'pending'").get().count;
    const running = db.prepare("SELECT COUNT(*) as count FROM trips WHERE status = 'running'").get().count;
    const completed = db.prepare("SELECT COUNT(*) as count FROM trips WHERE status = 'completed'").get().count;
    res.json({ success: true, stats: { total, pending, running, completed } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 7. Get chat messages for a trip
app.get("/api/trips/:id/chats", (req, res) => {
  try {
    const tripId = req.params.id;
    const chats = db.prepare("SELECT * FROM trip_chats WHERE trip_id = ? ORDER BY id ASC").all(tripId);
    res.json({ success: true, chats });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 8. Send chat message & get AI response
app.post("/api/trips/:id/chats", async (req, res) => {
  try {
    const tripId = req.params.id;
    const { message } = req.body;
    if (!message || !message.trim()) {
      return res.status(400).json({ success: false, error: "Message is required" });
    }

    const trip = db.prepare("SELECT * FROM trips WHERE id = ?").get(tripId);
    if (!trip) {
      return res.status(404).json({ success: false, error: "Trip not found" });
    }

    // Save user message
    const insertChat = db.prepare("INSERT INTO trip_chats (trip_id, sender, message) VALUES (?, ?, ?)");
    insertChat.run(tripId, "user", message.trim());

    // Retrieve full chat history
    const history = db.prepare("SELECT sender, message FROM trip_chats WHERE trip_id = ? ORDER BY id ASC").all(tripId);

    // Call Gemini chat
    const aiResponse = await chatAboutTrip(trip, history.slice(0, -1), message.trim());

    // Save assistant reply
    insertChat.run(tripId, "assistant", aiResponse.reply);

    const updatedChats = db.prepare("SELECT * FROM trip_chats WHERE trip_id = ? ORDER BY id ASC").all(tripId);
    res.json({ success: true, chats: updatedChats });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 9. Run Multi-Agent Orchestration Pipeline
app.post("/api/trips/:id/run", async (req, res) => {
  try {
    const tripId = req.params.id;
    const result = await runTripPipeline(tripId);
    res.json({ success: true, result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 10. Get Agent Events & Run State for a Trip (Audit Trail)
app.get("/api/trips/:id/events", (req, res) => {
  try {
    const tripId = req.params.id;
    const events = db.prepare("SELECT * FROM agent_events WHERE trip_id = ? ORDER BY step_index ASC").all(tripId);
    const runState = db.prepare("SELECT * FROM run_state WHERE trip_id = ?").get(tripId);
    const trip = db.prepare("SELECT * FROM trips WHERE id = ?").get(tripId);
    res.json({ success: true, events, run_state: runState, trip });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Travel Planning App running at http://localhost:${PORT}`);
});

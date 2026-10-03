import Database from "better-sqlite3";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DB_PATH = path.join(__dirname, "travel_planner.db");
const db = new Database(DB_PATH);

db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

export function initDB() {
  db.exec(`
    -- Core entity: trips
    CREATE TABLE IF NOT EXISTS trips (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      raw_message     TEXT,
      user_id         TEXT NOT NULL DEFAULT 'guest',
      origin          TEXT NOT NULL,
      destination     TEXT NOT NULL,
      start_date      TEXT NOT NULL,
      end_date        TEXT,
      travelers       INTEGER NOT NULL DEFAULT 1,
      budget_usd      REAL DEFAULT 0,
      trip_type       TEXT DEFAULT 'leisure',
      companions      TEXT,
      preferences     TEXT,
      status          TEXT NOT NULL DEFAULT 'pending', -- pending | running | completed | rejected | failed
      final_result    TEXT,                             -- JSON or formatted itinerary
      created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at      DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_trips_status ON trips(status);
    CREATE INDEX IF NOT EXISTS idx_trips_user ON trips(user_id);

    -- Append-only audit trail of every agent hop
    CREATE TABLE IF NOT EXISTS agent_events (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      trip_id         INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
      step_index      INTEGER NOT NULL,
      agent_name      TEXT NOT NULL,
      input_json      TEXT NOT NULL,
      output_json     TEXT NOT NULL,
      decision        TEXT NOT NULL,
      confidence      REAL,
      reasoning       TEXT,
      next_agent      TEXT,
      duration_ms     INTEGER,
      created_at      DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_events_trip ON agent_events(trip_id, step_index);

    -- Loop protection state per run
    CREATE TABLE IF NOT EXISTS run_state (
      trip_id             INTEGER PRIMARY KEY REFERENCES trips(id) ON DELETE CASCADE,
      hops_used           INTEGER NOT NULL DEFAULT 0,
      max_hops            INTEGER NOT NULL DEFAULT 12,
      alternative_tries   INTEGER NOT NULL DEFAULT 0,
      max_alternatives    INTEGER NOT NULL DEFAULT 2,
      visited_states      TEXT NOT NULL DEFAULT '[]', -- JSON array of "agent:decision"
      current_agent       TEXT,
      terminated_reason   TEXT, -- completed | rejected | loop_guard | max_hops | error
      started_at          DATETIME DEFAULT CURRENT_TIMESTAMP,
      finished_at         DATETIME
    );

    -- Interactive trip chats
    CREATE TABLE IF NOT EXISTS trip_chats (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      trip_id         INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
      sender          TEXT NOT NULL, -- 'user' | 'assistant'
      message         TEXT NOT NULL,
      created_at      DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_chats_trip ON trip_chats(trip_id);

    -- Reference / mock data tables
    CREATE TABLE IF NOT EXISTS dest_costs (
      destination     TEXT PRIMARY KEY,
      daily_cost_usd  REAL NOT NULL,
      peak_months     TEXT,   -- JSON array like ["Jun","Jul","Dec"]
      notes           TEXT
    );

    CREATE TABLE IF NOT EXISTS visa_rules (
      destination     TEXT NOT NULL,
      origin          TEXT NOT NULL,
      requirement     TEXT NOT NULL,   -- visa_free | e_visa | visa_required | blocked
      processing_days INTEGER,
      notes           TEXT,
      PRIMARY KEY (destination, origin)
    );

    CREATE TABLE IF NOT EXISTS weather_profile (
      destination     TEXT NOT NULL,
      month           INTEGER NOT NULL, -- 1..12
      suitability     TEXT NOT NULL,    -- good | ok | bad
      avg_temp_c      REAL,
      notes           TEXT,
      PRIMARY KEY (destination, month)
    );

    CREATE TABLE IF NOT EXISTS mock_flights (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      origin          TEXT NOT NULL,
      destination     TEXT NOT NULL,
      depart_date     TEXT NOT NULL,
      price_usd       REAL NOT NULL,
      airline         TEXT,
      duration_hrs    REAL
    );

    CREATE TABLE IF NOT EXISTS mock_hotels (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      destination     TEXT NOT NULL,
      check_in        TEXT NOT NULL,
      nightly_usd     REAL NOT NULL,
      name            TEXT,
      rating          REAL
    );
  `);

  seedReferenceData();
  console.log("Database initialized with full multi-agent tables at", DB_PATH);
}

function seedReferenceData() {
  // 1. dest_costs
  const costCount = db.prepare("SELECT COUNT(*) as count FROM dest_costs").get().count;
  if (costCount === 0) {
    const insertCost = db.prepare("INSERT INTO dest_costs (destination, daily_cost_usd, peak_months, notes) VALUES (?, ?, ?, ?)");
    insertCost.run("Ooty", 60, JSON.stringify(["Apr", "May", "Dec"]), "Queen of hill stations, Nilgiris");
    insertCost.run("Munnar", 55, JSON.stringify(["Sep", "Oct", "Nov", "Dec"]), "Tea gardens and mist");
    insertCost.run("Kodaikanal", 50, JSON.stringify(["Apr", "May", "Jun", "Dec"]), "Scenic lakes and valleys");
    insertCost.run("Kochin", 65, JSON.stringify(["Nov", "Dec", "Jan"]), "Coastal backwaters and luxury resorts");
    insertCost.run("Goa", 80, JSON.stringify(["Nov", "Dec", "Jan", "Feb"]), "Beaches, resorts, and nightlife");
    insertCost.run("Manali", 70, JSON.stringify(["May", "Jun", "Dec", "Jan"]), "Snow valleys and Himalayan treks");
    insertCost.run("Dubai", 180, JSON.stringify(["Nov", "Dec", "Jan"]), "Luxury city and desert safari");
    insertCost.run("Paris", 220, JSON.stringify(["Jun", "Jul", "Aug"]), "European art and culture");
  }

  // 2. visa_rules (defaults for domestic and common international routes)
  const visaCount = db.prepare("SELECT COUNT(*) as count FROM visa_rules").get().count;
  if (visaCount === 0) {
    const insertVisa = db.prepare("INSERT INTO visa_rules (destination, origin, requirement, processing_days, notes) VALUES (?, ?, ?, ?, ?)");
    // Domestic routes (always free)
    insertVisa.run("Ooty", "Chennai", "visa_free", 0, "Domestic travel within India");
    insertVisa.run("Munnar", "Chennai", "visa_free", 0, "Domestic travel within India");
    insertVisa.run("Kodaikanal", "Chennai", "visa_free", 0, "Domestic travel within India");
    insertVisa.run("Kochin", "Chennai", "visa_free", 0, "Domestic travel within India");
    insertVisa.run("Goa", "Bangalore", "visa_free", 0, "Domestic travel within India");
    insertVisa.run("Manali", "Delhi", "visa_free", 0, "Domestic travel within India");
    // International
    insertVisa.run("Dubai", "Chennai", "e_visa", 3, "Tourist e-visa available online");
    insertVisa.run("Paris", "Chennai", "visa_required", 15, "Schengen visa required in advance");
    insertVisa.run("North Korea", "Chennai", "blocked", 0, "Travel restricted / blocked");
  }

  // 3. weather_profile
  const weatherCount = db.prepare("SELECT COUNT(*) as count FROM weather_profile").get().count;
  if (weatherCount === 0) {
    const insertWeather = db.prepare("INSERT INTO weather_profile (destination, month, suitability, avg_temp_c, notes) VALUES (?, ?, ?, ?, ?)");
    const spots = ["Ooty", "Munnar", "Kodaikanal", "Kochin", "Goa", "Manali"];
    for (const spot of spots) {
      for (let m = 1; m <= 12; m++) {
        let suitability = "good";
        let temp = 20;
        let notes = "Pleasant weather";

        // Monsoon heavy rain in Kerala/Goa during Jun/Jul/Aug
        if ((spot === "Munnar" || spot === "Kochin" || spot === "Goa") && (m === 6 || m === 7 || m === 8)) {
          suitability = "bad";
          temp = 25;
          notes = "Heavy monsoon rainfall and high humidity";
        } else if (spot === "Manali" && (m === 7 || m === 8)) {
          suitability = "bad";
          temp = 22;
          notes = "Landslide warnings during monsoon";
        } else if (m === 12 || m === 1) {
          suitability = "good";
          temp = spot === "Manali" ? 2 : (spot === "Ooty" || spot === "Munnar" ? 12 : 26);
          notes = "Crisp cool winter season";
        }

        insertWeather.run(spot, m, suitability, temp, notes);
      }
    }
  }

  // 4. mock_flights
  const flightCount = db.prepare("SELECT COUNT(*) as count FROM mock_flights").get().count;
  if (flightCount === 0) {
    const insertFlight = db.prepare("INSERT INTO mock_flights (origin, destination, depart_date, price_usd, airline, duration_hrs) VALUES (?, ?, ?, ?, ?, ?)");
    insertFlight.run("Chennai", "Kochin", "2026-10-10", 65, "IndiGo 6E-241", 1.2);
    insertFlight.run("Chennai", "Coimbatore", "2026-12-24", 45, "Air India Express AIX-112", 0.9);
    insertFlight.run("Bangalore", "Goa", "2026-11-15", 50, "Akasa Air QP-1382", 1.1);
    insertFlight.run("Delhi", "Kullu", "2026-11-15", 95, "Alliance Air 9I-805", 1.3);
    insertFlight.run("Chennai", "Dubai", "2026-12-20", 180, "Emirates EK-543", 4.2);
  }

  // 5. mock_hotels
  const hotelCount = db.prepare("SELECT COUNT(*) as count FROM mock_hotels").get().count;
  if (hotelCount === 0) {
    const insertHotel = db.prepare("INSERT INTO mock_hotels (destination, check_in, nightly_usd, name, rating) VALUES (?, ?, ?, ?, ?)");
    insertHotel.run("Ooty", "2026-12-24", 75, "Sherlock Heritage Resort", 4.6);
    insertHotel.run("Ooty", "2026-12-24", 55, "Sterling Ooty Elk Hill", 4.3);
    insertHotel.run("Munnar", "2026-12-24", 65, "Tea Valley Resort & Spa", 4.5);
    insertHotel.run("Kochin", "2026-10-10", 85, "Brunton Boatyard / CGH Earth", 4.7);
    insertHotel.run("Kochin", "2026-10-10", 45, "Grand Hyatt Bolgatty Club", 4.5);
    insertHotel.run("Goa", "2026-11-15", 60, "W Goa Beachfront", 4.6);
    insertHotel.run("Manali", "2026-11-15", 50, "Solang Valley Apple Resort", 4.4);
  }
}

export default db;

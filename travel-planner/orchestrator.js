import db from "./db.js";
import { AGENTS } from "./agents.js";

/**
 * Transition Table (Deterministic Workflow from basic_idea.txt Section 5)
 */
export const ROUTING = {
  "IntakeAgent:valid": "BudgetAgent",
  "IntakeAgent:needs_info": "RejectAgent", // Will mark trip as awaiting clarification
  "IntakeAgent:invalid": "RejectAgent",

  "BudgetAgent:ok": "VisaAgent",
  "BudgetAgent:tight": "AlternativeAgent",
  "BudgetAgent:impossible": "RejectAgent",

  "VisaAgent:ok": "WeatherAgent",
  "VisaAgent:blocked": "AlternativeAgent",

  "WeatherAgent:good": "FlightAgent",
  "WeatherAgent:bad": "AlternativeAgent",

  "AlternativeAgent:retry": "BudgetAgent",
  "AlternativeAgent:give_up": "RejectAgent",

  "FlightAgent:found": "HotelAgent",
  "FlightAgent:none": "AlternativeAgent",

  "HotelAgent:found": "ItineraryAgent",
  "HotelAgent:none": "AlternativeAgent",

  "ItineraryAgent:complete": "__END__",
  "RejectAgent:rejected": "__END__"
};

/**
 * Initializes or resets run_state row for a trip run
 */
function initRunState(tripId) {
  db.prepare("DELETE FROM run_state WHERE trip_id = ?").run(tripId);
  db.prepare("DELETE FROM agent_events WHERE trip_id = ?").run(tripId);

  db.prepare(`
    INSERT INTO run_state (
      trip_id, hops_used, max_hops, alternative_tries, max_alternatives,
      visited_states, current_agent, started_at
    ) VALUES (
      ?, 0, 12, 0, 2, '[]', 'IntakeAgent', CURRENT_TIMESTAMP
    )
  `).run(tripId);

  return db.prepare("SELECT * FROM run_state WHERE trip_id = ?").get(tripId);
}

/**
 * Executes the entire multi-agent pipeline for a trip
 */
export async function runTripPipeline(tripId) {
  const trip = db.prepare("SELECT * FROM trips WHERE id = ?").get(tripId);
  if (!trip) {
    throw new Error(`Trip ${tripId} not found`);
  }

  // Set trip status to running
  db.prepare("UPDATE trips SET status = 'running' WHERE id = ?").run(tripId);

  const state = initRunState(tripId);
  state.visited_states = JSON.parse(state.visited_states || "[]");

  let current = "IntakeAgent";
  let step = 0;
  let terminatedReason = "completed";
  let finalResultPayload = null;

  while (current !== "__END__") {
    // === LOOP & SAFETY GUARDS ===
    // 1. Max hops guard
    if (state.hops_used >= state.max_hops) {
      terminatedReason = "max_hops";
      console.warn(`[Trip ${tripId}] Terminated: max hops (${state.max_hops}) exceeded.`);
      break;
    }

    const agentFn = AGENTS[current];
    if (!agentFn) {
      terminatedReason = "error";
      console.error(`[Trip ${tripId}] Unknown agent: ${current}`);
      break;
    }

    const t0 = Date.now();
    let output;
    try {
      output = await agentFn(trip, state);
    } catch (err) {
      console.error(`[Trip ${tripId}] Error in ${current}:`, err);
      output = {
        decision: "error",
        confidence: 0,
        reasoning: `Exception: ${err.message}`,
        payload: { stack: err.stack }
      };
      terminatedReason = "error";
    }
    const durationMs = Date.now() - t0;

    // State key includes alternative try attempt number so re-evaluating Budget after a destination shift is allowed
    const stateKey = `${current}:${output.decision}:try${state.alternative_tries || 0}`;

    // 2. Loop detection guard (prevent identical decision within the same attempt)
    if (state.visited_states.includes(stateKey)) {
      terminatedReason = "loop_guard";
      console.warn(`[Trip ${tripId}] Loop detected: state ${stateKey} already visited.`);
      break;
    }

    // 3. Alternative counter guard
    if (current === "AlternativeAgent" && output.decision === "retry") {
      state.alternative_tries = (state.alternative_tries || 0) + 1;
      if (state.alternative_tries > state.max_alternatives) {
        output.decision = "give_up";
        output.reasoning = `Maximum alternative attempts (${state.max_alternatives}) exhausted.`;
      }
    }

    // Record last reasoning for reject agent context
    state.last_reasoning = output.reasoning;

    // Determine next agent from ROUTING table
    const routeKey = `${current}:${output.decision}`;
    let nextAgent = ROUTING[routeKey] || "__END__";

    // Write to agent_events table
    db.prepare(`
      INSERT INTO agent_events (
        trip_id, step_index, agent_name, input_json, output_json,
        decision, confidence, reasoning, next_agent, duration_ms
      ) VALUES (
        ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?
      )
    `).run(
      tripId,
      step,
      current,
      JSON.stringify({ origin: trip.origin, destination: trip.destination, travelers: trip.travelers, budget: trip.budget_usd }),
      JSON.stringify(output.payload || {}),
      output.decision,
      output.confidence || 1.0,
      output.reasoning || "",
      nextAgent,
      durationMs
    );

    // Save final payload if completed or rejected
    if (current === "ItineraryAgent" && output.decision === "complete") {
      finalResultPayload = output.payload;
    } else if (current === "RejectAgent" && output.decision === "rejected") {
      finalResultPayload = output.payload;
      terminatedReason = "rejected";
    }

    // Update state counters
    state.hops_used += 1;
    state.visited_states.push(stateKey);
    state.current_agent = nextAgent;

    // If AlternativeAgent negotiated new destination or dates, persist back to trip record
    if (current === "AlternativeAgent" && output.decision === "retry") {
      db.prepare(`
        UPDATE trips SET
          destination = ?,
          start_date = ?
        WHERE id = ?
      `).run(trip.destination, trip.start_date, tripId);
    }

    db.prepare(`
      UPDATE run_state SET
        hops_used = ?,
        alternative_tries = ?,
        visited_states = ?,
        current_agent = ?
      WHERE trip_id = ?
    `).run(
      state.hops_used,
      state.alternative_tries,
      JSON.stringify(state.visited_states),
      nextAgent,
      tripId
    );

    current = nextAgent;
    step += 1;
  }

  // Finalize trip status
  let finalStatus = terminatedReason === "completed" ? "completed" : "rejected";
  if (state.last_reasoning && state.last_reasoning.includes("Missing:")) {
    finalStatus = "needs_info";
  }

  db.prepare(`
    UPDATE run_state SET
      terminated_reason = ?,
      finished_at = CURRENT_TIMESTAMP
    WHERE trip_id = ?
  `).run(terminatedReason, tripId);

  db.prepare(`
    UPDATE trips SET
      status = ?,
      final_result = ?,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(
    finalStatus,
    finalResultPayload ? JSON.stringify(finalResultPayload) : null,
    tripId
  );

  return {
    trip_id: tripId,
    status: finalStatus,
    terminated_reason: terminatedReason,
    hops_used: state.hops_used,
    events: db.prepare("SELECT * FROM agent_events WHERE trip_id = ? ORDER BY step_index ASC").all(tripId)
  };
}

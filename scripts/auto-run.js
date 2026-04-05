#!/usr/bin/env node
// Autonomous mode — agents take tasks from kanban without CEO input
// Usage: node scripts/auto-run.js
// Or schedule: every N hours via cron / pm2 cron_restart

const WebSocket = require("ws");

const ws = new WebSocket("ws://localhost:18789");
const reqId = "auto-" + Date.now();

console.log("[auto] Starting autonomous run — reading kanban...\n");

let connected = false;
let done = false;

ws.on("open", () => {
  ws.send(JSON.stringify({ type: "req", id: "connect-1", method: "connect", params: {} }));
});

ws.on("message", (raw) => {
  const msg = JSON.parse(raw.toString());

  if (!connected) {
    if (msg.type === "event" && msg.event === "connect.challenge") return;
    if (msg.type === "res" && msg.id === "connect-1") {
      connected = true;
      ws.send(JSON.stringify({ type: "req", id: reqId, method: "swarm.auto", params: {} }));
      return;
    }
    return;
  }

  if (msg.type === "res" && msg.id === reqId) {
    if (!msg.ok) { console.error("[auto] error:", msg.error); process.exit(1); }
    const tasks = msg.payload?.tasks || [];
    if (tasks.length === 0) {
      console.log("[auto] Канбан пустой. Агенты отдыхают.");
      ws.close(); process.exit(0);
    }
    console.log(`[auto] Tasks picked up: ${tasks.join(", ")}\n`);
    return;
  }

  if (msg.type === "event" && msg.event === "swarm") {
    const p = msg.payload;
    if (p.state === "auto_started") {
      console.log(`[auto] Running tasks: ${p.tasks.join(", ")}`);
    } else if (p.state === "agent_started") {
      console.log(`\n[${p.agentName}] → ${p.taskId} — working...`);
    } else if (p.state === "agent_done") {
      console.log(`[${p.agentName}] ✅ ${p.taskId}`);
    } else if (p.state === "done") {
      console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
      console.log("AUTONOMOUS RUN COMPLETE");
      console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
      for (const r of (p.results || [])) {
        console.log(`\n[${r.taskId}] ${r.agent}:`);
        if (r.error) console.log(`  ERROR: ${r.error}`);
        else console.log(r.result?.slice(0, 500) + (r.result?.length > 500 ? "..." : ""));
      }
      console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
      done = true;
      ws.close();
      process.exit(0);
    }
  }
});

ws.on("close", () => { if (!done) process.exit(1); });
ws.on("error", (e) => { console.error("[auto] ws error:", e.message); process.exit(1); });

setTimeout(() => {
  console.error("[auto] timeout after 300s");
  process.exit(1);
}, 300_000);

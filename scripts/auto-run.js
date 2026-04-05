#!/usr/bin/env node
// Autonomous mode — agents audit their domains 24/7, no CEO needed
// Usage: node scripts/auto-run.js
// Schedule: pm2 cron or `setInterval` in ecosystem.config.js

const WebSocket = require("ws");

const GW_URL = process.env.ZEUS_GATEWAY_URL || "ws://localhost:18789";
const ws = new WebSocket(GW_URL);

console.log(`[auto] Connecting to ${GW_URL}...`);

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
      console.log("[auto] Connected. Launching autonomous audit...\n");
      ws.send(JSON.stringify({ type: "req", id: "auto-1", method: "swarm.auto", params: {} }));
      return;
    }
    return;
  }

  if (msg.type === "res" && msg.id === "auto-1") {
    if (!msg.ok) { console.error("[auto] error:", msg.error); process.exit(1); }
    return;
  }

  if (msg.type === "event" && msg.event === "swarm") {
    const p = msg.payload;
    if (p.state === "auto_started") {
      console.log(`[auto] Squad: ${p.agents.join(", ")}\n`);
    } else if (p.state === "agent_started") {
      process.stdout.write(`[${p.agentName}] auditing...\n`);
    } else if (p.state === "agent_done") {
      process.stdout.write(`[${p.agentName}] ✅ findings saved\n`);
    } else if (p.state === "done") {
      console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
      console.log("AUTONOMOUS AUDIT COMPLETE");
      console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
      for (const r of (p.results || [])) {
        console.log(`\n▶ ${r.agent || r.agentId}`);
        if (r.error) {
          console.log(`  ERROR: ${r.error}`);
        } else {
          // Show first 600 chars of each agent's findings
          const preview = (r.result || "").slice(0, 600);
          console.log(preview + (r.result?.length > 600 ? "\n  ..." : ""));
        }
      }
      console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
      console.log("Full findings: memory/agent-findings/");
      done = true;
      ws.close();
      process.exit(0);
    }
  }
});

ws.on("close", () => { if (!done) { console.error("[auto] disconnected"); process.exit(1); } });
ws.on("error", (e) => { console.error("[auto] error:", e.message); process.exit(1); });

setTimeout(() => {
  console.error("[auto] timeout after 300s");
  process.exit(1);
}, 300_000);

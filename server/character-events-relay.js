"use strict";

/**
 * character-events-relay — VOLAURA ecosystem bridge
 *
 * Subscribes to VOLAURA Supabase Realtime → character_events table.
 * Exposes a WebSocket server for Life Simulator (Godot / Three.js) clients.
 * Broadcasts character events in real-time to all connected game clients.
 *
 * Start: node server/character-events-relay.js
 * Port:  RELAY_PORT env var (default 18790)
 *
 * Required env:
 *   VOLAURA_SUPABASE_URL   — https://dwdgzfusjsobnixgyzjk.supabase.co
 *   VOLAURA_ANON_KEY       — VOLAURA project anon/service key
 *
 * Optional env:
 *   RELAY_PORT             — WebSocket port for Life Simulator clients (default 18790)
 *   RELAY_SECRET           — HMAC secret for client auth (optional)
 *   DAILY_DIGEST           — "false" to disable daily log (default true)
 */

const http    = require("http");
const WebSocket = require("ws");
const crypto  = require("crypto");

const RELAY_PORT   = parseInt(process.env.RELAY_PORT || "18790", 10);
const VOL_URL      = process.env.VOLAURA_SUPABASE_URL || "https://dwdgzfusjsobnixgyzjk.supabase.co";
const VOL_KEY      = process.env.VOLAURA_ANON_KEY || process.env.VOLAURA_SERVICE_KEY || "";
const RELAY_SECRET = process.env.RELAY_SECRET || "";

// ── Connected Life Simulator clients ──────────────────────────────────────────
/** @type {Set<WebSocket>} */
const lifesimClients = new Set();

// ── Supabase Realtime via Phoenix WebSocket protocol ─────────────────────────
//
// Supabase Realtime is built on Phoenix channels (Elixir).
// Protocol: wss://{project}.supabase.co/realtime/v1/websocket?apikey=...&vsn=1.0.0
// Messages are Phoenix frames: { topic, event, payload, ref }
//

let realtimeWs = null;
let heartbeatInterval = null;
let realtimeRef = 0;
let reconnectTimer = null;

function nextRef() { return String(++realtimeRef); }

function connectRealtime() {
  if (!VOL_KEY) {
    console.warn("[relay] VOLAURA_ANON_KEY not set — Supabase Realtime disabled");
    return;
  }

  const wsUrl = `${VOL_URL.replace("https://", "wss://").replace("http://", "ws://")}/realtime/v1/websocket?apikey=${VOL_KEY}&vsn=1.0.0`;

  console.log(`[relay] Connecting to Supabase Realtime…`);
  realtimeWs = new WebSocket(wsUrl);

  realtimeWs.on("open", () => {
    console.log("[relay] Supabase Realtime connected");

    // Join the character_events channel (listen to INSERT events)
    const joinMsg = JSON.stringify({
      topic: "realtime:public:character_events",
      event: "phx_join",
      payload: {
        config: {
          broadcast: { self: false },
          presence: { key: "" },
          postgres_changes: [
            { event: "INSERT", schema: "public", table: "character_events" },
          ],
        },
      },
      ref: nextRef(),
    });
    realtimeWs.send(joinMsg);

    // Heartbeat every 25s (Supabase closes idle connections after 60s)
    heartbeatInterval = setInterval(() => {
      if (realtimeWs?.readyState === WebSocket.OPEN) {
        realtimeWs.send(JSON.stringify({ topic: "phoenix", event: "heartbeat", payload: {}, ref: nextRef() }));
      }
    }, 25_000);
  });

  realtimeWs.on("message", (raw) => {
    let frame;
    try { frame = JSON.parse(raw.toString()); }
    catch { return; }

    const { topic, event, payload } = frame;

    // Supabase Realtime sends postgres_changes events under "postgres_changes" event type
    // OR directly under event names like "INSERT"
    if (
      topic === "realtime:public:character_events" &&
      (event === "postgres_changes" || event === "INSERT")
    ) {
      const record = payload?.data?.record ?? payload?.record ?? payload;
      if (record && record.event_type) {
        handleCharacterEvent(record);
      }
    }

    // Supabase v2 wraps in postgres_changes with data.record
    if (event === "system" && payload?.status === "ok") {
      console.log(`[relay] Channel joined: ${topic}`);
    }
  });

  realtimeWs.on("close", (code, reason) => {
    console.log(`[relay] Supabase Realtime disconnected (${code}). Reconnecting in 5s…`);
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
    reconnectTimer = setTimeout(connectRealtime, 5_000);
  });

  realtimeWs.on("error", (err) => {
    console.error("[relay] Supabase Realtime error:", err.message);
    // close handler will reconnect
  });
}

// ── Handle incoming character event → broadcast to Life Simulator ─────────────
function handleCharacterEvent(record) {
  const msg = JSON.stringify({
    type: "character_event",
    event_type: record.event_type,
    user_id: record.user_id,
    source_product: record.source_product,
    payload: record.payload,
    xp: record.xp_delta,
    crystals: record.crystal_delta,
    created_at: record.created_at,
  });

  let delivered = 0;
  for (const client of lifesimClients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg);
      delivered++;
    }
  }

  console.log(
    `[relay] ${record.event_type} (${record.source_product}) → ${delivered} Life Sim clients | xp=${record.xp_delta ?? 0} crystals=${record.crystal_delta ?? 0}`
  );
}

// ── Life Simulator WebSocket server ──────────────────────────────────────────
const httpServer = http.createServer((req, res) => {
  // Health check
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      status: "ok",
      clients: lifesimClients.size,
      realtime: realtimeWs?.readyState === WebSocket.OPEN ? "connected" : "disconnected",
    }));
    return;
  }
  res.writeHead(404);
  res.end();
});

const wss = new WebSocket.Server({ server: httpServer });

wss.on("connection", (ws, req) => {
  // Optional HMAC auth: client sends ?token=<hmac-sha256(timestamp)>
  if (RELAY_SECRET) {
    const url = new URL(req.url, `http://localhost`);
    const token = url.searchParams.get("token");
    const ts    = url.searchParams.get("ts");
    if (!token || !ts || !verifyToken(ts, token)) {
      ws.close(4001, "Unauthorized");
      return;
    }
  }

  lifesimClients.add(ws);
  console.log(`[relay] Life Sim client connected. Total: ${lifesimClients.size}`);

  // Send welcome with current relay state
  ws.send(JSON.stringify({
    type: "relay_ready",
    clients: lifesimClients.size,
    realtime: realtimeWs?.readyState === WebSocket.OPEN ? "connected" : "disconnected",
  }));

  ws.on("message", (raw) => {
    // Clients can send commands (reserved for future use)
    let msg;
    try { msg = JSON.parse(raw.toString()); }
    catch { return; }
    console.log(`[relay] Client message: ${msg.type || "unknown"}`);
  });

  ws.on("close", () => {
    lifesimClients.delete(ws);
    console.log(`[relay] Life Sim client disconnected. Total: ${lifesimClients.size}`);
  });

  ws.on("error", () => lifesimClients.delete(ws));
});

// ── HMAC token verification ───────────────────────────────────────────────────
function verifyToken(ts, token) {
  // Token is valid for ±60 seconds
  const now = Math.floor(Date.now() / 1000);
  const tsNum = parseInt(ts, 10);
  if (Math.abs(now - tsNum) > 60) return false;

  const expected = crypto
    .createHmac("sha256", RELAY_SECRET)
    .update(ts)
    .digest("hex");
  try {
    return crypto.timingSafeEqual(Buffer.from(token, "hex"), Buffer.from(expected, "hex"));
  } catch { return false; }
}

// ── Start ─────────────────────────────────────────────────────────────────────
httpServer.listen(RELAY_PORT, "0.0.0.0", () => {
  console.log(`[relay] Character Events Relay — ws://localhost:${RELAY_PORT}`);
  console.log(`[relay] Health: http://localhost:${RELAY_PORT}/health`);
  console.log(`[relay] Waiting for Life Simulator clients…`);
  connectRealtime();
});

// Graceful shutdown
process.on("SIGTERM", () => {
  console.log("[relay] SIGTERM — shutting down");
  clearInterval(heartbeatInterval);
  clearTimeout(reconnectTimer);
  if (realtimeWs) realtimeWs.close();
  httpServer.close(() => process.exit(0));
});

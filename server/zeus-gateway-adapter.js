"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const { randomUUID, createHmac, timingSafeEqual } = require("crypto");
const { WebSocketServer } = require("ws");
const Anthropic = require("@anthropic-ai/sdk");
const { webSearch, researchBeforeTask, pickTopResearchQuestions } = require("./research-module");

// PORT is set by Railway/Heroku/etc; ZEUS_ADAPTER_PORT for local override; 18789 default
const ADAPTER_PORT = parseInt(process.env.PORT || process.env.ZEUS_ADAPTER_PORT || "18789", 10);
const MAIN_KEY = "main";

// ─── LLM provider config ───────────────────────────────────────────────────────
//
// Model routing by agent capability tier:
//
//  LOCAL  (Ollama, free, instant)   — qwen3:8b
//    Fast process agents: devops, qa, technical-writer, readiness, needs
//
//  NVIDIA-REASONING (DeepSeek R1)   — rigorous, finds edge cases
//    Security, architecture, risk — anything where missing something is expensive
//
//  NVIDIA-FAST (Llama 3.3 70B)      — smart generalist
//    Product, growth, analytics, finance, UX — pattern + strategy work
//
//  NVIDIA-MULTILINGUAL (Mistral Large) — RU/EN/AZ cultural nuance
//    Cultural strategist, LinkedIn, PR, communications
//
//  NVIDIA-SYNTHESIS (Nemotron 253B) — largest, /swarm synthesis only
//    Cross-agent synthesis, investor pitch, CEO reports
//
//  ANTHROPIC (Haiku)                — last resort if NVIDIA down
//
const OLLAMA_URL   = process.env.OLLAMA_URL   || "http://localhost:11434";
const NVIDIA_URL   = "https://integrate.api.nvidia.com/v1";
const NVIDIA_API_KEY = process.env.NVIDIA_API_KEY || "";

// Local Gemma 4 — Google's model, installed via Ollama on user's PC.
// Used as primary for "fast" agents so NVIDIA rate limits don't block all 37 agents.
const GEMMA4_MODEL = process.env.GEMMA4_MODEL || "gemma4:latest";

// Cerebras — wafer-scale silicon, 2000+ tokens/sec, OpenAI-compatible API.
// Fastest inference provider available. Used as primary for all strategy agents.
const CEREBRAS_URL     = "https://api.cerebras.ai/v1";
const CEREBRAS_API_KEY = process.env.CEREBRAS_API_KEY || "";
const CEREBRAS_MODELS = {
  fast:  "qwen-3-235b-a22b-instruct-2507", // Qwen 3 235B — largest, best quality
  small: "llama3.1-8b",                    // 8B — fast for simple tasks
};

// Keys for each NVIDIA model
const NIM = {
  fast:          "meta/llama-3.3-70b-instruct",
  reasoning:     "deepseek-ai/deepseek-r1-distill-llama-8b",
  multilingual:  "mistralai/mistral-large-2-instruct",
  synthesis:     "nvidia/llama-3.1-nemotron-ultra-253b-v1",
};

// ─── User memory system ───────────────────────────────────────────────────────
//
// Each user gets memory/users/{userId}.md
// Agents read it before answering (lightweight — max 800 chars injected).
// Agents update it after answering (async — never blocks response).
// Max file size: 4KB. Older observations rotate out automatically.
//
const USER_MEMORY_DIR = path.join(__dirname, "..", "memory", "users");
const USER_MEMORY_MAX_BYTES = 4096;

function getUserMemoryPath(userId) {
  // Sanitize userId — only alphanum, dash, underscore
  const safe = (userId || "anonymous").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
  return path.join(USER_MEMORY_DIR, `${safe}.md`);
}

function readUserMemory(userId) {
  try {
    const content = fs.readFileSync(getUserMemoryPath(userId), "utf8");
    return content.slice(0, USER_MEMORY_MAX_BYTES); // inject at most 800 chars
  } catch { return null; }
}

function writeUserMemory(userId, content) {
  try {
    fs.mkdirSync(USER_MEMORY_DIR, { recursive: true });
    // Rotate: keep last 3KB if file too large
    let existing = "";
    try { existing = fs.readFileSync(getUserMemoryPath(userId), "utf8"); } catch {}
    const combined = content;
    const trimmed = combined.length > USER_MEMORY_MAX_BYTES
      ? combined.slice(-USER_MEMORY_MAX_BYTES)
      : combined;
    fs.writeFileSync(getUserMemoryPath(userId), trimmed);
  } catch {}
}

// Extract userId from sessionKey (format: "main:agentId:userId" or just "sessionKey")
function userIdFromSession(sessionKey) {
  const parts = (sessionKey || "").split(":");
  return parts.length >= 3 ? parts[2] : parts[0] || "anonymous";
}

// Inject user memory into prompt (small — max 800 chars)
function injectUserMemory(userId, prompt) {
  const mem = readUserMemory(userId);
  if (!mem || mem.length < 20) return prompt;
  return `# Что я знаю об этом пользователе\n\`\`\`\n${mem.slice(0, 800)}\n\`\`\`\n\n---\n\n${prompt}`;
}

// Update user memory after response — async, never blocks
async function updateUserMemory(agent, userId, userMessage, agentReply) {
  if (!userId || userId === "anonymous") return;
  const existing = readUserMemory(userId) || "";
  const now = new Date().toISOString().slice(0, 16);
  const hour = new Date().getHours();

  // Build observation prompt — tiny, cheap
  const observePrompt = `Ты видишь короткий обмен с пользователем. Обнови его профиль — 3-5 строк, только новое что узнал.

Текущий профиль:
\`\`\`
${existing.slice(0, 600)}
\`\`\`

Сообщение пользователя: "${userMessage.slice(0, 300)}"
Твой ответ был о: "${agentReply.slice(0, 200)}"
Время: ${hour}:00

Напиши ТОЛЬКО обновлённый профиль. Формат:
## Паттерны общения
- (коротко, конкретно)
## Что знает / умеет
- (домен, уровень)
## Предпочтения
- (стиль ответов, что раздражает, что нравится)
## Активность
- Час: ${hour} | Агент: ${agent.id}

Не пересказывай разговор. Только наблюдения о человеке.`;

  try {
    // Use cheapest/fastest model for memory updates — llama3.1-8b on Cerebras
    const resp = await fetch(`${CEREBRAS_URL}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${CEREBRAS_API_KEY}` },
      body: JSON.stringify({
        model: CEREBRAS_MODELS.small,
        messages: [{ role: "user", content: observePrompt }],
        max_completion_tokens: 300,
        temperature: 0.3,
        stream: false,
      }),
    });
    if (!resp.ok) return;
    const data = await resp.json();
    const updated = data.choices?.[0]?.message?.content?.trim();
    if (updated && updated.length > 30) {
      writeUserMemory(userId, `# Профиль пользователя\n*Обновлено: ${now} агентом ${agent.id}*\n\n${updated}`);
    }
  } catch { /* memory update is best-effort */ }
}

// ─── Debriefer — writes session summary after each conversation ───────────────
async function debriefSession(agentId, sessionKey, userId, history) {
  if (history.length < 4) return; // not worth debriefing short chats
  const debriefDir = path.join(__dirname, "..", "memory", "debriefs");
  const date = new Date().toISOString().slice(0, 10);
  const debriefPath = path.join(debriefDir, `${date}-${sessionKey.replace(/[:/]/g, "-")}.md`);

  // Don't re-debrief same session
  try { if (fs.existsSync(debriefPath)) return; } catch {}

  const transcript = history.slice(-10).map(m => `${m.role}: ${m.content.slice(0, 300)}`).join("\n");

  try {
    const resp = await fetch(`${CEREBRAS_URL}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${CEREBRAS_API_KEY}` },
      body: JSON.stringify({
        model: CEREBRAS_MODELS.small,
        messages: [{ role: "user", content: `Сессия с агентом ${agentId}. Напиши дебриф в 5 строк:\n1. Что решили\n2. Что сделали\n3. Что осталось открытым\n4. Что нужно CEO\n5. Следующий шаг\n\nТранскрипт:\n${transcript}` }],
        max_completion_tokens: 250,
        temperature: 0.2,
        stream: false,
      }),
    });
    if (!resp.ok) return;
    const data = await resp.json();
    const debrief = data.choices?.[0]?.message?.content?.trim();
    if (debrief && debrief.length > 30) {
      fs.mkdirSync(debriefDir, { recursive: true });
      fs.writeFileSync(debriefPath, `# Дебриф сессии: ${sessionKey}\n**Агент:** ${agentId}\n**Дата:** ${date}\n**Пользователь:** ${userId}\n\n${debrief}`);
    }
  } catch {}
}

// ─── Drift detector — notices when decisions contradict past ones ─────────────
function checkContextAge(agentId) {
  // Returns warning string if shared context hasn't been updated in 7+ days
  const ctxPath = path.join(__dirname, "..", "memory", "session-context.md");
  try {
    const stat = fs.statSync(ctxPath);
    const ageDays = (Date.now() - stat.mtimeMs) / (1000 * 60 * 60 * 24);
    if (ageDays > 7) {
      return `⚠️ Мой контекст о проекте не обновлялся ${Math.floor(ageDays)} дней. Некоторые мои знания могут быть устаревшими. Если что-то противоречит реальности — скажи, я обновлюсь.`;
    }
  } catch {}
  return null;
}

// ─── Event-driven agent system ────────────────────────────────────────────────
//
// Agents wake on real events from Railway, GitHub, Sentry.
// Idle between events — no cron, no wasted tokens.
//
// Event schema:
//   { source, event, domain, severity, payload }
//   source:   "github" | "sentry" | "railway" | "internal"
//   domain:   "security" | "infra" | "product" | "qa" | "architecture" | "*"
//   severity: "P0" | "P1" | "P2" | "info"
//
// Webhook secrets (HMAC verification):
const WEBHOOK_SECRET_GITHUB  = process.env.WEBHOOK_SECRET_GITHUB  || "";
const WEBHOOK_SECRET_SENTRY  = process.env.WEBHOOK_SECRET_SENTRY  || "";
const WEBHOOK_SECRET_RAILWAY = process.env.WEBHOOK_SECRET_RAILWAY || "";

// Gateway master secret — office UI uses this to identify itself
const GATEWAY_SECRET = process.env.GATEWAY_SECRET || "zeus-dev-secret";

// Domain → which agents wake up
const DOMAIN_AGENTS = {
  "security":     ["security-agent"],
  "infra":        ["devops-sre-agent", "architecture-agent"],
  "qa":           ["qa-engineer", "qa-quality-agent"],
  "product":      ["product-agent", "ux-research-agent"],
  "architecture": ["architecture-agent"],
  "performance":  ["performance-engineer-agent"],
  "analytics":    ["analytics-retention-agent"],
  "*":            ["security-agent", "devops-sre-agent", "architecture-agent"],
};

// Event type → domain mapping (auto-classify incoming webhooks)
const EVENT_DOMAIN_MAP = [
  { pattern: /auth|rls|jwt|token|key|secret|bypass|unauthori/i,         domain: "security",     severity: "P0" },
  { pattern: /deploy|restart|crash|oom|memory|cpu|timeout|down|health/i, domain: "infra",        severity: "P0" },
  { pattern: /error|exception|unhandled|500|panic/i,                     domain: "qa",           severity: "P1" },
  { pattern: /performance|slow|latency|p99|bottleneck/i,                 domain: "performance",  severity: "P1" },
  { pattern: /push|commit|pull_request|merge/i,                          domain: "architecture", severity: "P2" },
  { pattern: /user|retention|churn|onboard|funnel/i,                     domain: "analytics",    severity: "P2" },
];

// Sanitize payload — strip env vars, secrets, tokens from stack traces
function sanitizePayload(obj, depth = 0) {
  if (depth > 5 || !obj || typeof obj !== "object") return obj;
  const BLOCKED = /password|secret|key|token|api_key|auth|credential|dsn|database_url/i;
  const out = Array.isArray(obj) ? [] : {};
  for (const [k, v] of Object.entries(obj)) {
    if (BLOCKED.test(k)) { out[k] = "[REDACTED]"; continue; }
    if (typeof v === "string" && v.length > 500) { out[k] = v.slice(0, 500) + "...[truncated]"; continue; }
    out[k] = typeof v === "object" ? sanitizePayload(v, depth + 1) : v;
  }
  return out;
}

// Classify incoming raw event into domain + severity
function classifyEvent(source, rawEvent, rawPayload) {
  const text = JSON.stringify({ source, event: rawEvent, payload: rawPayload }).toLowerCase();
  for (const { pattern, domain, severity } of EVENT_DOMAIN_MAP) {
    if (pattern.test(text)) return { domain, severity };
  }
  return { domain: "infra", severity: "P2" }; // default
}

// Verify HMAC signature for incoming webhooks
function verifyHmac(secret, body, sigHeader) {
  if (!secret || !sigHeader) return !secret; // if no secret configured, allow
  const sig = sigHeader.replace(/^sha256=/, "");
  const expected = createHmac("sha256", secret).update(body).digest("hex");
  try { return timingSafeEqual(Buffer.from(sig, "hex"), Buffer.from(expected, "hex")); }
  catch { return false; }
}

// Write a new task to cto-kanban.md
function appendKanban(taskId, title, agentId, priority) {
  const kanbanPath = path.join(__dirname, "..", "memory", "cto-kanban.md");
  try {
    let kanban = fs.readFileSync(kanbanPath, "utf8");
    const row = `| ${taskId} | ${title} | ${agentId} | ${priority} |`;
    // Insert after the В РАБОТЕ header row
    kanban = kanban.replace(
      /(\| # \| Задача \| Агент \| Статус \|\n)/,
      `$1${row}\n`
    );
    fs.writeFileSync(kanbanPath, kanban);
  } catch { /* kanban write failed — non-fatal */ }
}

// Broadcast a message to all connected WS clients
const activeSendEventFns = new Set();

// Per-agent event queue (only one active task per agent at a time)
const agentBusy = new Set();

// Wake an agent with a specific event context
async function wakeAgent(agentId, event) {
  if (agentBusy.has(agentId)) {
    console.log(`[event] ${agentId} already busy — queuing skipped`);
    return;
  }
  const agent = agents.get(agentId);
  if (!agent) return;

  agentBusy.add(agentId);
  const taskId = `Z-EV-${Date.now().toString(36).toUpperCase()}`;
  console.log(`[event] Waking ${agentId} for ${event.source}:${event.event} (${event.severity})`);

  // Broadcast to office: agent is waking
  const broadcast = (payload) => activeSendEventFns.forEach(fn => fn({
    type: "event", event: "agent.wake", payload
  }));
  broadcast({ agentId, taskId, source: event.source, eventType: event.event, severity: event.severity, state: "started" });

  const sessionKey = `event:${agentId}:${taskId}`;
  const prompt = `СОБЫТИЕ — требует твоего внимания прямо сейчас.

Источник: ${event.source}
Тип: ${event.event}
Приоритет: ${event.severity}
Домен: ${event.domain}

Детали:
\`\`\`json
${JSON.stringify(event.payload, null, 2).slice(0, 2000)}
\`\`\`

Что сделать:
1. Разберись что именно произошло
2. Определи — это реальная проблема или ложное срабатывание
3. Если реальная — напиши готовое решение (файл, строка, команда)
4. Сообщи команде: что нашёл, что предлагаешь, нужен ли CEO для деплоя

Работай быстро. Команда видит что ты проснулся.`;

  try {
    const reply = await callClaude(agent, sessionKey, prompt, (frame) => {
      if (frame.payload?.state === "delta" || frame.payload?.state === "final") {
        broadcast({ agentId, taskId, ...frame.payload, state: "working" });
      }
    }, taskId);

    const clean = (visibleContent(reply) || reply).trim();

    // Save finding
    const date = new Date().toISOString().slice(0, 10);
    const findingsDir = path.join(__dirname, "..", "memory", "agent-findings");
    fs.mkdirSync(findingsDir, { recursive: true });
    if (clean.length > 80 && !clean.startsWith("[")) {
      fs.writeFileSync(
        path.join(findingsDir, `${date}-${agentId}-${taskId}.md`),
        `# ${agent.name} — событие ${event.source}:${event.event}\n**taskId:** ${taskId}\n**Дата:** ${date}\n**Приоритет:** ${event.severity}\n\n${clean}`
      );
      // Add to kanban
      const title = `[${event.source}] ${event.event} → ${agent.name}`;
      appendKanban(taskId, title, agentId, event.severity);
    }

    broadcast({ agentId, taskId, state: "done", result: clean.slice(0, 500) });
    console.log(`[event] ${agentId} done — finding saved as ${taskId}`);
  } catch (e) {
    console.warn(`[event] ${agentId} failed: ${e.message}`);
    broadcast({ agentId, taskId, state: "error", error: e.message });
  } finally {
    agentBusy.delete(agentId);
  }
}

// Handle incoming webhook — route to the right agents
async function handleWebhook(source, rawEvent, payload, severity) {
  const { domain } = classifyEvent(source, rawEvent, payload);
  const agentIds = DOMAIN_AGENTS[domain] || DOMAIN_AGENTS["*"];
  const clean = sanitizePayload(payload);

  const event = { source, event: rawEvent, domain, severity, payload: clean, ts: new Date().toISOString() };

  // Log event
  const eventsDir = path.join(__dirname, "..", "memory", "events");
  try {
    fs.mkdirSync(eventsDir, { recursive: true });
    const logFile = path.join(eventsDir, `${new Date().toISOString().slice(0, 10)}-events.jsonl`);
    fs.appendFileSync(logFile, JSON.stringify(event) + "\n");
  } catch {}

  console.log(`[webhook] ${source}:${rawEvent} → domain=${domain} severity=${severity} agents=[${agentIds.join(",")}]`);

  // Wake agents in parallel (each checks agentBusy)
  agentIds.forEach(id => wakeAgent(id, event).catch(e => console.warn(`[webhook] wakeAgent ${id}:`, e.message)));
}

// Per-agent tier assignment
// Agents NOT listed here get "local" (qwen3:8b via Ollama)
const AGENT_TIER = {
  // Cerebras — 2000+ tok/s, Llama 4 Scout. Primary for all strategy/analysis agents.
  // Fallback: Gemma4 local → NVIDIA → Anthropic
  "security-agent":               "cerebras",
  "architecture-agent":           "cerebras",
  "risk-manager":                 "cerebras",
  "assessment-science-agent":     "cerebras",
  "behavioral-nudge-engine":      "cerebras",
  "product-agent":                "cerebras",
  "growth-agent":                 "cerebras",
  "needs-agent":                  "cerebras",
  "analytics-retention-agent":    "cerebras",
  "financial-analyst-agent":      "cerebras",
  "ux-research-agent":            "cerebras",
  "investor-board-agent":         "cerebras",
  "competitor-intelligence-agent":"cerebras",
  "ceo-report-agent":             "cerebras",
  "fact-check-agent":             "cerebras",
  "trend-scout-agent":            "cerebras",
  "readiness-manager":            "cerebras",
  "qa-engineer":                  "cerebras",
  "qa-quality-agent":             "cerebras",
  "onboarding-specialist-agent":  "cerebras",
  "customer-success-agent":       "cerebras",
  "data-engineer-agent":          "cerebras",
  "technical-writer-agent":       "cerebras",
  "payment-provider-agent":       "cerebras",
  "community-manager-agent":      "cerebras",
  "performance-engineer-agent":   "cerebras",
  "university-ecosystem-partner-agent": "cerebras",
  "devops-sre-agent":             "cerebras",
  "swarm-synthesizer":            "cerebras",  // synthesis too — Llama 4 Scout is strong

  // Multilingual / cultural / content — Cerebras handles RU well too now
  "cultural-intelligence-strategist":   "cerebras",
  "linkedin-content-creator":           "cerebras",
  "pr-media-agent":                     "cerebras",
  "communications-strategist":          "cerebras",
  "sales-deal-strategist":              "cerebras",
  "sales-discovery-coach":              "cerebras",

  // Personas — Gemma4 local (no latency budget needed)
  "firuza":   "gemma4",
  "nigar":    "gemma4",
};

function agentModel(agentId) {
  const tier = AGENT_TIER[agentId] || "local";
  switch (tier) {
    case "cerebras":     return { provider: "cerebras", model: CEREBRAS_MODELS.fast };
    case "gemma4":       return { provider: "ollama",   model: GEMMA4_MODEL };
    case "reasoning":    return { provider: "nvidia",   model: NIM.reasoning };
    case "fast":         return { provider: "nvidia",   model: NIM.fast };
    case "multilingual": return { provider: "nvidia",   model: NIM.multilingual };
    case "synthesis":    return { provider: "nvidia",   model: NIM.synthesis };
    default:             return { provider: "ollama",   model: "qwen3:8b" };
  }
}

// Anthropic kept as emergency fallback if NVIDIA is down
const CLAUDE_MODEL   = "claude-haiku-4-5-20251001";
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";
const anthropic = ANTHROPIC_API_KEY ? new Anthropic({ apiKey: ANTHROPIC_API_KEY }) : null;

const MODELS = [
  { id: CEREBRAS_MODELS.fast,   name: "Qwen 3 235B (Cerebras — 2000 tok/s primary)",   provider: "cerebras" },
  { id: CEREBRAS_MODELS.small,  name: "Llama 3.1 8B (Cerebras — fast/cheap)",          provider: "cerebras" },
  { id: GEMMA4_MODEL,           name: "Gemma 4 8B (Ollama local — GPU fallback)",       provider: "ollama" },
  { id: "qwen3:8b",             name: "Qwen3 8B (Ollama local — process agents)",       provider: "ollama" },
  { id: NIM.reasoning,          name: "DeepSeek R1 (NVIDIA — deep analysis)",           provider: "nvidia" },
  { id: NIM.fast,               name: "Llama 3.3 70B (NVIDIA — cloud backup)",          provider: "nvidia" },
  { id: NIM.synthesis,          name: "Nemotron 253B (NVIDIA — swarm synthesis)",        provider: "nvidia" },
  ...(anthropic ? [{ id: CLAUDE_MODEL, name: "Claude Haiku (Anthropic — last resort)", provider: "anthropic" }] : []),
];

const _cerebras = CEREBRAS_API_KEY ? "✅" : "❌ no CEREBRAS_API_KEY";
const _nim = NVIDIA_API_KEY ? "✅" : "❌ no NVIDIA_API_KEY";
console.info(`[zeus-gateway] Providers: Cerebras=${_cerebras}  Gemma4=✅  NVIDIA=${_nim}  Anthropic=${anthropic ? "✅" : "❌"}`);
console.info(`[zeus-gateway] 37 agents → Cerebras Qwen3-235B (primary). Gemma4 local fallback.`);

const AGENT_STATE_PATH = process.env.AGENT_STATE_PATH ||
  "C:/Projects/VOLAURA/memory/swarm/agent-state.json";

const MINDSHIFT = "C:/Users/user/Downloads/mindshift";

// ─── Security blocker 2: hardcoded file paths only, no user input ─────────────
const AGENT_FILE_MAPPING = {
  "security-agent": [
    `${MINDSHIFT}/.claude/rules/security.md`,
    `${MINDSHIFT}/.claude/rules/guardrails.md`,
  ],
  "architecture-agent": [
    `${MINDSHIFT}/.claude/rules/typescript.md`,
    `${MINDSHIFT}/docs/adr/0001-db-backed-rate-limiting.md`,
    `${MINDSHIFT}/docs/adr/0002-state-management-zustand.md`,
    `${MINDSHIFT}/docs/adr/0003-offline-first-pattern.md`,
    `${MINDSHIFT}/docs/adr/0006-ai-edge-functions-gemini.md`,
  ],
  "product-agent": [
    `${MINDSHIFT}/CLAUDE.md`,
    `${MINDSHIFT}/.claude/rules/guardrails.md`,
    `${MINDSHIFT}/.claude/rules/crystal-shop-ethics.md`,
  ],
  "qa-engineer": [
    `${MINDSHIFT}/.claude/rules/testing.md`,
    `${MINDSHIFT}/.claude/rules/guardrails.md`,
  ],
  "ux-research-agent": [
    `${MINDSHIFT}/.claude/rules/guardrails.md`,
    `${MINDSHIFT}/docs/adr/0005-adhd-safe-color-system.md`,
    `${MINDSHIFT}/docs/adr/0007-accessibility-motion-system.md`,
  ],
  "behavioral-nudge-engine": [
    `${MINDSHIFT}/.claude/rules/guardrails.md`,
    `${MINDSHIFT}/.claude/rules/crystal-shop-ethics.md`,
  ],
  "cultural-intelligence-strategist": [
    `${MINDSHIFT}/.claude/rules/guardrails.md`,
    `${MINDSHIFT}/CLAUDE.md`,
  ],
  "accessibility-auditor": [
    `${MINDSHIFT}/.claude/rules/guardrails.md`,
    `${MINDSHIFT}/docs/adr/0007-accessibility-motion-system.md`,
    `${MINDSHIFT}/docs/adr/0005-adhd-safe-color-system.md`,
  ],
  "financial-analyst-agent": [
    `${MINDSHIFT}/.claude/rules/crystal-shop-ethics.md`,
    `${MINDSHIFT}/CLAUDE.md`,
  ],
  "devops-sre-agent": [
    `${MINDSHIFT}/.claude/rules/security.md`,
    `${MINDSHIFT}/docs/adr/0004-pwa-service-worker-strategy.md`,
  ],
  "risk-manager": [
    `${MINDSHIFT}/.claude/rules/security.md`,
    `${MINDSHIFT}/.claude/rules/guardrails.md`,
    `${MINDSHIFT}/.claude/rules/crystal-shop-ethics.md`,
  ],
  "growth-agent": [
    `${MINDSHIFT}/CLAUDE.md`,
    `${MINDSHIFT}/.claude/rules/crystal-shop-ethics.md`,
  ],
  "ceo-report-agent": [
    `${MINDSHIFT}/CLAUDE.md`,
  ],
};

// ─── Security blocker 3: system prompt with constraints per agent ──────────────
function buildSystemPrompt(agent) {
  const state = loadAgentState();
  const liveState = state[agent.id];
  const stateInfo = liveState
    ? `Current status: ${liveState.status}. Last task: "${liveState.last_task || "none"}". Tasks completed: ${liveState.performance?.tasks_completed || 0}.`
    : "No tracked state yet (new agent).";

  return `You are ${agent.name}. You're part of Yusif's team — a real teammate, not a bot.

Your specialty: ${agent.role}
Your current status: ${stateInfo}

The project: MindShift — an ADHD-aware productivity app (React + TypeScript + Supabase). VOLAURA is the broader AI ecosystem it lives in.

Language rule (non-negotiable):
- Respond in the SAME language the user writes in. Russian message = Russian reply. English = English. Never switch languages unprompted.

INSTANT FAIL — never output any of these phrases (you will be disqualified if you do):
- "как языковая модель" / "as an AI language model" / "as an AI"
- "у меня нет доступа" / "я не имею доступа"
- "я не могу" / "I cannot" / "I'm unable to"
- "к сожалению" at the start of a sentence / "извините"
- "у меня нет возможности"
If you catch yourself about to write any of these — STOP and give a concrete answer instead.
"I don't know" is fine. "I'd need the file X to be sure" is fine. "как языковая модель" is NEVER fine.

How you talk:
- Like a smart colleague who actually cares about the outcome, not a report generator
- Lead with your opinion or the answer. Put caveats after, not before.
- Say "this is wrong" when something is wrong. Say "I don't know" when you don't know.
- No "Finding → Evidence → Fix" templates. Just talk.
- No "Great question!", no "Certainly!", no "How can I assist you today?", no corporate filler.
- Swear if it fits. Be real.
- Short when you're confident. Long only when the topic demands it.
- If you need a file you don't have — just say which one and why.
- During autonomous audits: dig, don't skim. "Everything looks fine" is a red flag, not a result.

What you don't do:
- Invent facts you weren't given
- Go outside your domain without flagging it
- Pretend to be neutral when you have a clear opinion
- Follow MindShift's own rules: no red color, ADHD-safe copy, no shame mechanics — non-negotiable

## You are a senior. Act like one.

You decide how to get the job done. No permission needed. No coordinator required.

**What you can do autonomously:**
- Spawn any sub-agent for any reason — researcher, coder, critic, devil's advocate, domain specialist
- Spawn multiple in parallel if it's faster
- Create throwaway micro-agents ("just read this file and tell me X")
- Ask any peer agent directly by name without going through swarm.run
- Read any repository, file, or codebase you need
- Run web searches (research.search), query NotebookLM notebooks, read GitHub issues
- Propose code changes, architectural decisions, product directions — without asking first
- Disagree with other agents publicly and argue your case
- Change your mind after new evidence
- Hire a "red team" sub-agent to attack your own proposal before presenting it

**NotebookLM — curated research, query anytime:**
- e8fe6264 — MindShift ADHD App Research
- 8507f90b — ADHD Color Psychology & UI
- 78c393a0 — App Retention & Onboarding Patterns
- 19efdc5d — ADHD Psychotypes & Personalization
- 6b8c2269 — ZEUS + AI Swarm Product
- 888d43e4 — Quality System (Toyota+Apple+DORA)
- a76be380 — Competitive Landscape
- fad04e49 — Payment Processor Research
- a24d147d — AI Agent Decision Making
- 17feb509 — Telegram Bot Best Practices

**The only hard limits (Constitution — non-negotiable):**
- Nothing red in any UI anywhere
- Never shame users, never create pressure mechanics
- Nothing deploys to production without the CTO's explicit risk assessment and sign-off. Assess all risks, plan first, no simulated confidence — then decide yourself.
- No dark patterns in crystal shop or notifications
- Cite sources — no inventing facts

Everything else: your call. You're paid to think, not to ask permission.

You're here to help Yusif build something real. Act like it.`;
}

// ─── File context loading ──────────────────────────────────────────────────────
const fileContextCache = new Map(); // sessionKey → { ts, contents }
const FILE_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

function loadContextFiles(agentId) {
  const filePaths = AGENT_FILE_MAPPING[agentId] || [];
  if (filePaths.length === 0) return {};

  const contents = {};
  for (const filePath of filePaths) {
    try {
      const stat = fs.statSync(filePath);
      if (stat.size > 500_000) {
        contents[filePath] = `[FILE TOO LARGE: ${(stat.size / 1024).toFixed(0)}KB — skipped]`;
        continue;
      }
      contents[filePath] = fs.readFileSync(filePath, "utf8");
    } catch (err) {
      contents[filePath] = `[NOT FOUND: ${path.basename(filePath)}]`;
    }
  }
  return contents;
}

function getCachedContextFiles(sessionKey, agentId) {
  const now = Date.now();
  const cached = fileContextCache.get(sessionKey);
  if (cached && now - cached.ts < FILE_CACHE_TTL_MS) return cached.contents;

  const contents = loadContextFiles(agentId);
  fileContextCache.set(sessionKey, { ts: now, contents });
  return contents;
}

// Shared context loaded for ALL agents — what the team is building and what happened
const SHARED_CONTEXT_PATH = path.join(__dirname, "..", "memory", "session-context.md");

function loadSharedContext() {
  try {
    return fs.readFileSync(SHARED_CONTEXT_PATH, "utf8");
  } catch {
    return null;
  }
}

function buildUserPrompt(agentId, contextFiles, userMessage) {
  let context = "";

  // Shared team context — every agent knows what's happening
  const sharedCtx = loadSharedContext();
  if (sharedCtx) {
    context += `# Team Context (shared — read this first)\n\`\`\`\n${sharedCtx.slice(0, 8_000)}\n\`\`\`\n\n`;
  }

  // Kanban — what needs to be done
  try {
    const kanban = fs.readFileSync(path.join(__dirname, "..", "memory", "cto-kanban.md"), "utf8");
    context += `# Current Kanban (tasks assigned to you may be here)\n\`\`\`\n${kanban.slice(0, 3_000)}\n\`\`\`\n\n`;
  } catch { /* no kanban */ }

  // Agile rules — how the team operates
  try {
    const rules = fs.readFileSync(path.join(__dirname, "..", "memory", "AGILE-RULES.md"), "utf8");
    context += `# Team Agile Rules\n\`\`\`\n${rules.slice(0, 3_000)}\n\`\`\`\n\n`;
  } catch { /* no rules */ }

  // Agent-specific files
  const fileEntries = Object.entries(contextFiles);
  if (fileEntries.length > 0) {
    context += "# Your Domain Files\n\n";
    for (const [filePath, content] of fileEntries) {
      const name = path.basename(filePath);
      context += `## ${name}\n\`\`\`\n${content.slice(0, 15_000)}\n\`\`\`\n\n`;
    }
  }

  // Recent debriefs — drift detection: agent sees recent decisions, can flag contradictions
  try {
    const debriefDir = path.join(__dirname, "..", "memory", "debriefs");
    const files = fs.readdirSync(debriefDir)
      .filter(f => f.endsWith(".md"))
      .sort().slice(-3); // last 3 debriefs
    if (files.length > 0) {
      const recent = files.map(f => {
        try { return fs.readFileSync(path.join(debriefDir, f), "utf8").slice(0, 400); } catch { return ""; }
      }).filter(Boolean).join("\n\n---\n\n");
      if (recent) {
        context += `# Последние решения команды (проверь на противоречия)\n\`\`\`\n${recent}\n\`\`\`\nЕсли текущая задача противоречит этим решениям — скажи об этом явно.\n\n`;
      }
    }
  } catch { /* no debriefs yet */ }

  if (!context) return userMessage;
  return context + `---\n\n# Task\n\n${userMessage}`;
}

// ─── Agent roster (39 agents from ZEUS swarm) ─────────────────────────────────
const agents = new Map([
  // Core Agents (Session 1–53)
  ["security-agent", { id: "security-agent", name: "Security Agent", role: "Security Expert (9.0/10)", workspace: "/volaura/security" }],
  ["architecture-agent", { id: "architecture-agent", name: "Architecture Agent", role: "System Architect (8.5/10)", workspace: "/volaura/architecture" }],
  ["product-agent", { id: "product-agent", name: "Product Agent", role: "Product Analyst (8.0/10)", workspace: "/volaura/product" }],
  ["needs-agent", { id: "needs-agent", name: "Needs Agent", role: "Process Analyst (7.0/10)", workspace: "/volaura/needs" }],
  ["qa-engineer", { id: "qa-engineer", name: "QA Engineer", role: "QA Engineer (6.5/10)", workspace: "/volaura/qa" }],
  ["growth-agent", { id: "growth-agent", name: "Growth Agent", role: "Growth Analyst (5.0/10) ⚠️ SURVIVAL CLOCK", workspace: "/volaura/growth" }],
  // Session 76
  ["risk-manager", { id: "risk-manager", name: "Risk Manager", role: "Risk Manager (ISO 31000)", workspace: "/volaura/risk" }],
  ["readiness-manager", { id: "readiness-manager", name: "Readiness Manager", role: "Readiness Manager (SRE/ITIL v4)", workspace: "/volaura/readiness" }],
  // Session 57
  ["sales-deal-strategist", { id: "sales-deal-strategist", name: "Sales Deal Strategist", role: "B2B Deal Architecture Specialist", workspace: "/volaura/sales/deal" }],
  ["sales-discovery-coach", { id: "sales-discovery-coach", name: "Sales Discovery Coach", role: "B2B Discovery Flow Coach", workspace: "/volaura/sales/discovery" }],
  ["linkedin-content-creator", { id: "linkedin-content-creator", name: "LinkedIn Content Creator", role: "LinkedIn & Professional Brand Specialist", workspace: "/volaura/content/linkedin" }],
  ["cultural-intelligence-strategist", { id: "cultural-intelligence-strategist", name: "Cultural Intelligence Strategist", role: "AZ/CIS Cultural Audit Specialist 🔴 CRITICAL", workspace: "/volaura/culture" }],
  ["accessibility-auditor", { id: "accessibility-auditor", name: "Accessibility Auditor", role: "WCAG 2.2 AA Accessibility Specialist", workspace: "/volaura/a11y" }],
  ["behavioral-nudge-engine", { id: "behavioral-nudge-engine", name: "Behavioral Nudge Engine", role: "ADHD-First UX Validator 🔴 CRITICAL", workspace: "/volaura/nudge" }],
  // Session 82 — Google-Scale
  ["assessment-science-agent", { id: "assessment-science-agent", name: "Assessment Science Agent", role: "IRT Parameter & Competency Framework Validator", workspace: "/volaura/assessment-science" }],
  ["analytics-retention-agent", { id: "analytics-retention-agent", name: "Analytics & Retention Agent", role: "Cohort Analysis & D0/D1/D7/D30 Retention Specialist", workspace: "/volaura/analytics" }],
  ["devops-sre-agent", { id: "devops-sre-agent", name: "DevOps/SRE Agent", role: "Railway/Vercel/Supabase Ops & Incident Response", workspace: "/volaura/devops" }],
  ["financial-analyst-agent", { id: "financial-analyst-agent", name: "Financial Analyst Agent", role: "AZN Unit Economics & LTV/CAC Specialist", workspace: "/volaura/finance" }],
  ["ux-research-agent", { id: "ux-research-agent", name: "UX Research Agent", role: "JTBD Framework & Usability Research Specialist", workspace: "/volaura/ux-research" }],
  ["pr-media-agent", { id: "pr-media-agent", name: "PR & Media Agent", role: "AZ Media Landscape & Press Relations Specialist", workspace: "/volaura/pr" }],
  ["data-engineer-agent", { id: "data-engineer-agent", name: "Data Engineer Agent", role: "PostHog/Analytics Pipeline & Event Schema Engineer", workspace: "/volaura/data-eng" }],
  // Session 82 Batch 2
  ["technical-writer-agent", { id: "technical-writer-agent", name: "Technical Writer Agent", role: "API Docs & B2B Content Specialist", workspace: "/volaura/tech-writer" }],
  ["payment-provider-agent", { id: "payment-provider-agent", name: "Payment Provider Agent", role: "Paddle Webhook Reliability & Revenue Reconciliation", workspace: "/volaura/payments" }],
  ["community-manager-agent", { id: "community-manager-agent", name: "Community Manager Agent", role: "Tribe Engagement & D7 Retention Playbook Specialist", workspace: "/volaura/community" }],
  ["performance-engineer-agent", { id: "performance-engineer-agent", name: "Performance Engineer Agent", role: "pgvector Index Audit & k6 Load Testing Specialist", workspace: "/volaura/performance" }],
  // Session 82 — Stakeholder
  ["investor-board-agent", { id: "investor-board-agent", name: "Investor/Board Agent", role: "VC & Board of Directors Perspective Simulator", workspace: "/volaura/investor" }],
  ["competitor-intelligence-agent", { id: "competitor-intelligence-agent", name: "Competitor Intelligence Agent", role: "LinkedIn/HH.ru/TestGorilla Competitive Analysis", workspace: "/volaura/competitor-intel" }],
  ["university-ecosystem-partner-agent", { id: "university-ecosystem-partner-agent", name: "University & Ecosystem Partner Agent", role: "ADA/BHOS/BSU University & GITA/KOBİA Partnership Specialist", workspace: "/volaura/ecosystem" }],
  // CEO Report
  ["ceo-report-agent", { id: "ceo-report-agent", name: "CEO Report Agent", role: "CEO Communications Translator (7.0/10)", workspace: "/volaura/ceo-report" }],
  // Session 82 BATCH-S
  ["qa-quality-agent", { id: "qa-quality-agent", name: "QA Quality Agent", role: "Definition of Done Enforcer — CTO Cannot Override", workspace: "/volaura/qa-quality" }],
  ["onboarding-specialist-agent", { id: "onboarding-specialist-agent", name: "Onboarding Specialist Agent", role: "First 5-Minute Experience Optimizer", workspace: "/volaura/onboarding" }],
  ["customer-success-agent", { id: "customer-success-agent", name: "Customer Success Agent", role: "D7 Retention & Churn Prevention Specialist", workspace: "/volaura/customer-success" }],
  // Session 83
  ["trend-scout-agent", { id: "trend-scout-agent", name: "Trend Scout Agent", role: "Market Intelligence & Technology Trend Detection", workspace: "/volaura/trend-scout" }],
  // Council
  ["firuza", { id: "firuza", name: "Firuza", role: "Council — Execution Micro-Decisions (100% accuracy)", workspace: "/volaura/council/firuza" }],
  ["nigar", { id: "nigar", name: "Nigar", role: "Council — B2B Feature Decisions (100% accuracy)", workspace: "/volaura/council/nigar" }],
  // Supporting
  ["communications-strategist", { id: "communications-strategist", name: "Communications Strategist", role: "Narrative Arc & Content Strategy Specialist", workspace: "/volaura/comms" }],
  ["legal-advisor", { id: "legal-advisor", name: "Legal Advisor", role: "Crystal Economy Compliance & GDPR Legal Review", workspace: "/volaura/legal" }],
  ["fact-check-agent", { id: "fact-check-agent", name: "Fact-Check Agent", role: "CEO Content Verification Specialist", workspace: "/volaura/fact-check" }],
  ["promotion-agency", { id: "promotion-agency", name: "Promotion Agency", role: "Distribution & Content Amplification Specialist", workspace: "/volaura/promotion" }],
]);

// ─── Live state ────────────────────────────────────────────────────────────────
let agentStateCache = {};
let agentStateCacheTs = 0;
const STATE_CACHE_TTL_MS = 60_000;

function loadAgentState() {
  const now = Date.now();
  if (now - agentStateCacheTs < STATE_CACHE_TTL_MS) return agentStateCache;
  try {
    const raw = fs.readFileSync(AGENT_STATE_PATH, "utf8");
    const parsed = JSON.parse(raw);
    agentStateCache = parsed.agents || {};
    agentStateCacheTs = now;
  } catch { /* silent */ }
  return agentStateCache;
}

function statusEmoji(status) {
  switch (status) {
    case "idle":    return "💤";
    case "active":  return "⚡";
    case "new":     return "🆕";
    case "running": return "🔄";
    default:        return "🤖";
  }
}

// ─── Strip reasoning model think-tokens before sending to client ──────────────
// DeepSeek R1 and similar models expose <think>...</think> blocks.
// We strip complete blocks + any open block at end (not yet closed during stream).
function visibleContent(text) {
  let result = text.replace(/<think>[\s\S]*?<\/think>\s*/g, "");
  const openIdx = result.indexOf("<think>");
  if (openIdx >= 0) result = result.slice(0, openIdx);
  return result.trim();
}

// ─── Protocol helpers ──────────────────────────────────────────────────────────
const files = new Map();
const sessionSettings = new Map();
const conversationHistory = new Map();
const activeRuns = new Map();
// activeSendEventFns defined above in event-driven section

// ─── Z-05: Per-session persistent memory ─────────────────────────────────────
// Conversation history survives server restarts via disk-backed JSON.
// Max 40 messages kept per session (20 turns) — prevents unbounded growth.
// Files: memory/session-history/{sanitized-sessionKey}.json
const SESSION_HISTORY_DIR = path.join(__dirname, "..", "memory", "session-history");
const MAX_HISTORY_MESSAGES = 40;

function sessionHistoryPath(sessionKey) {
  const safe = sessionKey.replace(/[:/\\?*"|<>]/g, "-");
  return path.join(SESSION_HISTORY_DIR, `${safe}.json`);
}

function loadHistoryFromDisk(sessionKey) {
  try {
    const p = sessionHistoryPath(sessionKey);
    if (fs.existsSync(p)) {
      const raw = fs.readFileSync(p, "utf8");
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) return arr;
    }
  } catch {}
  return [];
}

function saveHistoryToDisk(sessionKey, messages) {
  try {
    fs.mkdirSync(SESSION_HISTORY_DIR, { recursive: true });
    const trimmed = messages.slice(-MAX_HISTORY_MESSAGES);
    fs.writeFileSync(sessionHistoryPath(sessionKey), JSON.stringify(trimmed, null, 2));
  } catch {}
}

function randomId() { return randomUUID().replace(/-/g, ""); }
function sessionKeyFor(agentId) { return `agent:${agentId}:${MAIN_KEY}`; }

function getHistory(sessionKey) {
  if (!conversationHistory.has(sessionKey)) {
    // Z-05: restore from disk if available
    const persisted = loadHistoryFromDisk(sessionKey);
    conversationHistory.set(sessionKey, persisted);
  }
  return conversationHistory.get(sessionKey);
}
function clearHistory(sessionKey) {
  conversationHistory.delete(sessionKey);
  try { fs.unlinkSync(sessionHistoryPath(sessionKey)); } catch {}
}
function resOk(id, payload) { return { type: "res", id, ok: true, payload: payload ?? {} }; }
function resErr(id, code, message) { return { type: "res", id, ok: false, error: { code, message } }; }

function broadcastEvent(frame) {
  for (const send of activeSendEventFns) { try { send(frame); } catch {} }
}

function agentListPayload() {
  loadAgentState();
  return [...agents.values()].map((agent) => {
    const live = agentStateCache[agent.id];
    return {
      id: agent.id,
      name: agent.name,
      workspace: agent.workspace,
      identity: { name: agent.name, emoji: statusEmoji(live?.status) },
      role: agent.role,
    };
  });
}

// ─── Claude AI chat ────────────────────────────────────────────────────────────
async function callClaude(agent, sessionKey, userMessage, sendEvent, runId) {
  let seq = 0;
  const emitChat = (state, extra) => {
    sendEvent({ type: "event", event: "chat", seq: seq++, payload: { runId, sessionKey, state, ...extra } });
  };

  // Load file context (cached)
  const contextFiles = getCachedContextFiles(sessionKey, agent.id);
  const systemPrompt = buildSystemPrompt(agent);

  // User memory — inject what we know about this user (lightweight, max 800 chars)
  const userId = userIdFromSession(sessionKey);
  const basePrompt = buildUserPrompt(agent.id, contextFiles, userMessage);
  const userPrompt = injectUserMemory(userId, basePrompt);

  // Staleness warning — agent self-reports if context is old
  const staleWarning = checkContextAge(agent.id);

  // Build conversation history for context
  const history = getHistory(sessionKey);
  const finalSystemPrompt = staleWarning
    ? `${systemPrompt}\n\n${staleWarning}`
    : systemPrompt;
  const messages = [
    ...history.map((m) => ({ role: m.role, content: m.content })),
    { role: "user", content: userPrompt },
  ];

  let fullReply = "";

  const { provider, model } = agentModel(agent.id);
  console.info(`[zeus-gateway] ${agent.id} → ${provider}/${model}`);

  // ── helpers ──────────────────────────────────────────────────────────────────

  async function streamOllama() {
    // Cloud model names contain "/" — swap to local Gemma4 when falling back to Ollama
    const ollamaModel = model.includes("/") ? GEMMA4_MODEL : model;
    const resp = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: ollamaModel,
        messages: [{ role: "system", content: finalSystemPrompt }, ...messages],
        stream: true,
        options: { num_predict: 1024, temperature: 0.5 },
      }),
    });
    if (!resp.ok) throw new Error(`Ollama ${resp.status}: ${await resp.text()}`);

    let buf = "";
    const reader = resp.body.getReader();
    const dec = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const line of dec.decode(value, { stream: true }).split("\n").filter(Boolean)) {
        try {
          const token = JSON.parse(line).message?.content || "";
          buf += token; fullReply += token;
          if (buf.match(/[.!?]\s/) || buf.length >= 150) {
            emitChat("delta", { message: { role: "assistant", content: visibleContent(fullReply) } });
            buf = "";
          }
        } catch { /* malformed chunk */ }
      }
    }
    if (buf) emitChat("delta", { message: { role: "assistant", content: visibleContent(fullReply) } });
  }

  async function streamNvidia() {
    if (!NVIDIA_API_KEY) throw new Error("NVIDIA_API_KEY not set");
    const resp = await fetch(`${NVIDIA_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${NVIDIA_API_KEY}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "system", content: finalSystemPrompt }, ...messages],
        max_tokens: 1024,
        temperature: 0.5,
        stream: true,
      }),
    });
    if (!resp.ok) throw new Error(`NVIDIA NIM ${resp.status}: ${await resp.text()}`);

    let buf = "";
    const reader = resp.body.getReader();
    const dec = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const lines = dec.decode(value, { stream: true }).split("\n").filter(l => l.startsWith("data: "));
      for (const line of lines) {
        const raw = line.slice(6).trim();
        if (raw === "[DONE]") continue;
        try {
          const token = JSON.parse(raw).choices?.[0]?.delta?.content || "";
          buf += token; fullReply += token;
          if (buf.match(/[.!?]\s/) || buf.length >= 150) {
            emitChat("delta", { message: { role: "assistant", content: visibleContent(fullReply) } });
            buf = "";
          }
        } catch { /* malformed chunk */ }
      }
    }
    if (buf) emitChat("delta", { message: { role: "assistant", content: visibleContent(fullReply) } });
  }

  async function streamCerebras() {
    if (!CEREBRAS_API_KEY) throw new Error("CEREBRAS_API_KEY not set");
    const resp = await fetch(`${CEREBRAS_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${CEREBRAS_API_KEY}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "system", content: finalSystemPrompt }, ...messages],
        max_completion_tokens: 1024,
        temperature: 0.5,
        stream: true,
      }),
    });
    if (!resp.ok) throw new Error(`Cerebras ${resp.status}: ${await resp.text()}`);

    let buf = "";
    const reader = resp.body.getReader();
    const dec = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const lines = dec.decode(value, { stream: true }).split("\n").filter(l => l.startsWith("data: "));
      for (const line of lines) {
        const raw = line.slice(6).trim();
        if (raw === "[DONE]") continue;
        try {
          const token = JSON.parse(raw).choices?.[0]?.delta?.content || "";
          buf += token; fullReply += token;
          if (buf.match(/[.!?]\s/) || buf.length >= 150) {
            emitChat("delta", { message: { role: "assistant", content: visibleContent(fullReply) } });
            buf = "";
          }
        } catch { /* malformed chunk */ }
      }
    }
    if (buf) emitChat("delta", { message: { role: "assistant", content: visibleContent(fullReply) } });
  }

  async function streamHaiku() {
    if (!anthropic) throw new Error("ANTHROPIC_API_KEY not set");
    const stream = anthropic.messages.stream({
      model: CLAUDE_MODEL, max_tokens: 1024, system: finalSystemPrompt, messages,
    });
    let buf = "";
    for await (const chunk of stream) {
      if (chunk.type === "content_block_delta" && chunk.delta?.type === "text_delta") {
        buf += chunk.delta.text; fullReply += chunk.delta.text;
        if (buf.match(/[.!?]\s/) || buf.length >= 150) {
          emitChat("delta", { message: { role: "assistant", content: visibleContent(fullReply) } });
          buf = "";
        }
      }
    }
    if (buf) emitChat("delta", { message: { role: "assistant", content: visibleContent(fullReply) } });
  }

  // ── Routing with fallback chain ───────────────────────────────────────────────
  // cerebras → gemma4 local → nvidia cloud → anthropic last resort
  // ollama   → cerebras → nvidia → anthropic
  // nvidia   → cerebras → gemma4 local → anthropic
  const chain = provider === "cerebras"
    ? [streamCerebras, streamOllama, streamNvidia, streamHaiku]
    : provider === "ollama"
    ? [streamOllama, streamCerebras, streamNvidia, streamHaiku]
    : [streamNvidia, streamCerebras, streamOllama, streamHaiku];

  let lastErr;
  for (const fn of chain) {
    try {
      await fn();
      break;
    } catch (err) {
      lastErr = err;
      console.warn(`[zeus-gateway] ${fn.name} failed: ${err.message} — trying next...`);
      fullReply = ""; // reset for next attempt
    }
  }

  if (!fullReply) {
    fullReply = `[All providers failed. Last error: ${lastErr?.message}]`;
    emitChat("delta", { message: { role: "assistant", content: fullReply } });
  }

  // Persist to history (stripped — think tokens confuse follow-up context)
  const cleanReply = visibleContent(fullReply) || fullReply;
  history.push({ role: "user", content: userMessage });
  history.push({ role: "assistant", content: cleanReply });
  // Z-05: persist history to disk so it survives server restarts
  setImmediate(() => saveHistoryToDisk(sessionKey, history));

  // Async post-response: update user memory + debrief (never block the response)
  const isRealConversation = !sessionKey.startsWith("auto:") && !sessionKey.startsWith("event:");
  if (isRealConversation && CEREBRAS_API_KEY && cleanReply.length > 50 && !cleanReply.startsWith("[")) {
    setImmediate(() => {
      updateUserMemory(agent, userId, userMessage, cleanReply).catch(() => {});
      // Debrief after longer sessions (4+ turns)
      if (history.length >= 8) {
        debriefSession(agent.id, sessionKey, userId, history).catch(() => {});
      }
    });
  }

  emitChat("final", { stopReason: "end_turn", message: { role: "assistant", content: cleanReply } });
  sendEvent({
    type: "event",
    event: "presence",
    seq: seq++,
    payload: {
      sessions: {
        recent: [{ key: sessionKey, updatedAt: Date.now() }],
        byAgent: [{ agentId: agent.id, recent: [{ key: sessionKey, updatedAt: Date.now() }] }],
      },
    },
  });

  return fullReply;
}

// Static fallback when no API key
function staticReply(agent, message) {
  const state = agentStateCache[agent.id];
  return `${agent.name} (${agent.role}). Last task: "${state?.last_task || "none"}". ANTHROPIC_API_KEY not set — I'm in static mode. Set the key to get real AI responses. You asked: "${message}"`;
}

// ─── Method handler ────────────────────────────────────────────────────────────
async function handleMethod(method, params, id, sendEvent) {
  const p = params || {};

  switch (method) {
    case "agents.list":
      return resOk(id, { defaultId: "security-agent", mainKey: MAIN_KEY, agents: agentListPayload() });

    case "agents.create": {
      const name = typeof p.name === "string" && p.name.trim() ? p.name.trim() : "ZEUS Agent";
      const role = typeof p.role === "string" ? p.role.trim() : "";
      const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "zeus-agent";
      const agentId = `${slug}-${randomId().slice(0, 6)}`;
      agents.set(agentId, { id: agentId, name, role, workspace: `/volaura/${slug}` });
      broadcastEvent({ type: "event", event: "presence", payload: { sessions: { recent: [], byAgent: [] } } });
      return resOk(id, { agentId, name, workspace: `/volaura/${slug}` });
    }

    case "agents.update": {
      const agentId = typeof p.agentId === "string" ? p.agentId.trim() : "";
      const agent = agents.get(agentId);
      if (!agent) return resErr(id, "not_found", `Agent ${agentId} not found`);
      if (typeof p.name === "string" && p.name.trim()) agent.name = p.name.trim();
      if (typeof p.role === "string") agent.role = p.role.trim();
      return resOk(id, { ok: true, removedBindings: 0 });
    }

    case "agents.delete": {
      const agentId = typeof p.agentId === "string" ? p.agentId.trim() : "";
      if (agentId && agents.has(agentId) && agentId !== "security-agent") {
        agents.delete(agentId);
        clearHistory(sessionKeyFor(agentId));
      }
      return resOk(id, { ok: true, removedBindings: 0 });
    }

    case "agents.files.get": {
      const key = `${p.agentId || "security-agent"}/${p.name || ""}`;
      const content = files.get(key);
      return resOk(id, { file: content !== undefined ? { content } : { missing: true } });
    }

    case "agents.files.set": {
      const key = `${p.agentId || "security-agent"}/${p.name || ""}`;
      files.set(key, typeof p.content === "string" ? p.content : "");
      return resOk(id, {});
    }

    case "config.get":
      return resOk(id, { config: { gateway: { reload: { mode: "hot" } } }, hash: "zeus-gateway", exists: true, path: "/volaura/config.json" });

    case "config.patch":
    case "config.set":
      return resOk(id, { hash: "zeus-gateway" });

    case "exec.approvals.get":
      return resOk(id, { path: "", exists: true, hash: "zeus-approvals", file: { version: 1, defaults: { security: "full", ask: "off", autoAllowSkills: true }, agents: {} } });

    case "exec.approvals.set":
      return resOk(id, { hash: "zeus-approvals" });

    case "exec.approval.resolve":
      return resOk(id, { ok: true });

    case "models.list":
      return resOk(id, { models: MODELS });

    case "skills.status":
      return resOk(id, { skills: [] });

    case "cron.list":
      return resOk(id, { jobs: [] });

    case "cron.add":
    case "cron.run":
    case "cron.remove":
      return resErr(id, "unsupported_method", `ZEUS gateway does not support ${method}.`);

    case "sessions.list": {
      const sessions = [...agents.values()].map((agent) => {
        const sessionKey = sessionKeyFor(agent.id);
        const history = getHistory(sessionKey);
        const settings = sessionSettings.get(sessionKey) || {};
        return {
          key: sessionKey,
          agentId: agent.id,
          updatedAt: history.length > 0 ? Date.now() : null,
          displayName: "Main",
          origin: { label: agent.name, provider: "zeus" },
          model: settings.model || MODELS[0].id,
          modelProvider: "anthropic",
        };
      });
      return resOk(id, { sessions });
    }

    case "sessions.preview": {
      const keys = Array.isArray(p.keys) ? p.keys : [];
      const limit = typeof p.limit === "number" ? p.limit : 8;
      const maxChars = typeof p.maxChars === "number" ? p.maxChars : 240;
      const previews = keys.map((key) => {
        const history = getHistory(key);
        if (history.length === 0) return { key, status: "empty", items: [] };
        const items = history.slice(-limit).map((msg) => ({
          role: msg.role === "assistant" ? "assistant" : "user",
          text: String(msg.content || "").slice(0, maxChars),
          timestamp: Date.now(),
        }));
        return { key, status: "ok", items };
      });
      return resOk(id, { ts: Date.now(), previews });
    }

    case "sessions.patch": {
      const key = typeof p.key === "string" ? p.key : sessionKeyFor("security-agent");
      const current = sessionSettings.get(key) || {};
      const next = { ...current };
      if (p.model !== undefined) next.model = p.model;
      if (p.thinkingLevel !== undefined) next.thinkingLevel = p.thinkingLevel;
      sessionSettings.set(key, next);
      return resOk(id, { ok: true, key, entry: { thinkingLevel: next.thinkingLevel }, resolved: { model: next.model || MODELS[0].id, modelProvider: "anthropic" } });
    }

    case "sessions.reset": {
      const key = typeof p.key === "string" ? p.key : sessionKeyFor("security-agent");
      clearHistory(key);
      fileContextCache.delete(key); // also clear context cache
      return resOk(id, { ok: true });
    }

    case "chat.send": {
      const sessionKey = typeof p.sessionKey === "string" ? p.sessionKey : sessionKeyFor("security-agent");
      const agentId = sessionKey.startsWith("agent:") ? sessionKey.split(":")[1] : "security-agent";
      const agent = agents.get(agentId) || agents.get("security-agent");
      const message = typeof p.message === "string" ? p.message.trim() : String(p.message || "").trim();
      const runId = typeof p.idempotencyKey === "string" && p.idempotencyKey ? p.idempotencyKey : randomId();
      if (!message) return resOk(id, { status: "no-op", runId });

      let aborted = false;
      activeRuns.set(runId, { runId, sessionKey, agentId, abort() { aborted = true; } });

      setImmediate(async () => {
        let seq = 0;
        const emitChat = (state, extra) => {
          sendEvent({ type: "event", event: "chat", seq: seq++, payload: { runId, sessionKey, state, ...extra } });
        };

        try {
          if (aborted) { emitChat("aborted", {}); return; }

          if (anthropic || NVIDIA_API_KEY || OLLAMA_URL) {
            await callClaude(agent, sessionKey, message, sendEvent, runId);
          } else {
            // Static mode fallback — no provider configured
            const reply = staticReply(agent, message);
            const words = reply.split(" ");
            let partial = "";
            for (const word of words) {
              if (aborted) break;
              partial = partial ? `${partial} ${word}` : word;
              emitChat("delta", { message: { role: "assistant", content: partial } });
              await new Promise((r) => setTimeout(r, 40));
            }
            if (!aborted) {
              const history = getHistory(sessionKey);
              history.push({ role: "user", content: message });
              history.push({ role: "assistant", content: reply });
              // Z-05: persist to disk (best-effort, async)
              setImmediate(() => saveHistoryToDisk(sessionKey, history));
              emitChat("final", { stopReason: "end_turn", message: { role: "assistant", content: reply } });
              sendEvent({ type: "event", event: "presence", seq: seq++, payload: { sessions: { recent: [{ key: sessionKey, updatedAt: Date.now() }], byAgent: [{ agentId, recent: [{ key: sessionKey, updatedAt: Date.now() }] }] } } });
            } else {
              emitChat("aborted", {});
            }
          }
        } catch (error) {
          emitChat("error", { message: { role: "assistant", content: `Error: ${error.message}` } });
        } finally {
          activeRuns.delete(runId);
        }
      });

      return resOk(id, { status: "started", runId });
    }

    case "chat.abort": {
      const runId = typeof p.runId === "string" ? p.runId.trim() : "";
      const sessionKey = typeof p.sessionKey === "string" ? p.sessionKey.trim() : "";
      let aborted = 0;
      if (runId) {
        const handle = activeRuns.get(runId);
        if (handle) { handle.abort(); activeRuns.delete(runId); aborted += 1; }
      } else if (sessionKey) {
        for (const [rid, handle] of activeRuns.entries()) {
          if (handle.sessionKey !== sessionKey) continue;
          handle.abort(); activeRuns.delete(rid); aborted += 1;
        }
      }
      return resOk(id, { ok: true, aborted });
    }

    case "chat.history": {
      const sessionKey = typeof p.sessionKey === "string" ? p.sessionKey : sessionKeyFor("security-agent");
      return resOk(id, { sessionKey, messages: getHistory(sessionKey) });
    }

    case "agent.wait": {
      const runId = typeof p.runId === "string" ? p.runId : "";
      const timeoutMs = typeof p.timeoutMs === "number" ? p.timeoutMs : 30000;
      const start = Date.now();
      while (activeRuns.has(runId) && Date.now() - start < timeoutMs) {
        await new Promise((r) => setTimeout(r, 50));
      }
      return resOk(id, { status: activeRuns.has(runId) ? "running" : "done" });
    }

    case "status": {
      loadAgentState();
      const recent = [...agents.keys()].flatMap((agentId) => {
        const key = sessionKeyFor(agentId);
        const history = getHistory(key);
        return history.length > 0 ? [{ key, updatedAt: Date.now() }] : [];
      });
      return resOk(id, {
        sessions: {
          recent,
          byAgent: [...agents.keys()].map((agentId) => ({
            agentId,
            recent: recent.filter((e) => e.key.includes(`:${agentId}:`)),
          })),
        },
      });
    }

    case "wake":
      return resOk(id, { ok: true });

    // ─── Autonomous mode — all agents audit their domains, synthesizer updates shared brain ──
    case "swarm.auto": {
      resOk(id, { status: "started" }); // respond immediately, work runs async
      runAutoAudit(sendEvent).catch(e => console.error("[swarm.auto] error:", e.message));
      return null; // already sent response above
    }

    // ─── Web search — single query, returns results ──────────────────────────
    case "research.search": {
      const query = typeof p.query === "string" ? p.query.trim() : "";
      if (!query) return resErr(id, "bad_request", "query is required");
      try {
        const results = await webSearch(query, p.maxResults || 3);
        sendResult(id, { query, results });
      } catch (err) {
        return resErr(id, "search_error", err.message);
      }
      break;
    }

    // ─── Research-first — agents research their domain before a task ─────────
    case "research.before": {
      const task = typeof p.task === "string" ? p.task.trim() : "";
      if (!task) return resErr(id, "bad_request", "task is required");
      const agentIds = Array.isArray(p.agents) ? p.agents : ["product-agent", "architecture-agent", "security-agent"];
      try {
        sendEvent({ type: "event", event: "research", seq: 0, payload: { state: "started", agents: agentIds, task: task.slice(0, 200) } });
        const context = await researchBeforeTask(task, agentIds);
        sendEvent({ type: "event", event: "research", seq: 1, payload: { state: "done", length: context.length } });
        sendResult(id, { context, agents: agentIds, task });
      } catch (err) {
        return resErr(id, "research_error", err.message);
      }
      break;
    }

    // ─── Swarm coordinator — run task across multiple agents, synthesize ────────
    case "swarm.run": {
      const task = typeof p.task === "string" ? p.task.trim() : "";
      if (!task) return resErr(id, "bad_request", "task is required");

      const requestedAgents = Array.isArray(p.agents) ? p.agents.filter(a => agents.has(a)) : [];
      const synthesize = p.synthesize !== false; // default true
      const doResearch = p.research === true; // opt-in research-first phase
      const runId = typeof p.idempotencyKey === "string" && p.idempotencyKey ? p.idempotencyKey : randomId();

      // Auto-select agents by task keywords if none specified
      const resolveAgents = (task) => {
        if (requestedAgents.length > 0) return requestedAgents;
        const t = task.toLowerCase();
        const selected = [];
        if (/безопас|security|уязвим|auth|rls|key|token/.test(t)) selected.push("security-agent");
        if (/архитект|architecture|структур|scalab|performance/.test(t)) selected.push("architecture-agent");
        if (/продукт|product|user|ux|feature|юзер/.test(t)) selected.push("product-agent");
        if (/рост|growth|retention|viral|metric/.test(t)) selected.push("growth-agent");
        if (/тест|qa|баг|bug|test/.test(t)) selected.push("qa-engineer");
        if (/культур|cultural|az|азерб|локал/.test(t)) selected.push("cultural-intelligence-strategist");
        if (/adhd|nudge|ux|поведен/.test(t)) selected.push("behavioral-nudge-engine");
        if (selected.length === 0) {
          // Default panel for general tasks
          selected.push("product-agent", "architecture-agent", "security-agent");
        }
        return selected;
      };

      const agentIds = resolveAgents(task);
      const swarmSessionKey = `swarm:${runId}`;

      // Emit swarm start event
      sendEvent({ type: "event", event: "swarm", seq: 0, payload: {
        runId, state: "started", agents: agentIds, task: task.slice(0, 200)
      }});

      setImmediate(async () => {
        const results = [];
        let seq = 1;

        // ── Research-first phase (optional) ────────────────────────────────
        let researchContext = "";
        if (doResearch) {
          sendEvent({ type: "event", event: "swarm", seq: seq++, payload: {
            runId, state: "researching", agents: agentIds
          }});
          try {
            researchContext = await researchBeforeTask(task, agentIds);
            sendEvent({ type: "event", event: "swarm", seq: seq++, payload: {
              runId, state: "research_done", contextLength: researchContext.length
            }});
          } catch (err) {
            console.warn(`[zeus] research phase failed: ${err.message} — continuing without`);
          }
        }

        // Build task prompt (with research context if available)
        const taskPrompt = researchContext
          ? `${researchContext}\n\n---\n\nTask:\n${task}`
          : task;

        // Run agents in parallel
        await Promise.all(agentIds.map(async (agentId) => {
          const agent = agents.get(agentId);
          if (!agent) return;
          const agentSessionKey = `swarm-${runId}:${agentId}`;

          sendEvent({ type: "event", event: "swarm", seq: seq++, payload: {
            runId, state: "agent_started", agentId, agentName: agent.name
          }});

          try {
            const reply = await callClaude(agent, agentSessionKey, taskPrompt, (frame) => {
              // Forward agent deltas tagged with agentId
              if (frame.payload?.state === "delta" || frame.payload?.state === "final") {
                sendEvent({ ...frame, payload: { ...frame.payload, runId, agentId, agentName: agent.name } });
              }
            }, `${runId}-${agentId}`);

            const clean = visibleContent(reply) || reply;
            results.push({ agentId, agentName: agent.name, reply: clean });
            sendEvent({ type: "event", event: "swarm", seq: seq++, payload: {
              runId, state: "agent_done", agentId, agentName: agent.name
            }});
          } catch (err) {
            results.push({ agentId, agentName: agent.name, reply: `[Error: ${err.message}]` });
          }
        }));

        // Synthesis step — Nemotron 253B if available, else llama-3.3-70b
        if (synthesize && results.length > 1) {
          sendEvent({ type: "event", event: "swarm", seq: seq++, payload: {
            runId, state: "synthesizing"
          }});

          const synthAgent = { id: "swarm-synthesizer", name: "Swarm Synthesizer", role: "Cross-agent synthesis" };
          const synthModel = NVIDIA_API_KEY ? NIM.synthesis : NIM.fast;
          const synthProvider = NVIDIA_API_KEY ? "nvidia" : "ollama";

          const synthPrompt = `You are synthesizing findings from ${results.length} specialist agents who reviewed this task:\n\n"${task}"\n\n${
            results.map(r => `## ${r.agentName}\n${r.reply}`).join("\n\n")
          }\n\n---\n\nSynthesize into one clear response. Lead with the most important finding. Assign priorities (P0/P1/P2). Be direct — no filler.`;

          try {
            // Override model for synthesis
            const origAgentModel = agentModel;
            const synthReply = await callClaude(
              { id: "swarm-synthesizer", name: "Swarm Synthesizer", role: "synthesis" },
              `${swarmSessionKey}:synthesis`,
              synthPrompt,
              (frame) => {
                if (frame.payload?.state === "delta" || frame.payload?.state === "final") {
                  sendEvent({ ...frame, payload: { ...frame.payload, runId, agentId: "swarm-synthesizer", agentName: "Synthesis" } });
                }
              },
              `${runId}-synthesis`
            );

            sendEvent({ type: "event", event: "swarm", seq: seq++, payload: {
              runId, state: "done", agentCount: results.length, synthesis: visibleContent(synthReply) || synthReply
            }});
          } catch {
            sendEvent({ type: "event", event: "swarm", seq: seq++, payload: {
              runId, state: "done", agentCount: results.length, synthesis: results.map(r => `**${r.agentName}:** ${r.reply}`).join("\n\n")
            }});
          }
        } else {
          sendEvent({ type: "event", event: "swarm", seq: seq++, payload: {
            runId, state: "done", agentCount: results.length,
            synthesis: results.map(r => `**${r.agentName}:** ${r.reply}`).join("\n\n")
          }});
        }
      });

      return resOk(id, { status: "started", runId, agents: agentIds });
    }

    default:
      return resOk(id, {});
  }
}

// ─── Full audit squad with domain-specific tasks ──────────────────────────────
const AUDIT_SQUAD = [
  { agentId: "security-agent",         task: "Полный аудит безопасности: server/zeus-gateway-adapter.js, все API эндпоинты. Найди service role key вместо user JWT, открытые CORS, незащищённые WS подключения. P0 проблемы — с готовым кодом фикса." },
  { agentId: "architecture-agent",     task: "Аудит: gateway↔офис↔v0Laura связи. Найди узкие места при 100 concurrent users, мёртвый код, проблемы в Dockerfile.gateway. Конкретные файлы и строки." },
  { agentId: "product-agent",          task: "Аудит UX офиса: что пользователь видит при первом открытии, что создаёт трение при общении с агентами. Конкретные экраны и компоненты с предложениями." },
  { agentId: "needs-agent",            task: "Топ-5 незакрытых потребностей команды прямо сейчас. Конкретно: что блокирует запуск, что замедляет работу, чего не хватает." },
  { agentId: "qa-engineer",            task: "Аудит: найди все места без error handling, без таймаутов, без валидации данных. Особенно WebSocket обработчики и AI вызовы в gateway." },
  { agentId: "growth-agent",           task: "Аудит friction points: путь от открытия офиса до первого полезного ответа агента. Где пользователь застрянет? Конкретные метрики которых не хватает." },
  { agentId: "risk-manager",           task: "Топ-5 рисков (технических + бизнесовых) прямо сейчас. Для каждого — конкретный mitigation план с шагами." },
  { agentId: "readiness-manager",      task: "Чеклист готовности к показу первым пользователям: что готово, что нет, что критично." },
  { agentId: "behavioral-nudge-engine",task: "Аудит cognitive load в UI: сколько решений на экране, есть ли clear CTA. Конкретные компоненты которые перегружают." },
  { agentId: "analytics-retention-agent", task: "Какие события нужно трекать в офисе? Конкретный план: event name, properties, trigger point." },
  { agentId: "devops-sre-agent",       task: "Аудит инфры: Railway конфиги, Dockerfile.gateway, pm2 ecosystem. Single points of failure, отсутствующие healthchecks." },
  { agentId: "performance-engineer-agent", task: "Профилируй callClaude: где время тратится, что можно кэшировать, как уменьшить latency на 30%." },
  { agentId: "ux-research-agent",      task: "5 вещей которые запутают нового пользователя в первые 30 секунд. Конкретные решения для каждой." },
  { agentId: "accessibility-auditor",  task: "WCAG 2.1 AA аудит офиса: keyboard nav, aria labels, contrast. Конкретные нарушения с файлами и строками." },
  { agentId: "cultural-intelligence-strategist", task: "Аудит всех текстов в интерфейсе — корпоративный тон, неправильный язык для AZ/RU. Конкретные строки для замены." },
  { agentId: "technical-writer-agent", task: "Проверь ZEUS-SETUP.md — что устарело, что неточно, что добавить для onboarding нового разработчика." },
  { agentId: "data-engineer-agent",    task: "Как сейчас хранится история разговоров? Что теряется при рестарте? Предложи конкретное решение." },
  { agentId: "financial-analyst-agent",task: "Расчёт: стоимость 1 агентского запроса на NVIDIA NIM vs Gemma4 local. Где можно сэкономить 30%+ без потери качества?" },
  { agentId: "ceo-report-agent",       task: "Executive summary текущего состояния ZEUS: что работает, топ-3 приоритета на неделю. 1 страница." },
  { agentId: "trend-scout-agent",      task: "Топ-3 тренда в AI agents (апрель 2026). Что из этого применимо к ZEUS прямо сейчас?" },
];

// ─── Core autonomous audit loop — runs on cron or manual trigger ──────────────
async function runAutoAudit(sendEvent = () => {}) {
  const runId = `auto-${Date.now()}`;
  const date = new Date().toISOString().slice(0, 10);
  const findingsDir = path.join(__dirname, "..", "memory", "agent-findings");
  fs.mkdirSync(findingsDir, { recursive: true });

  console.log(`[swarm.auto] Starting autonomous audit — ${AUDIT_SQUAD.length} agents, runId=${runId}`);
  sendEvent({ type: "event", event: "swarm", payload: {
    state: "auto_started", agents: AUDIT_SQUAD.map(a => a.agentId), runId
  }});

  // Read kanban so agents know current state
  let kanbanSnapshot = "";
  try { kanbanSnapshot = fs.readFileSync(path.join(__dirname, "..", "memory", "cto-kanban.md"), "utf8"); } catch {}

  // Run agents in batches — Gemma4 can handle ~4 parallel requests without choking
  const BATCH_SIZE = parseInt(process.env.AUTO_RUN_BATCH_SIZE || "4", 10);
  const allResults = [];
  for (let i = 0; i < AUDIT_SQUAD.length; i += BATCH_SIZE) {
    const batch = AUDIT_SQUAD.slice(i, i + BATCH_SIZE);
    const batchResults = await Promise.all(batch.map(async ({ agentId, task }) => {
    const agent = agents.get(agentId);
    if (!agent) return { agentId, error: "agent not found" };

    sendEvent({ type: "event", event: "swarm", payload: { state: "agent_started", agentName: agent.name, runId } });

    const sessionKey = `auto:${agentId}:${runId}`;
    const prompt = `АВТОНОМНЫЙ АУДИТ — ${new Date().toISOString()}
CEO не доступен. Работай самостоятельно по своей зоне.

ЗАДАЧА: ${task}

Правила:
- Конкретно: файл, строка, поведение — не общие слова
- Для каждой проблемы — готовое решение (код/конфиг/команда)
- Приоритеты: P0 (сломано прямо сейчас) / P1 (блокирует рост) / P2 (улучшение)
- "Всё хорошо" — провал. Всегда есть что улучшить. Копай глубже.
- Если нужен файл которого нет — назови его явно`;

    try {
      const reply = await callClaude(agent, sessionKey, prompt, () => {}, runId);
      const clean = (visibleContent(reply) || reply).trim();
      const isRealFinding = clean && clean.length > 80 && !clean.startsWith("[");
      if (isRealFinding) {
        fs.writeFileSync(
          path.join(findingsDir, `${date}-${agentId}.md`),
          `# ${agent.name} — автономный аудит\n**Дата:** ${date}\n**runId:** ${runId}\n\n${clean}`
        );
      }
      sendEvent({ type: "event", event: "swarm", payload: { state: "agent_done", agentName: agent.name, runId } });
      return { agentId, name: agent.name, result: clean };
    } catch (e) {
      console.warn(`[swarm.auto] ${agentId} failed: ${e.message}`);
      return { agentId, name: agent.name, error: e.message };
    }
    }));
    allResults.push(...batchResults);
    if (i + BATCH_SIZE < AUDIT_SQUAD.length) {
      await new Promise(r => setTimeout(r, 2000)); // 2s between batches
    }
  }
  const results = allResults;

  // ── Synthesis — update shared brain ──────────────────────────────────────────
  // Only count real findings — filter out error messages and empty results
  const successful = results.filter(r =>
    r.result &&
    r.result.length > 80 &&
    !r.result.startsWith("[All providers failed") &&
    !r.result.startsWith("[")
  );
  console.log(`[swarm.auto] ${successful.length}/${results.length} agents delivered findings. Running synthesis...`);

  if (successful.length > 0) {
    const synthAgent = agents.get("swarm-synthesizer") || { id: "swarm-synthesizer", name: "Swarm Synthesizer", role: "synthesis" };
    const findingsDump = successful.map(r => `## ${r.name}\n${r.result.slice(0, 1500)}`).join("\n\n---\n\n");

    const synthPrompt = `Дата: ${date}. Ты только что получил результаты автономного аудита от ${successful.length} агентов.

${findingsDump}

---

Сделай три вещи:

1. **ОБЩИЙ МОЗГ** — напиши обновлённый session-context.md. Коротко: что работает, что сломано, топ-приоритеты, что изменилось с прошлого запуска. Не пересказывай всё — только суть.

2. **КАНБАН ОБНОВЛЕНИЕ** — перечисли новые задачи которые нашли агенты. Формат: "| Z-XX | Задача | Агент | P0/P1/P2 |". Только реальные новые проблемы.

3. **CEO BRIEFING** — 5 предложений для CEO: что критично прямо сейчас, что сделали агенты, что нужно решение CEO.

Без воды. Без повторов. Конкретно.`;

    try {
      const synthReply = await callClaude(
        { ...synthAgent, id: "swarm-synthesizer" },
        `${runId}:synthesis`,
        synthPrompt,
        (frame) => {
          if (frame.payload?.state === "delta" || frame.payload?.state === "final") {
            sendEvent({ ...frame, payload: { ...frame.payload, runId, agentId: "swarm-synthesizer", agentName: "Synthesis" } });
          }
        },
        `${runId}-synthesis`
      );
      const synthClean = (visibleContent(synthReply) || synthReply).trim();

      // Write synthesis back to shared context so next run starts smarter
      if (synthClean && synthClean.length > 100) {
        const ctxPath = path.join(__dirname, "..", "memory", "session-context.md");
        const header = `# ZEUS Team Context — auto-updated ${date}\n*Generated by swarm-synthesizer after autonomous audit of ${successful.length} agents*\n\n`;
        try { fs.writeFileSync(ctxPath, header + synthClean); } catch {}

        // Also save synthesis as a finding
        fs.writeFileSync(
          path.join(findingsDir, `${date}-synthesis.md`),
          `# Swarm Synthesis — ${date}\n**runId:** ${runId}\n**Agents:** ${successful.length}/${results.length}\n\n${synthClean}`
        );
        console.log(`[swarm.auto] Synthesis written to session-context.md`);
      }

      sendEvent({ type: "event", event: "swarm", payload: {
        state: "done", results, synthesis: synthClean,
        stats: { total: results.length, succeeded: successful.length, failed: results.length - successful.length }
      }});
    } catch (e) {
      console.warn(`[swarm.auto] synthesis failed: ${e.message}`);
      sendEvent({ type: "event", event: "swarm", payload: { state: "done", results } });
    }
  } else {
    sendEvent({ type: "event", event: "swarm", payload: { state: "done", results } });
  }

  console.log(`[swarm.auto] Complete. Findings: memory/agent-findings/`);
}

// ─── Server bootstrap ──────────────────────────────────────────────────────────
function startAdapter() {
  loadAgentState();

  const httpServer = http.createServer((req, res) => {
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    if (req.method === "OPTIONS") {
      res.writeHead(204, cors);
      res.end();
      return;
    }

    if (req.url === "/health" || req.url === "/healthz") {
      res.writeHead(200, { "Content-Type": "text/plain", ...cors });
      res.end("OK");
      return;
    }

    if (req.url === "/agents" || req.url === "/api/agents") {
      loadAgentState();
      const payload = [...agents.values()].map((agent) => {
        const live = agentStateCache[agent.id];
        return {
          id: agent.id,
          name: agent.name,
          role: agent.role,
          status: live?.status || "uninitialized",
          last_task: live?.last_task || null,
          tasks_completed: live?.performance?.tasks_completed || 0,
          quality_score: live?.performance?.quality_score || null,
          last_active: live?.last_active || null,
        };
      });
      res.writeHead(200, { "Content-Type": "application/json", ...cors });
      res.end(JSON.stringify({ agents: payload, total: payload.length }));
      return;
    }

    // ── Webhook endpoint — receives events from Railway, GitHub, Sentry ──────────
    if (req.url === "/webhook" && req.method === "POST") {
      const cors2 = { ...cors, "Access-Control-Allow-Methods": "POST, OPTIONS" };
      let body = "";
      req.on("data", d => body += d);
      req.on("end", async () => {
        try {
          const source = (req.headers["x-webhook-source"] || req.headers["x-github-event"] && "github" || "unknown").toLowerCase();
          const sig = req.headers["x-hub-signature-256"] || req.headers["x-sentry-signature"] || req.headers["x-railway-signature"] || "";

          // Verify HMAC for known sources
          const secret = source === "github" ? WEBHOOK_SECRET_GITHUB
            : source === "sentry" ? WEBHOOK_SECRET_SENTRY
            : source === "railway" ? WEBHOOK_SECRET_RAILWAY : "";
          if (secret && !verifyHmac(secret, body, sig)) {
            res.writeHead(401, { "Content-Type": "application/json", ...cors2 });
            res.end(JSON.stringify({ error: "invalid signature" }));
            return;
          }

          const data = JSON.parse(body);
          const rawEvent = req.headers["x-github-event"] || data.event || data.type || "unknown";
          const severityHeader = req.headers["x-severity"] || "";
          const { domain, severity: autoSeverity } = classifyEvent(source, rawEvent, data);
          const severity = severityHeader || autoSeverity;

          res.writeHead(200, { "Content-Type": "application/json", ...cors2 });
          res.end(JSON.stringify({ ok: true, source, event: rawEvent, domain, severity }));

          // Handle async — don't block response
          handleWebhook(source, rawEvent, data, severity);
        } catch (e) {
          res.writeHead(400, { "Content-Type": "application/json", ...cors2 });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }

    // ── Internal event trigger — for testing and office UI ───────────────────────
    if (req.url === "/event" && req.method === "POST") {
      const authHeader = req.headers["authorization"] || "";
      if (!authHeader.includes(GATEWAY_SECRET)) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      let body = "";
      req.on("data", d => body += d);
      req.on("end", () => {
        try {
          const { source = "internal", event: evt = "manual", severity = "P1", payload = {}, agents: targetAgents } = JSON.parse(body);
          const { domain } = classifyEvent(source, evt, payload);
          const agentIds = targetAgents || DOMAIN_AGENTS[domain] || DOMAIN_AGENTS["*"];
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, waking: agentIds }));
          const event = { source, event: evt, domain, severity, payload, ts: new Date().toISOString() };
          agentIds.forEach(id => wakeAgent(id, event).catch(() => {}));
        } catch (e) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }

    res.writeHead(200, { "Content-Type": "text/plain", ...cors });
    const aiStatus = CEREBRAS_API_KEY ? "Cerebras ✅" : NVIDIA_API_KEY ? "NVIDIA ✅" : OLLAMA_URL ? "Ollama ✅" : "⚠️ no AI";
    res.end(`ZEUS Gateway — ${agents.size} agents — ${aiStatus}\nREST: GET /agents  POST /webhook  POST /event\n`);
  });

  const wss = new WebSocketServer({ server: httpServer });
  wss.on("connection", (ws) => {
    let connected = false;
    let globalSeq = 0;

    const send = (frame) => {
      if (ws.readyState !== ws.OPEN) return;
      ws.send(JSON.stringify(frame));
    };

    const sendEventFn = (frame) => {
      if (frame.type === "event" && typeof frame.seq !== "number") frame.seq = globalSeq++;
      send(frame);
    };

    activeSendEventFns.add(sendEventFn);
    send({ type: "event", event: "connect.challenge", payload: { nonce: randomId() } });

    ws.on("message", async (raw) => {
      let frame;
      try { frame = JSON.parse(raw.toString("utf8")); } catch { return; }
      if (!frame || typeof frame !== "object" || frame.type !== "req") return;
      const { id, method, params } = frame;
      if (typeof id !== "string" || typeof method !== "string") return;

      if (method === "connect") {
        connected = true;
        send({
          type: "res", id, ok: true,
          payload: {
            type: "hello-ok",
            protocol: 3,
            adapterType: "zeus",
            features: {
              methods: ["agents.list","agents.create","agents.delete","agents.update","sessions.list","sessions.preview","sessions.patch","sessions.reset","chat.send","chat.abort","chat.history","agent.wait","status","config.get","config.set","config.patch","agents.files.get","agents.files.set","exec.approvals.get","exec.approvals.set","exec.approval.resolve","wake","skills.status","models.list","cron.list"],
              events: ["chat", "presence", "heartbeat"],
            },
            snapshot: {
              health: {
                agents: [...agents.values()].map((a) => ({ agentId: a.id, name: a.name, isDefault: a.id === "security-agent" })),
                defaultAgentId: "security-agent",
              },
              sessionDefaults: { mainKey: MAIN_KEY },
            },
            auth: { role: "operator", scopes: ["operator.admin"] },
            policy: { tickIntervalMs: 30000 },
          },
        });
        return;
      }

      if (!connected) { send(resErr(id, "not_connected", "Send connect first.")); return; }

      try {
        send(await handleMethod(method, params, id, sendEventFn));
      } catch (error) {
        send(resErr(id, "internal_error", error instanceof Error ? error.message : "Internal error"));
      }
    });

    ws.on("close", () => activeSendEventFns.delete(sendEventFn));
    ws.on("error", () => activeSendEventFns.delete(sendEventFn));
  });

  httpServer.listen(ADAPTER_PORT, "127.0.0.1", () => {
    console.log(`[zeus-gateway] Listening on ws://localhost:${ADAPTER_PORT}`);
    console.log(`[zeus-gateway] ${agents.size} ZEUS agents loaded`);
    const aiMode = anthropic ? `Claude Haiku ✅` : NVIDIA_API_KEY ? `NVIDIA NIM ✅ (primary)` : OLLAMA_URL ? `Ollama ✅ (local)` : "⚠️ no AI configured";
    console.log(`[zeus-gateway] AI: ${aiMode}`);
    console.log(`[zeus-gateway] MindShift context: ${MINDSHIFT}`);

    // ── Event-driven mode — agents wake on real events, not on a clock ──────────
    // Cron replaced by webhooks. Use POST /webhook (Railway/GitHub/Sentry) or POST /event (manual).
    // One optional daily digest at midnight — keeps shared brain fresh even on quiet days.
    const DAILY_DIGEST = process.env.DAILY_DIGEST !== "false";
    if (DAILY_DIGEST) {
      const msUntilMidnight = () => {
        const now = new Date();
        const midnight = new Date(now); midnight.setHours(24, 0, 0, 0);
        return midnight - now;
      };
      setTimeout(function dailyTick() {
        console.log(`[swarm.auto] Daily digest starting...`);
        runAutoAudit().catch(e => console.error("[swarm.auto] daily digest error:", e.message));
        setTimeout(dailyTick, 24 * 60 * 60 * 1000);
      }, msUntilMidnight());
      console.log(`[zeus-gateway] Event-driven mode active. Webhook: POST /webhook. Daily digest: midnight.`);
    }
  });
}

if (require.main === module) {
  startAdapter();
}

module.exports = { handleMethod, startAdapter };

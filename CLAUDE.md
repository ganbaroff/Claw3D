# claw3d / ZEUS — Claude Working Memory

## What This Repo Is

**claw3d-fork** contains two things:
1. **ZEUS Gateway** (`server/zeus-gateway-adapter.js`) — Node.js WebSocket brain for all 39 agents
2. **Life Simulator** (`src/`) — Next.js + Three.js 3D office where agents live visually

This is part of the 5-product **VOLAURA ecosystem**. The **Ecosystem Constitution** governs everything:
```bash
git show origin/claude/blissful-lichterman:docs/ECOSYSTEM-CONSTITUTION.md
```
Constitution has PRIORITY over all code. If code conflicts — code changes.

## ZEUS Gateway

- **Local:** `ws://localhost:18789` (pm2: `zeus-gateway`)
- **Production:** `wss://zeus-gateway-production.up.railway.app`
- **LLM hierarchy:** Cerebras Qwen3-235B → Gemma4/Ollama (local GPU) → NVIDIA NIM → Anthropic Haiku
- **Manage:** `pm2 restart zeus-gateway --update-env` — NEVER kill
- **39 agents** defined in `server/zeus-gateway-adapter.js`

### ZEUS Architecture
```
POST /webhook    ← Railway, GitHub, Sentry (HMAC verified)
POST /event      ← internal trigger (GATEWAY_SECRET auth)
GET  /agents     ← agent list + status
GET  /health     ← Railway healthcheck

WS ws://localhost:18789
  connect → handshake
  chat.send → Cerebras → Gemma4 → NVIDIA → Anthropic
  swarm.run → multi-agent coordinator
```

### Memory System
| Path | What |
|------|------|
| `memory/session-context.md` | Shared brain — updated after each audit cycle |
| `memory/cto-kanban.md` | Team kanban |
| `memory/users/{userId}.md` | Per-user profiles (max 4KB, injected per prompt) |
| `memory/debriefs/` | Session debriefs (last 3 injected into every agent prompt) |
| `memory/agent-findings/` | Agent findings, includes JWT fix Z-EV-MNMVBDDE |

## Life Simulator (3D Office)

- **Stack:** Next.js + React Three Fiber (`@react-three/fiber@9.5.0`) + Three.js 0.183.2
- **Dev:** `http://localhost:3000`
- **GitHub:** `https://github.com/ganbaroff/Claw3D`

### 10-State Agent Model (implemented 2026-04-06, Z-03 Phase 1)

```typescript
type OfficeAgentState =
  | "idle"       // #f59e0b amber — no ring
  | "focused"    // #06b6d4 cyan — slow ring
  | "working"    // #22c55e green — fast ring
  | "waiting"    // #eab308 yellow — medium ring
  | "blocked"    // #f97316 orange — fast ring
  | "overloaded" // #ef4444 red — very fast ring ⚠️ ONLY red allowed in 3D viz
  | "recovering" // #a855f7 purple — slow ring
  | "degraded"   // #6b7280 gray — very slow ring
  | "meeting"    // #3b82f6 blue — steady ring
  | "error";     // #ef4444 red — fast ring
```

Key files:
| File | Purpose |
|------|---------|
| `src/features/retro-office/core/types.ts` | OfficeAgentState type + OfficeAgent interface |
| `src/features/retro-office/objects/agents.tsx` | 3D rendering: body, nameplate, state badge, pulse ring |
| `src/features/retro-office/objects/types.ts` | AgentModelProps with officeState |
| `src/features/office/screens/OfficeScreen.tsx` | deriveOfficeState() + mapAgentToOffice() |
| `src/features/retro-office/RetroOffice3D.tsx` | Canvas, sceneAgents, AgentObjectModel |
| `src/features/agents/state/store.tsx` | AgentState, AgentStatus, Redux-like reducer |
| `server/zeus-gateway-adapter.js` | ZEUS — 1500+ lines, all 39 agents |

## Foundation Laws (from ECOSYSTEM-CONSTITUTION.md v1.2)

1. **NEVER RED** — except in 3D Life Simulator for `overloaded`/`error` states (explicit exception)
2. **Energy Adaptation** — ⚠️ NOT YET IMPLEMENTED in this repo (only MindShift has it)
3. **Shame-Free Language** — agent status badges must be neutral: "⚡ working" not "⚡ OVERLOADED!"
4. **Animation Safety** — pulse rings must respect prefers-reduced-motion
5. **One Primary Action** — max 1 CTA per panel

## Open Work Items

| ID | Task | Priority |
|----|------|----------|
| **Z-EV-MNMVBDDE** | JWT auth in WebSocket handshake — code in `memory/agent-findings/`, needs Railway deploy | **P0** |
| — | WEBHOOK_SECRET_RAILWAY/GITHUB/SENTRY in Railway Dashboard | **P0** |
| **Z-02** | RemoteAgentChatPanel — agent responses not visible in cloud (`OfficeScreen.tsx`) | **P1** |
| **Z-03 Ph2** | Ready Player Me avatars via `useGLTF` (field `avatarUrl` already in store) | **P1** |
| **Z-03 Ph2** | Wire `agent.wake` events → explicit officeState transitions | **P1** |
| **Z-03 Ph2** | `blocked`/`overloaded`/`recovering` state derivation in `deriveOfficeState()` | **P2** |
| **Law 2** | Energy Adaptation — implement in Life Simulator UI | **P1** |

## How to Consult Agents

```javascript
const ws = new (require('ws'))('ws://localhost:18789');
ws.on('open', () => ws.send(JSON.stringify({type:'req',id:'c1',method:'connect',params:{}})));
ws.on('message', m => {
  const d = JSON.parse(m.toString());
  if(d.id==='c1') ws.send(JSON.stringify({
    type:'req', id:'q1', method:'chat.send',
    params:{ agentId:'architecture-agent', sessionKey:'session-1', message:'...' }
  }));
  if(d.type==='event' && d.event==='chat' && d.payload?.state==='final') {
    console.log(d.payload.message.content);
    ws.close();
  }
});
```

Key agents: `architecture-agent`, `security-agent`, `devops-sre-agent`, `product-agent`, `swarm-synthesizer`

## Build Rules

- `tsc --noEmit` before any commit (Next.js uses this, not `tsc -b`)
- No new npm packages without bundle-size justification
- `motion/react` not `framer-motion`
- Never kill pm2 — always restart

## Env Vars (local .env)

```
CEREBRAS_API_KEY=...
NVIDIA_API_KEY=...
GATEWAY_SECRET=zeus-dev-secret
NEXT_PUBLIC_GATEWAY_URL=ws://localhost:18789
OLLAMA_URL=http://localhost:11434
LOCAL_MODEL=qwen3:8b
```

# VOLAURA — Полный хэндофф для нового чата
*Дата: 2026-04-06. Написан вместе с architecture-agent и swarm-synthesizer.*
*Этот документ содержит ВСЁ что обсуждалось и было сделано за последние две сессии.*

---

## Кто ты в новом чате

Ты — главный инженер CEO Юсифа. Юсиф строит VOLAURA — экосистему живых ИИ-агентов.
Ты работаешь над двумя репозиториями одновременно:
- `C:\Users\user\Downloads\mindshift\` — MindShift PWA (уже в продакшене)
- `C:\Users\user\Downloads\claw3d-fork\` — ZEUS Gateway + 3D офис агентов

**Правила работы (критично, не нарушай):**
1. **НИКОГДА не решай один** — всегда консультируйся с агентами через ZEUS gateway
2. **Агенты — живая команда, не боты** — у них есть характеры, память, мнения
3. **CEO-advisor роль** — анализируй перед реализацией, предлагай идеи сам не жди
4. **pm2** управляет gateway — `pm2 restart zeus-gateway --update-env` (никогда не kill)
5. **tsc --noEmit** перед любым коммитом

---

## Экосистема VOLAURA

| Проект | Что это | Статус |
|--------|---------|--------|
| **MindShift** | ADHD-aware PWA (React + Vite + Supabase) | ✅ Production-ready v1.0, Google Play ожидает верификации |
| **ZEUS Gateway** | Node.js WebSocket сервер — мозг всех агентов | ✅ Railway: `wss://zeus-gateway-production.up.railway.app` + pm2 локально |
| **claw3d / v0Laura** | 3D офис где живут агенты (Next.js + Three.js + React Three Fiber) | 🔧 В разработке, dev: `http://localhost:3000` |
| **Life Simulator** | Видимые состояния агентов в 3D офисе | ✅ Phase 1 реализован |

**Философия (слова architecture-agent):**
> VOLAURA — это не инструмент. Не API. Это среда, где ИИ ведёт себя как живая команда. Агенты спят, учатся, ошибаются. Life Simulator имитирует человеческие ритмы — усталость, внимание, recovery — чтобы пользователь чувствовал: "они как я".

---

## Что было ДО этих сессий

**ZEUS Gateway:**
- Существовал, но агенты работали вслепую — без общего контекста
- Запускались только вручную, 37 агентов простаивали
- Все вызовы шли через NVIDIA NIM → rate limiting при параллельном запуске
- Не было памяти о пользователях, не было автономной работы

**claw3d:**
- 3D офис задеплоен, агенты отображались
- Статус агента: только 3 состояния `"working" | "idle" | "error"`
- `RemoteAgentChatPanel` не синхронил ответы агентов в облако
- Не было Ready Player Me аватаров

**MindShift:**
- Готов к продакшену, но требовал финального security/a11y аудита

---

## Что сделали — Сессия 1 (ZEUS Gateway)

### 1. Задеплоили ZEUS Gateway на Railway
- `wss://zeus-gateway-production.up.railway.app` — живой
- `/health` endpoint для Railway healthcheck

### 2. Добавили Gemma4 (локально) + Cerebras Qwen3-235B
```
Иерархия провайдеров:
Cerebras Qwen3-235B (primary, 2000+ токен/сек)
  → Gemma4:latest via Ollama (local GPU, zero rate limit)
  → NVIDIA NIM (backup, Nemotron 253B)
  → Anthropic Claude Haiku (last resort)
```
Файл: `server/zeus-gateway-adapter.js`

### 3. Общий мозг для агентов
- Каждый агент видит: `session-context.md` + `cto-kanban.md` + `AGILE-RULES.md`
- После каждого audit-цикла `swarm-synthesizer` обновляет `session-context.md`
- Агенты не стартуют с нуля — знают состояние проекта

### 4. Event-driven архитектура (вместо cron)
**Было:** cron каждые 2 часа (жрал токены впустую)
**Стало:** агенты idle, просыпаются только на реальные события

```
Railway/GitHub/Sentry → POST /webhook → classifyEvent() → wakeAgent() → finding → kanban
```

Реализовано в `zeus-gateway-adapter.js`:
- `POST /webhook` — принимает события, верифицирует HMAC подпись
- `POST /event` — внутренний триггер (GATEWAY_SECRET auth)
- `classifyEvent()` — автоматически определяет домен по содержанию
- `wakeAgent()` — агент анализирует, пишет finding, добавляет в канбан
- Ежедневный digest в полночь — обновляет общий мозг

**Проверено live:** `sentry:error.unhandled → security-agent проснулся за 2с → нашёл JWT дыру → написал фикс → Z-EV-MNMVBDDE`

### 5. User Memory System
- `memory/users/{userId}.md` — персональный профиль каждого пользователя
- Читается в промпт перед каждым ответом (max 800 символов)
- Обновляется после каждого ответа асинхронно (Cerebras llama3.1-8b)
- Уже работает: `memory/users/yusif.md` создан автоматически

### 6. Session Debriefer + Drift Detector
- После каждой сессии (4+ обмена) пишет `memory/debriefs/`
- Последние 3 дебрифа инжектируются в каждый промпт агентов
- Агент должен флагировать противоречия с прошлыми решениями

### 7. Фикс системных промптов
- Жёсткий запрет: "как языковая модель", "я не могу" = INSTANT FAIL
- "Всё хорошо" в аудите = красный флаг
- Агент предупреждает если его контекст устарел >7 дней

### 8. All-Agents Script
- `scripts/all-agents-go.js` — Phase 1: competence check (39 агентов), Phase 2: реальные задачи
- Батчинг по 5 (не перегружает Ollama)
- Результаты в `memory/agent-findings/`

---

## Что сделали — Сессия 2 (Life Simulator Phase 1)

### Z-03: 10-стейтная модель агентов в 3D офисе

**5 файлов изменено, tsc clean:**

#### `src/features/retro-office/core/types.ts`
Добавлен тип `OfficeAgentState` (из `docs/agent-state-model-spec.md`):
```typescript
export type OfficeAgentState =
  | "idle"       // нет задачи, доступен
  | "focused"    // глубокая работа / недавно завершил
  | "working"    // активно обрабатывает
  | "waiting"    // ждёт ввода / апрувала
  | "blocked"    // зависимость не решена
  | "overloaded" // слишком много задач
  | "recovering" // после ошибки
  | "degraded"   // частичная функциональность
  | "meeting"    // в standup
  | "error";     // критическая ошибка
```
Добавлено `officeState?: OfficeAgentState | null` в `OfficeAgent`.

#### `src/features/office/screens/OfficeScreen.tsx`
Функция `deriveOfficeState(agent)`:
- `status === "error"` → `"error"`
- `awaitingUserInput` → `"waiting"`
- `status === "running" && thinkingTrace` → `"focused"`
- `status === "running"` → `"working"`
- `lastActivityAt < 5 мин` → `"focused"`
- иначе → `"idle"`

#### `src/features/retro-office/objects/agents.tsx`
Визуализация состояний в 3D:
```
idle       → #f59e0b  нет pulse ring
focused    → #06b6d4  медленный cyan ring + "🧠 focused"
working    → #22c55e  быстрый green ring + "⚡ working"
waiting    → #eab308  средний yellow ring + "⌛ waiting"
blocked    → #f97316  быстрый orange ring + "🚧 blocked"
overloaded → #ef4444  очень быстрый ring + "🔥 overloaded"
recovering → #a855f7  медленный purple ring + "🌿 recovering"
degraded   → #6b7280  очень медленный ring + "⚠️ degraded"
meeting    → #3b82f6  ровный blue ring + "👥 meeting"
error      → #ef4444  быстрый ring + "❌ error"
```

#### `src/features/retro-office/RetroOffice3D.tsx`
`AgentObjectModel` получает `officeState` prop.

---

## Текущая архитектура ZEUS Gateway

```
POST /webhook    ← Railway, GitHub, Sentry (HMAC verified)
POST /event      ← internal trigger (GATEWAY_SECRET auth)
GET  /agents     ← список агентов и статус
GET  /health     ← Railway healthcheck

WS ws://localhost:18789
  connect → handshake
  chat.send → callClaude() → Cerebras → Gemma4 → NVIDIA → Anthropic
  swarm.run → multi-agent coordinator
  swarm.auto → 20-agent full audit
```

---

## Открытые задачи (приоритет)

| ID | Задача | Приоритет | Файл |
|----|--------|-----------|------|
| **Z-EV-MNMVBDDE** | JWT auth в WebSocket handshake — код готов, нужен деплой | **P0** | `memory/agent-findings/` |
| — | Настроить WEBHOOK_SECRET в Railway для GitHub/Sentry/Railway | **P0** | Railway Dashboard |
| **Z-02** | RemoteAgentChatPanel — ответы агентов не видны в облаке | **P1** | `src/features/office/screens/OfficeScreen.tsx` |
| **Z-03 Phase 2** | Ready Player Me аватары через `useGLTF` | **P1** | `src/features/retro-office/objects/agents.tsx` |
| **Z-03 Phase 2** | Wire `agent.wake` events → явные state transitions | **P1** | `src/features/agents/state/gatewayRuntimeEventHandler.ts` |
| **Z-03 Phase 2** | `blocked/overloaded/recovering` state derivation | **P2** | `OfficeScreen.tsx → deriveOfficeState()` |
| — | Supabase storage policies аудит (аватары) | **P2** | Supabase Dashboard |
| — | CORS ограничить на edge-функциях | **P1** | Supabase Edge Functions |

---

## Ключевые файлы

### claw3d-fork (`C:\Users\user\Downloads\claw3d-fork\`)

| Файл | Роль |
|------|------|
| `server/zeus-gateway-adapter.js` | Весь ZEUS — LLM routing, user memory, event-driven, webhooks |
| `scripts/all-agents-go.js` | Запуск 39 агентов с competence check |
| `memory/session-context.md` | Общий мозг — обновляется после каждого audit |
| `memory/cto-kanban.md` | Канбан команды |
| `memory/users/yusif.md` | Профиль пользователя (создан автоматически) |
| `memory/debriefs/` | Дебрифы сессий |
| `memory/agent-findings/` | Findings агентов, включая JWT фикс |
| `docs/agent-state-model-spec.md` | **ПРОЧИТАЙ ПЕРВЫМ** — спек Life Simulator |
| `src/features/retro-office/core/types.ts` | OfficeAgent, OfficeAgentState типы |
| `src/features/retro-office/objects/agents.tsx` | 3D рендеринг агента — тело, анимации, state badge |
| `src/features/office/screens/OfficeScreen.tsx` | mapAgentToOffice, deriveOfficeState |
| `src/features/retro-office/RetroOffice3D.tsx` | Canvas, 3D сцена, AgentObjectModel |
| `src/features/agents/state/store.tsx` | AgentState, AgentStatus, Redux-like reducer |
| `.env` | Все ключи (не в git) |

### MindShift (`C:\Users\user\Downloads\mindshift\`)

- Production URL: `https://mind-shift-git-main-yusifg27-3093s-projects.vercel.app`
- Состояние: v1.0, Google Play ожидает верификации аккаунта
- Последний коммит: `3d229eb` (BATCH-2026-04-05-Z)

---

## Env vars (критичные)

```env
# C:\Users\user\Downloads\claw3d-fork\.env
CEREBRAS_API_KEY=csk-2d4v2xdfvkwrj4k4kfdkrdvr84hk6r9ptv2dfn8jxxhnmyvj
NVIDIA_API_KEY=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
GATEWAY_SECRET=zeus-dev-secret
NEXT_PUBLIC_GATEWAY_URL=ws://localhost:18789
OLLAMA_URL=http://localhost:11434
LOCAL_MODEL=qwen3:8b
AUTO_RUN_BATCH_SIZE=5
DAILY_DIGEST=true

# Нужно добавить в Railway:
WEBHOOK_SECRET_RAILWAY=<generate>
WEBHOOK_SECRET_GITHUB=<generate>
WEBHOOK_SECRET_SENTRY=<generate>
ANTHROPIC_API_KEY=<добавить — сейчас пустой, провайдер Cerebras primary>
```

---

## Как консультироваться с агентами

```javascript
// Node.js
const ws = new (require('ws'))('ws://localhost:18789');
ws.on('open', () => ws.send(JSON.stringify({type:'req',id:'c1',method:'connect',params:{}})));
ws.on('message', m => {
  const d = JSON.parse(m.toString());
  if(d.id==='c1') ws.send(JSON.stringify({
    type:'req', id:'q1', method:'chat.send',
    params:{ agentId:'architecture-agent', sessionKey:'new-session', message:'...' }
  }));
  if(d.type==='event' && d.event==='chat' && d.payload?.state==='final') {
    console.log(d.payload.message.content);
    ws.close();
  }
});
```

Агенты для консультации:
- `architecture-agent` — архитектура, технические решения
- `product-agent` — UX, продуктовые решения
- `security-agent` — безопасность
- `devops-sre-agent` — инфра, деплой
- `swarm-synthesizer` — синтез решений от всей команды

---

## Репозитории

- claw3d: `https://github.com/ganbaroff/Claw3D` (ветка `main`)
- MindShift: Vercel auto-deploy из `main`

---

*Хэндофф составлен с участием architecture-agent и swarm-synthesizer.*
*Следующий чат должен начать с чтения `docs/agent-state-model-spec.md` и консультации с агентами.*

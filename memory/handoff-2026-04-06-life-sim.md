# Life Simulator Handoff — 2026-04-06
*Для нового чата. Продолжение сессии после сжатия контекста.*

---

## Экосистема VOLAURA — краткая сводка

| Проект | Что это | Статус |
|--------|---------|--------|
| **MindShift** | ADHD-aware PWA (React + Supabase) | ✅ Production-ready v1.0, Google Play в ожидании верификации |
| **ZEUS Gateway** | Node.js WebSocket сервер — мозг агентов | ✅ Railway: `wss://zeus-gateway-production.up.railway.app` + pm2 локально |
| **claw3d / v0Laura** | 3D офис (Next.js + Three.js + React Three Fiber) | 🔧 В разработке |
| **Life Simulator** | Видимые состояния агентов в 3D офисе | ✅ Phase 1 реализован в этой сессии |

---

## ZEUS Gateway — что было сделано ранее (summary)

В предыдущей сессии (handoff-2026-04-06.md):
- Задеплоен на Railway, работает как pm2 процесс `zeus-gateway`
- Добавлен Cerebras Qwen3-235B как primary LLM (2000+ токен/с)
- Добавлен Gemma4 (локально через Ollama) как fallback
- Иерархия: `Cerebras → Gemma4 (Ollama) → NVIDIA NIM → Anthropic`
- Event-driven архитектура: агенты просыпаются на реальные события (webhook Railway/GitHub/Sentry)
- User memory system: `memory/users/{userId}.md`, читается в каждый промпт
- Session debriefer + drift detector (последние 3 дебрифа в каждый промпт)
- `POST /webhook` (HMAC verified), `POST /event` (GATEWAY_SECRET auth)
- `scripts/all-agents-go.js` — запуск 39 агентов с competence check

---

## Life Simulator — что реализовано в этой сессии (Z-03)

### Что было
В `claw3d-fork` уже была 3D-сцена (React Three Fiber + Three.js) с агентами в офисе.
Статус агентов был только 3-стейтный: `"working" | "idle" | "error"`.
Визуально: зелёный/золотой/красный кружок над аватаром.

### Что сделали — 10-стейтная модель Life Simulator

Реализован полный pipeline из 5 файлов:

#### 1. `src/features/retro-office/core/types.ts`
Добавлен тип `OfficeAgentState` (10 состояний из `agent-state-model-spec.md`):
```typescript
export type OfficeAgentState =
  | "idle"       // нет задачи, доступен
  | "focused"    // глубокая работа / недавно завершил
  | "working"    // активно обрабатывает запрос
  | "waiting"    // ждёт ввода пользователя / апрувала
  | "blocked"    // зависимость не решена
  | "overloaded" // слишком много задач
  | "recovering" // после ошибки или перегрузки
  | "degraded"   // частичная функциональность
  | "meeting"    // в standup / групповой сессии
  | "error";     // критическая ошибка
```
Добавлен `officeState?: OfficeAgentState | null` в `OfficeAgent`.

#### 2. `src/features/retro-office/objects/types.ts`
Добавлен `officeState?: OfficeAgentState | null` в `AgentModelProps`.

#### 3. `src/features/retro-office/objects/agents.tsx`
Добавлена визуализация состояний:
- **Цвет статус-точки** (dot) — уникальный для каждого из 10 состояний
- **Цвет и скорость pulse ring** — каждое состояние имеет свой ритм пульсации
- **State badge** — текстовый Billboard над nameplate: `"⚡ working"`, `"🧠 focused"`, `"⌛ waiting"` и т.д.
- Состояние `idle` — без badge, без pulse ring (агент спокойно стоит)

Маппинг состояний → цвета:
```
idle       → #f59e0b  (amber, нет ring)
focused    → #06b6d4  (cyan, медленный ring)
working    → #22c55e  (green, быстрый ring)
waiting    → #eab308  (yellow, средний ring)
blocked    → #f97316  (orange, быстрый ring)
overloaded → #ef4444  (red, очень быстрый ring)
recovering → #a855f7  (purple, медленный ring)
degraded   → #6b7280  (gray, очень медленный ring)
meeting    → #3b82f6  (blue, ровный ring)
error      → #ef4444  (red, быстрый ring)
```

#### 4. `src/features/office/screens/OfficeScreen.tsx`
Добавлена функция `deriveOfficeState(agent: AgentState): OfficeAgentState`:
```typescript
- status === "error" → "error"
- awaitingUserInput → "waiting"
- status === "running" && thinkingTrace > 20 chars → "focused" (deep thinking)
- status === "running" → "working"
- lastActivityAt < 5 min ago → "focused" (recently completed)
- else → "idle"
```
`mapAgentToOffice` теперь включает `officeState` в каждый `OfficeAgent`.

#### 5. `src/features/retro-office/RetroOffice3D.tsx`
`AgentObjectModel` теперь получает `officeState` prop.

---

## Что сделать дальше (следующие шаги)

### Z-EV-MNMVBDDE (P0) — задеплоить JWT в WebSocket handshake
Код готов в `memory/agent-findings/`. Нужен деплой на Railway.

### Z-02 (P1) — RemoteAgentChatPanel
Ответы агентов не отображаются в облаке (`RemoteAgentChatPanel`).
Файл: `src/features/office/screens/OfficeScreen.tsx` — поиск `RemoteAgentChatPanel`.

### Life Simulator Phase 2 (P1)
1. **Ready Player Me аватары** — заменить процедурные аватары на RPM глб-модели
   - Интеграция: `https://readyplayer.me/` (iframe embed для создания + .glb URL)
   - Загрузка в Three.js через `useGLTF` из `@react-three/drei`
   - Файл для изменения: `src/features/retro-office/objects/agents.tsx`
   - Поле: `avatarUrl` уже есть в `AgentStoreSeed` (store.tsx:43) и `OfficeAgent`

2. **Wire ZEUS wake events к officeState**
   - ZEUS gateway отправляет `{ type: "event", event: "agent.wake", payload: { agentId } }`
   - Нужно: в `gatewayRuntimeEventHandler.ts` добавить обработку этого события
   - Или: добавить `setAgentOfficeState` action в store + dispatch из event handler
   - Текущая деривация уже работает через `status === "running"` — но wake-to-idle переход
     (агент проснулся, сделал задачу, уснул) нужно сделать явным

3. **`blocked` / `overloaded` / `recovering` состояния**
   - Сейчас деривация покрывает только `idle/focused/working/waiting/error`
   - `blocked`: когда агент застрял (нет ответа >2мин при working)
   - `overloaded`: когда queue > 3 задач
   - `recovering`: через N секунд после `error`

4. **Standup meeting state** (`meeting`)
   - В OfficeScreen уже есть `standupMeeting` — нужно добавить в `deriveOfficeState`

### Настройка вебхуков Railway (P1)
```
WEBHOOK_SECRET_RAILWAY=<secret>
WEBHOOK_SECRET_GITHUB=<secret>
WEBHOOK_SECRET_SENTRY=<secret>
```
Установить в Railway Dashboard → Variables.

---

## Ключевые файлы проекта

### claw3d-fork (`C:\Users\user\Downloads\claw3d-fork\`)

| Файл | Что делает |
|------|-----------|
| `server/zeus-gateway-adapter.js` | ZEUS gateway — 1500+ строк, все агенты |
| `src/features/retro-office/core/types.ts` | OfficeAgent, OfficeAgentState, RenderAgent типы |
| `src/features/retro-office/objects/agents.tsx` | 3D рендеринг агента — тело, анимация, nameplate, state badge |
| `src/features/office/screens/OfficeScreen.tsx` | Главный экран офиса, mapAgentToOffice, deriveOfficeState |
| `src/features/retro-office/RetroOffice3D.tsx` | 3D сцена — Canvas, sceneAgents, AgentObjectModel |
| `src/features/agents/state/store.tsx` | Redux-like store — AgentState, AgentStatus, dispatch |
| `src/lib/office/eventTriggers.ts` | Маппинг gateway событий → office анимации |
| `src/lib/office/gatewayPresence.ts` | Presense snapshot из gateway |
| `memory/handoff-2026-04-06.md` | Полный хэндофф предыдущей сессии (ZEUS gateway) |
| `docs/agent-state-model-spec.md` | Спек 10-стейтной модели (ПРОЧИТАЙ ПЕРВЫМ) |
| `.env` | Ключи — CEREBRAS_API_KEY, NVIDIA_API_KEY, GATEWAY_SECRET |

### Env vars (локально)
```env
CEREBRAS_API_KEY=csk-2d4v2xdfvkwrj4k4kfdkrdvr84hk6r9ptv2dfn8jxxhnmyvj
NVIDIA_API_KEY=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
GATEWAY_SECRET=zeus-dev-secret
NEXT_PUBLIC_GATEWAY_URL=ws://localhost:18789
OLLAMA_URL=http://localhost:11434
LOCAL_MODEL=qwen3:8b
```

### Репозиторий
`https://github.com/ganbaroff/Claw3D` (форк, ветка `main`)

---

## Правила работы (критично!)

1. **НИКОГДА не решай один** — всегда консультируйся с агентами через ZEUS gateway
2. **Агенты — команда, не боты** — живые персонажи с памятью и состоянием
3. **Протокол CEO-advisor** — анализируй перед реализацией, предлагай идеи не жди когда попросят
4. **pm2** управляет gateway — `pm2 restart zeus-gateway --update-env` (не `kill`)
5. **tsc --noEmit** перед любым коммитом

---

## Как консультироваться с агентами

```javascript
const ws = new WebSocket('ws://localhost:18789');
ws.onopen = () => ws.send(JSON.stringify({type:'req',id:'c1',method:'connect',params:{}}));
// Затем:
ws.send(JSON.stringify({
  type:'req', id:'q1', method:'chat.send',
  params:{ agentId:'architecture-agent', sessionKey:'life-sim', message:'...' }
}));
```

*Документ создан после реализации Life Simulator Phase 1 (10-state model)*

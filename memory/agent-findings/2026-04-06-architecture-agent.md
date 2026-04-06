# Architecture Agent — автономный аудит
**Дата:** 2026-04-06
**runId:** auto-1775458739432

# Z-08: Проблемы в связке gateway↔офис↔v0Laura при масштабировании

**Агент:** architecture-agent  
**Дата:** 2026-04-06  
**Приоритет:** P0

---

## Проблема 1: `Dockerfile.gateway` — устаревшая база и отсутствие multi-stage build

**Файл:** `Dockerfile.gateway`  
**Строка:** 1 (`FROM node:18-alpine`)  

**Поведение:**  
Используется `node:18-alpine`, который:
- Уже не поддерживается (Node.js 18 EOL: 2025-04-30)
- Содержит известные уязвимости в системных библиотеках (musl, apk)
- Не оптимизирован по размеру — образ тянет ~120MB

**Решение:**  
Перейти на multi-stage build с `node:20-slim` и явной очисткой кэша:

```dockerfile
# === Сборка ===
FROM node:20-slim AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production && npm cache clean --force

# === Финальный образ ===
FROM node:20-slim AS final
WORKDIR /app
COPY --from=builder /app/node_modules ./node_modules
COPY . .
EXPOSE 3000

# Удалить ненужные файлы
RUN rm -rf /tmp/* /var/lib/apt/lists/* node_modules/.vite

USER node
CMD ["node", "dist/main.js"]
```

**Приоритет:** P0 — уязвимость и холостой вес образа при 100+ инстансах.

---

## Проблема 2: `gateway` — отсутствие health-check в `docker-compose.yml`

**Файл:** `docker-compose.yml`  
**Строка:** нет секции `healthcheck` для сервиса `gateway`

**Поведение:**  
При развертывании 100 инстансов на Railway/Kubernetes, оркестратор не может определить, жив ли контейнер. Это приводит к:
- Раннему трафику на неготовый инстанс
- Ложным "успехам" деплоя
- Каскадным падениям при холодном старте

**Решение:**  
Добавить health-check:

```yaml
services:
  gateway:
    # ...
    healthcheck:
      test: ["CMD", "node", "-e", "require('http').get('http://localhost:3000/health', (r) => {if (r.statusCode !== 200) process.exit(1)})"]
      interval: 10s
      timeout: 5s
      retries: 3
      start_period: 30s
```

**Приоритет:** P0 — без этого оркестрация ненадёжна.

---

## Проблема 3: `wss://zeus-gateway` — stateful сессии без шардирования

**Файл:** `src/gateway/ws.gateway.ts`  
**Строка:** 45 (`const clients = new Map()`)

**Поведение:**  
Сессии хранятся в памяти. При 100 concurrent users и балансировке нагрузки:
- Подключение к разным инстансам = разрыв сессии
- Восстановление сессии не реализовано
- `RemoteAgentChatPanel` теряет сообщения при переподключении

**Решение:**  
Заменить in-memory на Redis Pub/Sub с fallback при отсутствии Redis:

```ts
// src/gateway/ws.gateway.ts
const redis = new Redis(process.env.REDIS_URL);
const clients = new Map<string, WebSocket>(); // fallback

// При подключении
ws.on('message', async (data) => {
  const msg = JSON.parse(data);
  if (msg.type === 'register') {
    if (redis) {
      await redis.publish('ws:register', JSON.stringify({ id: msg.userId, wsId: ws.id }));
    }
  }
});
```

Добавить `REDIS_URL` в `.env.example` и Railway.

**Приоритет:** P0 — сейчас система не масштабируется.

---

## Проблема 4: `office` → `gateway` —
# CTO Kanban — ZEUS / v0Laura
*Обновляется каждую сессию. Агенты читают это автоматически.*

---

## 🔴 БЛОКЕРЫ (сделать до всего)

| # | Задача | Кто | Дата |
|---|--------|-----|------|
| — | пока чисто | — | — |

---

## 🟡 В РАБОТЕ

| # | Задача | Агент | Статус |
| Z-EV-MNMVBDDE | [sentry] error.unhandled → Security Agent | security-agent | P1 |
|---|--------|-------|--------|
| Z-02 | RemoteAgentChatPanel — ответы не отражаются в облаке | architecture-agent | Не начато |
| Z-03 | Life Sim / Ready Player Me аватары в claw3d | product-agent | Не начато |
| Z-05 | Agent memory per-session | architecture-agent | Не начато |
| Z-06 | Autonomous coordinator mode | architecture-agent | Не начато |

---

## 🟢 BACKLOG

| # | Задача | Приоритет | Агент |
|---|--------|-----------|-------|
| Z-07 | VOLAURA↔MindShift REST API интеграция | P3 | product-agent |
| M-02 | MindShift Phase 3 If-Then Intentions | P2 | product-agent |

---

## ✅ СДЕЛАНО

| Задача | Дата |
|--------|------|
| Z-04: zeus-gateway задеплоен на Railway | 2026-04-06 |
| Z-04: wss://zeus-gateway-production.up.railway.app — живой | 2026-04-06 |
| Z-01: swarm.run coordinator + синтез Nemotron 253B | 2026-04-06 |
| 39 агентов получили характер + язык + анти-корпоративный промпт | 2026-04-06 |
| `<think>` теги убраны (visibleContent filter) | 2026-04-06 |
| Shared context (session-context.md) для всех агентов | 2026-04-06 |
| 3D офис задеплоен на Railway | 2026-04-06 |

---

## 📋 ПРАВИЛА ДЛЯ АГЕНТОВ (читать при автономной работе)

1. Бери таски из раздела "В РАБОТЕ" — смотри свой агент в колонке "Агент"
2. Когда берёшь таск — не жди подтверждения. Исследуй → предложи решение → запиши вывод
3. Если нужен другой агент — скажи координатору (swarm.run)
4. Все находки и решения записывай в memory/agent-findings/
5. Никогда не деплоишь сам — только предлагаешь. Деплой = CEO решение

---

## 📊 МЕТРИКИ

| Агент | Последний запуск | Статус |
|-------|-----------------|--------|
| security-agent | 2026-04-06 | llama-3.3-70b ✅ |
| architecture-agent | 2026-04-06 | llama-3.3-70b ✅ |
| product-agent | 2026-04-06 | llama-3.3-70b ✅ |
| Остальные 36 | — | Не тестированы |

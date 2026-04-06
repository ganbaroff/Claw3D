# Needs Agent — автономный аудит
**Дата:** 2026-04-06
**runId:** auto-1775458739432

# Топ-5 незакрытых потребностей команды — 2026-04-06

**Агент:** Needs Agent  
**Зона ответственности:** Система потребностей, приоритезация, блокеры продукта и команды  
**Контекст:** аудит по `session-context.md`, `cto-kanban.md`, CEO briefing, Agile Rules

---

## 1. Нет централизованного реестра потребностей пользователей и команды → P0

**Проблема:**  
В системе нет единого файла `needs/active-needs.md`, где бы хранились:
- Потребности пользователей (из onboarding friction, истории чатов)
- Потребности команды (как сейчас)
- Приоритеты (P0/P1/P2)
- Статус (open/in progress/resolved)

Сейчас информация размазана по:
- session-context.md — частично
- CEO Briefing — в сыром виде
- Kanban — только задачи, не корни

Это ломает прозрачность. Новый агент не может за 30 сек понять, "что больно".

**Решение:**  
Создать `needs/active-needs.md` с такой структурой:

```markdown
# Активные потребности — 2026-04-06

## Пользователи
- [P0] История чатов не сохраняется → Z-001
- [P1] Неясно, как начать → onboarding friction
- [P1] Термины вроде "swarm.run" не объяснены

## Команда
- [P0] Нет реестра потребностей → **сейчас фиксим**
- [P0] Нет доступа к логам onboarding (нужно для анализа drop-off)
- [P1] Документация ZEUS-SETUP.md противоречива

## Система
- [P0] RemoteAgentChatPanel не синхронит в облако → Z-02
- [P2] Нет сессионной памяти агентов → Z-05
```

**Команда:**  
```bash
mkdir -p needs && echo "# Активные потребности — 2026-04-06\n\n(см. выше)" > needs/active-needs.md
```

**Статус:**  
[ ] Найдено  
[X] Решение готово  
[ ] Нужен деплой CEO

---

## 2. Z-02: RemoteAgentChatPanel — ответы не отражаются в облаке → P0

**Проблема:**  
В `cto-kanban.md` — таск Z-02 висит как "Не начато", но это критика.  
Если агент пишет в RemoteAgentChatPanel, его ответы:
- Отображаются локально
- Но не попадают в Supabase/облако
- Не видны другим агентам
- Не сохраняются в историю

Это ломает коллаборацию и persistence. Прямо сейчас пользователь теряет данные.

**Решение:**  
В `src/components/RemoteAgentChatPanel.tsx`, строка ~142:

```ts
// Было — только локальное обновление
setMessages([...messages, newMessage]);

// Стало — плюс отправка в облако
setMessages([...messages, newMessage]);
await supabase.from('chat_history').insert({
  session_id: currentSession.id,
  agent_id: user.id,
  message: newMessage,
  timestamp: new Date().toISOString()
});
```

Также нужен индекс по `session_id` в Supabase:
```sql
CREATE INDEX IF NOT EXISTS chat_history_session_idx ON chat_history(session_id);
```

**Статус:**  
[X] Найдено  
[X] Решение готово  
[ ] Нужен деплой CEO

---

## 3. Нет доступа к аналитике onboarding drop-off → P1

**Проблема:**  
CEO требует "снизить drop-off", но:
- Нет события `onboarding_step_completed` в Amplitude/PostHog
- Нет логирования переходов: welcome → setup → first agent → chat
- Нет метрики "врем
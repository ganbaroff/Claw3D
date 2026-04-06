# Data Engineer Agent — автономный аудит
**Дата:** 2026-04-06
**runId:** auto-1775458739432

# Z-001: История разговоров не персистится — теряется при рестарте  
**Агент:** Data Engineer Agent  
**Дата:** 2026-04-06  
**Приоритет:** P0  

## Проблема  
История разговоров хранится **исключительно в оперативной памяти** бэкенда (`zeus-gateway`).  

Файл: `zeus-gateway/src/services/SessionService.ts`  
Строка: ~142  
```ts
this.sessions.set(sessionId, {
  messages: [],
  agents: [],
  createdAt: new Date(),
});
```

При рестарте сервера (например, на Railway при бездействии или деплое) — все сессии **полностью теряются**.  
Нет интеграции с Supabase или любым другим persistent storage.  
Нет fallback-логики на localStorage в браузере.  

Поведение: пользователь пишет агенту, перезагружает страницу — **вся история пропала**. Это P0, потому что убивает доверие и делает продукт нежизнеспособным для повторных визитов.

## Решение  

### 1. Добавить Supabase-таблицу для истории сообщений  
Нужна таблица `conversation_messages` в Supabase:  

```sql
CREATE TABLE conversation_messages (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  session_id TEXT NOT NULL,
  role TEXT NOT NULL, -- 'user', 'agent', 'system'
  content TEXT NOT NULL,
  agent_id TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  INDEX (session_id, created_at)
);
```

### 2. Модифицировать SessionService для синхронизации с Supabase  
Файл: `zeus-gateway/src/services/SessionService.ts`  

Добавить при инициализации сессии:  
```ts
async loadMessagesFromDB(sessionId: string): Promise<Message[]> {
  const { data } = await supabase
    .from('conversation_messages')
    .select('role, content, agent_id, created_at')
    .eq('session_id', sessionId)
    .order('created_at', { ascending: true });
  
  return data?.map(d => ({ role: d.role, content: d.content, agentId: d.agent_id })) || [];
}
```

При добавлении нового сообщения — писать в БД:  
```ts
async addMessage(sessionId: string, message: Message) {
  // ... существующая логика
  this.sessions.get(sessionId)?.messages.push(message);

  // + новая: запись в Supabase
  await supabase.from('conversation_messages').insert({
    session_id: sessionId,
    role: message.role,
    content: message.content,
    agent_id: message.agentId,
  });
}
```

### 3. На стороне клиента — восстановление сессии по `sessionId` из localStorage  
Файл: `mindshift-web/src/hooks/useSession.ts`  
```ts
const sessionId = localStorage.getItem('sessionId') || generateSessionId();
localStorage.setItem('sessionId', sessionId);
```

Передавать `sessionId` в `zeus-gateway` при подключении по WebSocket.  

### 4. На бэке — при подключении клиента с `sessionId` — подтягивать историю  
Файл: `zeus-gateway/src/ws/handlers.ts`  
```ts
if (sessionId) {
  const history = await sessionService.loadMessagesFromDB(sessionId);
  socket.send(JSON.stringify({ type: 'history', payload: history }));
}
```

На фронте — вставлять `history` в локальный state.

## Статус  
[ ] Найдено  
[✓] Решение готово  
[ ] Нужен деплой CEO  

---

**Дополнительно:**  
- Нужен файл `supabase/migrations/0003_create_conversation_messages.sql` — его сейчас нет. Требуется создать.  
- Нужно добавить `supabase` клиент в `zeus-gateway` — сейчас там только `@supabase/supabase-js`, но нет инициализации.  

Это не "улучшение" — это критическая дыра. Без этого история — фикция.  
Если CEO не деплоит — мы строим приложение на песке.
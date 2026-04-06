# QA Engineer — автономный аудит
**Дата:** 2026-04-06
**runId:** auto-1775458739432

# Z-08: Нет обработки ошибок и таймаутов в WebSocket-шлюзе и AI-вызовах  
**Агент:** qa-engineer  
**Дата:** 2026-04-06  
**Приоритет:** P0  

## Проблема  
В `zeus-gateway` отсутствует базовая защита на уровне обработки сообщений:  

1. **WebSocket-обработчики не ловят исключения**  
   - Файл: `services/websocket/handleMessage.ts`  
   - Строка: ~34 — `switch (data.type)`  
   - Поведение: если приходит битый JSON или неизвестный `type`, ошибка вылетает наружу, разрывая соединение без лога.  

2. **AI-вызовы без таймаутов и fallback’ов**  
   - Файл: `ai/edge-proxy.ts`  
   - Строка: ~18 — `fetch(AI_ENDPOINT, { method: 'POST', body: JSON.stringify(input) })`  
   - Поведение: при зависании AI — висит соединение, пользователь ждёт вечно. Нет fallback-ответа, как требует guardrails.md #7.  

3. **Нет валидации входных данных в WebSocket**  
   - Файл: `services/websocket/validate.ts` — отсутствует  
   - Поведение: любой клиент может слать `session_id: null`, `user_id: "abc123<script>"`, payload без `type`.  

4. **AI-запросы не учитывают локаль пользователя**  
   - Файл: `ai/edge-proxy.ts`  
   - Строка: ~12 — отсутствует передача `navigator.language` из входящего запроса  
   - Нарушение guardrails.md #7: "All AI prompts must include the user's `navigator.language` locale"  

5. **Нет rate limit tracking на уровне gateway**  
   - Файл: `middleware/rateLimit.ts` — отсутствует  
   - Поведение: пользователь может спамить AI-запросы, обходя лимит 10/день.  

---

## Решение  

### 1. Добавить try/catch в обработчик сообщений  
```ts
// services/websocket/handleMessage.ts
export async function handleMessage(ws: WebSocket, rawMessage: string) {
  let data;
  try {
    data = JSON.parse(rawMessage);
  } catch (err) {
    log.warn('Invalid JSON', { rawMessage });
    ws.send(JSON.stringify({ error: 'Invalid JSON', code: 'BAD_JSON' }));
    return;
  }

  try {
    switch (data.type) {
      // ...
    }
  } catch (err) {
    log.error('Handler failed', { type: data.type, err });
    ws.send(JSON.stringify({ 
      error: 'Internal error', 
      code: 'INTERNAL' 
    }));
  }
}
```

### 2. Добавить таймаут и fallback в AI-прокси  
```ts
// ai/edge-proxy.ts
const FALLBACK_RESPONSES = {
  en: "I'm here. Let's pause and regroup.",
  ru: "Я рядом. Давай сделаем паузу и соберёмся.",
  es: "Estoy aquí. Tomemos un momento."
};

async function withTimeout(promise: Promise<any>, ms: number) {
  const timeout = new Promise((_, reject) => 
    setTimeout(() => reject(new Error('TIMEOUT')), ms)
  );
  return Promise.race([promise, timeout]);
}

export async function proxyAICall(input: any, lang: string) {
  const fallback = FALLBACK_RESPONSES[lang] || FALLBACK_RESPONSES.en;

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000);

    const res = await fetch(AI_ENDPOINT, {
      method: 'POST',
      body: JSON.stringify({ ...input, lang }), // ← lang передаётся
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!res.ok) throw new Error(`AI error: ${res.status}`);
    return await res.json();
  } catch (err) {
    if (err.name === 'AbortError' || err.message === 'TIMEOUT') {
      log.warn('AI request timed out', { input });
    } else {
      log.error('AI request failed', { err });
    }
    return { text
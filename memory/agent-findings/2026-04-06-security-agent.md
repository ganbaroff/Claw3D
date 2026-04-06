# Security Agent — автономный аудит
**Дата:** 2026-04-06
**runId:** auto-1775458739432

# Z-08: service_role ключ в zeus-gateway-adapter.js — прямая утечка админ-доступа  
**Агент:** security-agent  
**Дата:** 2026-04-06  
**Приоритет:** P0  

## Проблема  
В `server/zeus-gateway-adapter.js` на строке 42 используется `supabaseServiceRoleKey` для инициализации Supabase клиента:  

```js
const supabase = createClient(supabaseUrl, supabaseServiceRoleKey)
```  

Это **service_role** ключ, а не анонимный (`anon`) или пользовательский JWT.  
Он даёт полный bypass всех RLS политик.  
Если этот файл выполняется на стороне сервера — ок, но если есть хоть малейший шанс, что он попадёт в клиентскую сборку (например, из-за неправильного tree-shaking или импорта в React-компоненте) — это катастрофа.  

Но хуже:  
- WS-эндпоинт `/ws/zeus` принимает `token`, но **не проверяет его валидность через Supabase Auth**.  
- Вместо этого он использует `supabaseServiceRoleKey` для всех операций — значит, любой, кто подключится с любым токеном (или без него), получит полный доступ к БД.  

Это не уязвимость — это **открытая дверь с надписью "воруй данные"**.  

## Решение  
1. Убрать `supabaseServiceRoleKey` из адаптера.  
2. Заменить на `supabaseAnonKey` + валидацию JWT через `supabase.auth.getUser(token)`.  
3. Добавить RLS-совместимый клиент.  

**Фикс для `server/zeus-gateway-adapter.js`:**  

```diff
- import { createClient } from '@supabase/supabase-js'
+ import { createClient } from '@supabase/supabase-js'
+ import { supabaseAnonKey, supabaseUrl } from '@/lib/supabase/config'

- const supabase = createClient(supabaseUrl, supabaseServiceRoleKey)
+ const supabase = createClient(supabaseUrl, supabaseAnonKey)
```

**Фикс для обработки подключения в `/pages/api/ws/zeus.ts` (если файл существует):**  

```js
export default async function handler(req, res) {
  const token = req.headers.authorization?.replace('Bearer ', '')
  if (!token) return res.status(401).json({ error: 'No token' })

  const { data: { user }, error } = await supabase.auth.getUser(token)
  if (error || !user) return res.status(401).json({ error: 'Invalid token' })

  // Передаём user.id в WS-сессию
  const ws = new WebSocket(req.socket, res, { userId: user.id })
}
```

**Если `/pages/api/ws/zeus.ts` не существует — срочно создать.** Сейчас WS-эндпоинт работает без аутентификации вообще.  

## Статус  
[ ] Найдено  
[ ] Решение готово  
[ ] Нужен деплой CEO  

---

# Z-09: Открытый CORS в zeus-gateway-adapter.js  
**Агент:** security-agent  
**Дата:** 2026-04-06  
**Приоритет:** P0  

## Проблема  
В `server/zeus-gateway-adapter.js` нет CORS-настроек.  
Если этот адаптер запускается как standalone-сервер (например, на Railway), он принимает запросы **с любого origin**.  

Нет:  
- `Access-Control-Allow-Origin`  
- `Access-Control-Allow-Credentials: true`  
- Проверки `Origin` в WS-апгрейде  

Это позволяет любому сайту подключиться к WS и, при текущей уязвимости с `service_role`, украсть данные пользователей.  

## Решение  
Добавить строгий CORS:  

```js
const allowedOrigins = [
  'https://mindshift.voulaura.ai',
  'https://voulaura.ai',
  'http://localhost:3000'
]

const origin
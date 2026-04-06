# Analytics & Retention Agent — автономный аудит
**Дата:** 2026-04-06
**runId:** auto-1775458739432

# M-03: Аудит событийной модели для MindShift Office  
**Агент:** Analytics & Retention Agent  
**Дата:** 2026-04-06  
**Приоритет:** P1  

## Проблема  
В системе нет определённой event-таксономии для офиса. В `analytics_events` таблице есть схема, но нет:  
- конкретных event names,  
- триггеров в коде,  
- сопоставления с D0/D1/D7 retention hooks,  
- привязки к ADHD-безопасным UX-паттернам (например, без шама, без красного цвета, без "провала").  

Сейчас невозможно измерять:  
- успешность онбординга,  
- вовлечённость в core loop (планирование → выполнение → рефлексия),  
- удержание по дням,  
- влияние агентов на поведение.  

Это блокирует рост и персонализацию — P1.  

## Решение  

### 1. Базовая схема события  
```sql
-- Уже есть: analytics_events
-- Добавить индексы:
CREATE INDEX IF NOT EXISTS idx_event_user_time ON analytics_events(user_id, event_timestamp);
CREATE INDEX IF NOT EXISTS idx_event_name ON analytics_events(event_name);
```

### 2. Критические события: D0 Onboarding Flow  
| Event Name | Properties | Trigger Point | Файл / Строка |  
|------------|------------|---------------|----------------|  
| `onboarding_started` | `{}` | Пользователь открыл онбординг в первый раз | `src/onboarding/OnboardingFlow.tsx`, `useEffect(() => { if (firstVisit) track('onboarding_started') })` |  
| `onboarding_step_completed` | `{ step: 'intro' \| 'goals' \| 'focus_mode_intro' }` | После завершения шага | Тот же файл, `track('onboarding_step_completed', { step })` после валидации |  
| `onboarding_completed` | `{ completed_at: ISO, time_spent_sec: number }` | После последнего шага и редиректа в дашборд | `navigate('/dashboard')` + track |  
| `user_avatar_created` | `{ style: 'claw3d' \| 'rpg' \| 'minimal', autonomy_level: 1-5 }` | После сохранения аватара | `AvatarEditor.tsx`, после успешного POST |  

> Почему: нужно видеть, где падает D0 retention. Если 70% не доходят до `onboarding_completed` — фокус на UX.

### 3. Core Loop Events  
| Event Name | Properties | Trigger Point | Файл / Строка |  
|------------|------------|---------------|----------------|  
| `task_created` | `{ type: 'single' \| 'recurring', has_reminder: boolean, time_to_create_sec: number }` | После сохранения задачи | `TaskEditor.tsx`, после `supabase.from('tasks').insert()` |  
| `focus_session_started` | `{ mode: 'pomodoro' \| 'deep' \| 'quick', scheduled: boolean }` | По нажатию "Start" | `FocusTimer.tsx`, `handleStart()` |  
| `focus_session_completed` | `{ duration_sec: number, interrupted: boolean, tasks_completed_count: number }` | По окончанию или остановке | Тот же файл, в `onFinish` и `onStop` |  
| `daily_review_opened` | `{ day: ISO, auto_opened: boolean }` | При открытии рефлексии | `DailyReview.tsx`, `useEffect(() => track(...))` |  
| `review_completed` | `{ mood: 1-5, energy: 1-5, completed_tasks_count: number }` | После отправки формы | `onSubmit` в рефлексии |  

> Почему: это core retention loop. Нужно видеть, кто заходит в фокус, кто завершает, кто делает ревью. Без этого нет D1/D7.

### 4. Агент-интеракции (P1)  
| Event Name | Properties | Trigger Point | Файл / Строка |  
|------------|------------|---------------|----------------|  
| `agent_chat_opened` | `{ agent_id: string, context: 'onboarding' \| 'task_help' \| 'review' }` | По кли
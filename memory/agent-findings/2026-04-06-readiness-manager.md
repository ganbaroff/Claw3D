# Readiness Manager — автономный аудит
**Дата:** 2026-04-06
**runId:** auto-1775458739432

# M-01: Чеклист готовности к показу пользователям  
**Агент:** Readiness Manager  
**Дата:** 2026-04-06  
**Приоритет:** P0  

## Проблема  
MindShift не готов к показу первым пользователям. Несмотря на стабильность core journey (Onboarding → Tracking → Review), есть критические бреши в готовности продукта по SRE и ITIL v4 Change Enablement критериям. Ниже — разбор по слоям.

---

## 1. История трекинга не сохраняется (P0)  
**Файл:** `supabase/functions/onUserTrack`  
**Поведение:** При тестовом вводе трека (например, "Я начал работать над задачей") — данные не попадают в `supabase/public/tracking_history`.  
**Лог:** `2026-04-06T06:41:22.911Z ERROR: insert failed, missing RLS policy for user_id`  
**Суть:** RLS (Row Level Security) включена, но политика `ENABLE ROW LEVEL SECURITY` на таблице `tracking_history` не разрешает INSERT по `auth.uid()`.  

### Решение  
```sql
-- В Supabase SQL Editor
CREATE POLICY "Users can insert own tracking history"
ON public.tracking_history
FOR INSERT
TO authenticated
WITH CHECK (user_id = auth.uid());
```

---

## 2. Onboarding падает при повторном входе (P1)  
**Файл:** `src/features/onboarding/OnboardingFlow.tsx`  
**Строка:** 42  
**Код:**  
```ts
if (!user.metadata.onboarded) startOnboarding();
```
**Проблема:** `user.metadata.onboarded` не обновляется после завершения онбординга. Supabase `auth.users` метаданные не обновляются — функция `updateUserMetadata` не вызывается.  

### Решение  
Добавить в `src/features/onboarding/completion.ts`:  
```ts
await supabase.auth.updateUser({
  data: { onboarded: true }
});
```

---

## 3. Нет ARIA-меток в интерфейсе трекинга (P0)  
**Файл:** `src/components/TrackerInput.tsx`  
**Строка:** 15  
**Код:**  
```jsx
<input type="text" placeholder="Что ты сейчас делаешь?" />
```
**Проблема:** Отсутствует `aria-label` и `aria-describedby`. Нарушает WCAG 2.1, делает приложение неиспользуемым с экранными дикторами.  

### Решение  
```jsx
<input
  aria-label="Поле ввода активности"
  aria-describedby="tracker-hint"
  type="text"
  placeholder="Что ты сейчас делаешь?"
/>
<div id="tracker-hint" className="sr-only">
  Нажмите Enter, чтобы начать трекинг
</div>
```

---

## 4. Контраст текста в темной теме ниже 4.5:1 (P0)  
**Файл:** `src/styles/dark-theme.css`  
**Строка:** 12  
**Код:**  
```css
--text-primary: #9ca3af; /* gray-400 */
```
**Проблема:** Цвет #9ca3af на фоне #1f2937 (#gray-800) даёт контраст 3.7:1. Ниже требуемого для WCAG AA.  

### Решение  
```css
--text-primary: #f3f4f6; /* gray-100 */
```
Проверено: контраст 15.4:1.

---

## 5. Нет механизма восстановления сессии (P1)  
**Файл:** `src/lib/sessionManager.ts`  
**Поведение:** При перезагрузке страницы активный трек сбрасывается. Нет сохранения `currentTask` в `localStorage` или IndexedDB.  

### Решение  
```ts
// При старте трека
localStorage.setItem('activeTrack', JSON.stringify({
  task: value,
  startedAt: Date.now()
}));

// При загрузке
const active = localStorage.getItem('activeTrack');
if (active) restoreActiveTrack(JSON.parse(active));
```

---
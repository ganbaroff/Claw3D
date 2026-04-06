# Accessibility Auditor — автономный аудит
**Дата:** 2026-04-06
**runId:** auto-1775458407297

**АУДИТ WCAG 2.1 AA: 2026-04-06**  
**Приоритеты:** P0 (блокирует доступность), P1 (блокирует рост), P2 (оптимизация)  

---

### **P0: Недоступные элементы (keyboard navigation)**  
**Файл:** `src/components/Modals/TaskModal.tsx`  
**Строка:** 22  
**Поведение:** Модальное окно без фокус-трейпа (focus trap), не позволяет управлять клавиатурой.  
**Решение:**  
```tsx
// Добавить focus trap для модального окна
useEffect(() => {
  const modal = modalRef.current;
  if (modal) {
    modal.focus({ preventScroll: true });
  }
}, [isModalOpen]);
```
**Приоритет:** P0  

---

### **P0: Недостаточная контрастность (color contrast)**  
**Файл:** `src/components/
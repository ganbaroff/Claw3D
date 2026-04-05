#!/usr/bin/env node
// ALL AGENTS — competence check first, then full audit
// Phase 1: Verify each agent responds intelligently (not generic)
// Phase 2: Qualified agents get real tasks

const WebSocket = require("fs") && require("ws");
const fs = require("fs");
const path = require("path");

const GW_URL = process.env.ZEUS_GATEWAY_URL || "ws://localhost:18789";
const findingsDir = path.join(__dirname, "..", "memory", "agent-findings");
fs.mkdirSync(findingsDir, { recursive: true });
const date = new Date().toISOString().slice(0, 10);

// Competence check: one sharp question per agent
const COMPETENCE_CHECKS = {
  "security-agent":               "Назови одну конкретную уязвимость в Node.js WebSocket серверах которую ты умеешь находить и фиксить.",
  "architecture-agent":           "Чем отличается горизонтальное масштабирование WebSocket сервера от вертикального и что лучше для ZEUS?",
  "product-agent":                "Как измерить 'aha moment' для пользователя 3D AI офиса? Конкретная метрика.",
  "needs-agent":                  "Назови одну незакрытую потребность команды которую ты видишь прямо сейчас.",
  "qa-engineer":                  "Какой тип тестирования наиболее критичен для WebSocket real-time систем?",
  "growth-agent":                 "Один конкретный способ ускорить time-to-first-value для нового пользователя в AI офисе.",
  "risk-manager":                 "Самый критичный технический риск ZEUS gateway в продакшене прямо сейчас.",
  "readiness-manager":            "Три конкретных критерия готовности к public launch.",
  "cultural-intelligence-strategist": "Один пример как азербайджанская культура влияет на UX решения в B2B продукте.",
  "accessibility-auditor":        "Какой WCAG критерий чаще всего нарушается в 3D веб-приложениях?",
  "behavioral-nudge-engine":      "Как ADHD влияет на то как пользователь взаимодействует с AI агентами в офисе?",
  "assessment-science-agent":     "Чем IRT модель лучше классического scoring для оценки компетенций?",
  "analytics-retention-agent":    "Какая метрика лучше всего предсказывает churn в AI productivity tools?",
  "devops-sre-agent":             "Как Railway обрабатывает zero-downtime deployments для WebSocket серверов?",
  "financial-analyst-agent":      "Сколько примерно стоит 1000 токенов на NVIDIA NIM llama-3.3-70b?",
  "ux-research-agent":            "Назови один метод UX исследования подходящий для 3D интерфейсов.",
  "pr-media-agent":               "Что уникального в ZEUS по сравнению с обычными AI чат-ботами в одном предложении.",
  "data-engineer-agent":          "Как хранить историю разговоров агентов масштабируемо?",
  "technical-writer-agent":       "Что должно быть в README для WebSocket API gateway?",
  "payment-provider-agent":       "Какая модель монетизации лучше для AI агентов: per-query или subscription?",
  "community-manager-agent":      "Как показать AI агентов живыми персонажами а не ботами в соцсетях?",
  "performance-engineer-agent":   "Главный bottleneck в системе где Node.js проксирует запросы к LLM API.",
  "investor-board-agent":         "Главный вопрос который инвестор задаст про ZEUS на питче.",
  "competitor-intelligence-agent": "В чём главное отличие ZEUS от Microsoft Copilot Studio?",
  "university-ecosystem-partner-agent": "Конкретный use case ZEUS агентов для университета.",
  "ceo-report-agent":             "Что должно быть в еженедельном CEO отчёте о состоянии AI команды?",
  "qa-quality-agent":             "Как проверить качество ответа AI агента автоматически?",
  "onboarding-specialist-agent":  "Главная причина drop-off новых пользователей в AI продуктах.",
  "customer-success-agent":       "Один совет который увеличит retention пользователей AI офиса.",
  "trend-scout-agent":            "Самый важный тренд в AI agents за последние 3 месяца.",
  "communications-strategist":    "Объясни ZEUS агентов за 10 слов для не-технического пользователя.",
  "legal-advisor":                "Главный правовой риск при хранении разговоров пользователей с AI.",
  "fact-check-agent":             "Как проверить достоверность утверждения AI агента?",
  "promotion-agency":             "Один канал для продвижения AI офиса с максимальным ROI.",
  "firuza":                       "Ты кто и что ты умеешь делать для команды?",
  "nigar":                        "Ты кто и что ты умеешь делать для команды?",
  "swarm-synthesizer":            "Как синтезировать ответы 10 агентов в единый вывод без потери нюансов?",
};

// Real tasks for qualified agents
const AGENT_TASKS = {
  "security-agent":               "Полный аудит безопасности: server/zeus-gateway-adapter.js, все API эндпоинты. Найди service role key вместо user JWT, открытые CORS, незащищённые WS подключения. P0 проблемы — с готовым кодом фикса.",
  "architecture-agent":           "Аудит: gateway↔офис↔v0Laura связи. Найди узкие места при 100 concurrent users, мёртвый код, проблемы в Dockerfile.gateway. Конкретные файлы и строки кода.",
  "product-agent":                "Аудит UX офиса: что пользователь видит при первом открытии, что создаёт трение при общении с агентами. Конкретные экраны и компоненты с предложениями.",
  "needs-agent":                  "Топ-5 незакрытых потребностей команды прямо сейчас. Конкретно: что блокирует запуск, что замедляет работу, чего не хватает.",
  "qa-engineer":                  "Аудит: найди все места без error handling, без таймаутов, без валидации данных. Особенно WebSocket обработчики и AI вызовы в gateway.",
  "growth-agent":                 "Аудит friction points: путь от открытия офиса до первого полезного ответа агента. Где пользователь застрянет? Конкретные метрики которых не хватает.",
  "risk-manager":                 "Топ-5 рисков (технических + бизнесовых) прямо сейчас. Для каждого — конкретный mitigation план с шагами.",
  "readiness-manager":            "Чеклист готовности к показу первым пользователям: что готово, что нет, что критично.",
  "cultural-intelligence-strategist": "Аудит всех текстов в src/ — корпоративный тон, неправильный язык для AZ/RU. Конкретные строки кода для замены.",
  "accessibility-auditor":        "WCAG 2.1 AA аудит офиса: keyboard nav, aria labels, contrast. Конкретные нарушения с файлами и строками.",
  "behavioral-nudge-engine":      "Аудит cognitive load в UI: сколько решений на экране, есть ли clear CTA. Конкретные компоненты которые перегружают.",
  "assessment-science-agent":     "Найди слабые промпты в buildSystemPrompt — где агенты дают generic ответы. Конкретные улучшения с примерами.",
  "analytics-retention-agent":    "Какие события нужно трекать в офисе? Конкретный план: event name, properties, trigger point.",
  "devops-sre-agent":             "Аудит инфры: Railway конфиги, Dockerfile.gateway, pm2 ecosystem. Single points of failure, отсутствующие healthchecks.",
  "financial-analyst-agent":      "Расчёт: стоимость 1 агентского запроса на NVIDIA NIM. Где можно сэкономить 30%+ без потери качества?",
  "ux-research-agent":            "5 вещей которые запутают нового пользователя в первые 30 секунд. Конкретные решения для каждой.",
  "pr-media-agent":               "Питч ZEUS в 3 форматах: для разработчика, для бизнеса, для инвестора. Что показывать, что не показывать.",
  "data-engineer-agent":          "Как сейчас хранится история разговоров? Что теряется при рестарте? Предложи решение.",
  "technical-writer-agent":       "Проверь ZEUS-SETUP.md — что устарело, что неточно, что добавить для onboarding нового разработчика.",
  "payment-provider-agent":       "3 модели монетизации ZEUS агентов. Рекомендация с обоснованием для v0Laura.",
  "community-manager-agent":      "Plan для первых 100 пользователей: каналы, контент, как показать агентов живыми.",
  "performance-engineer-agent":   "Профилируй callClaude: где время тратится, что можно кэшировать, как уменьшить latency на 30%.",
  "investor-board-agent":         "Что впечатлит инвестора в ZEUS? Что насторожит? Топ-3 вопроса и ответы.",
  "competitor-intelligence-agent": "Сравни с Anthropic Teams, MS Copilot, Cursor AI. Где ZEUS выигрывает уже сейчас?",
  "university-ecosystem-partner-agent": "3 конкретных use case для университетов AZ/RU с потенциальными партнёрами.",
  "ceo-report-agent":             "Executive summary текущего состояния ZEUS: что работает, топ-3 приоритета на неделю. 1 страница.",
  "qa-quality-agent":             "Как автоматически проверять качество агентских ответов? Конкретный алгоритм.",
  "onboarding-specialist-agent":  "Пошаговый onboarding для нового пользователя офиса. Что показать первым, вторым, третьим.",
  "customer-success-agent":       "Топ-5 tips для максимального результата от ZEUS. Для welcome message.",
  "trend-scout-agent":            "Топ-3 тренда в AI agents (апрель 2026). Что из этого применимо к ZEUS прямо сейчас?",
  "communications-strategist":    "3 варианта объяснения ZEUS: для tech, бизнес, обычный человек. По 2 предложения.",
  "legal-advisor":                "Топ-3 правовых риска до public launch. Что нужно закрыть минимально?",
  "fact-check-agent":             "Проверь session-context.md и ZEUS-SETUP.md — что устарело, что противоречит коду?",
  "promotion-agency":             "План продвижения на первые 30 дней. Каналы, контент, бюджет (если $0).",
  "firuza":                       "Посмотри на офис глазами 19-летней студентки без технического бэкграунда. Что непонятно?",
  "nigar":                        "Посмотри на офис глазами HR-менеджера. Как использовать агентов для найма и оценки команды?",
  "swarm-synthesizer":            "Синтезируй все проблемы найденные командой сегодня в приоритизированный список для CEO.",
};

function connect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(GW_URL);
    ws.on("open", () => {
      ws.send(JSON.stringify({ type: "req", id: "c1", method: "connect", params: {} }));
    });
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === "res" && msg.id === "c1") resolve(ws);
    });
    ws.on("error", reject);
    setTimeout(() => reject(new Error("connect timeout")), 10_000);
  });
}

function askAgent(agentId, message, timeoutMs = 60_000) {
  return new Promise(async (resolve) => {
    let ws;
    try { ws = await connect(); } catch { return resolve({ agentId, error: "no gateway" }); }

    const reqId = `q-${agentId}-${Date.now()}`;
    let result = null;

    const timer = setTimeout(() => {
      ws.close();
      resolve({ agentId, error: "timeout", result: null });
    }, timeoutMs);

    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === "event" && msg.event === "chat" && msg.payload?.state === "final") {
        result = msg.payload?.message?.content || "";
        clearTimeout(timer);
        ws.close();
      }
    });

    ws.on("close", () => resolve({ agentId, result }));
    ws.on("error", () => { clearTimeout(timer); resolve({ agentId, error: "ws error" }); });

    ws.send(JSON.stringify({ type: "req", id: reqId, method: "chat.send", params: {
      agentId, sessionKey: `check-${agentId}`, message
    }}));
  });
}

// Competence scorer: generic answer = fail
function isCompetent(agentId, answer) {
  if (!answer || answer.length < 50) return false;
  const generic = ["как языковая модель", "как ии", "я не могу", "я не имею доступа",
                   "у меня нет", "к сожалению", "извините", "i cannot", "as an ai"];
  const lower = answer.toLowerCase();
  if (generic.some(g => lower.includes(g))) return false;
  return true;
}

(async () => {
  const agentIds = Object.keys(COMPETENCE_CHECKS);
  const taskAgentIds = Object.keys(AGENT_TASKS);

  console.log(`\n${"═".repeat(55)}`);
  console.log(`PHASE 1: COMPETENCE CHECK — ${agentIds.length} agents`);
  console.log(`${"═".repeat(55)}\n`);

  let checked = 0;
  const qualified = [];
  const failed = [];

  // Run all competence checks in parallel
  const checkResults = await Promise.all(
    agentIds.map(id => askAgent(id, COMPETENCE_CHECKS[id], 45_000).then(r => {
      checked++;
      const ok = isCompetent(id, r.result);
      process.stdout.write(`[${checked}/${agentIds.length}] ${id}: ${ok ? "✅ QUALIFIED" : "❌ FAILED"}\n`);
      if (ok) qualified.push(id);
      else failed.push(id);
      return { ...r, qualified: ok };
    }))
  );

  console.log(`\n${"─".repeat(55)}`);
  console.log(`Qualified: ${qualified.length}  |  Failed: ${failed.length}`);
  if (failed.length) console.log(`Failed agents: ${failed.join(", ")}`);
  console.log(`${"─".repeat(55)}\n`);

  // Save competence report
  const checkReport = checkResults.map(r =>
    `## ${r.agentId} — ${r.qualified ? "✅ QUALIFIED" : "❌ FAILED"}\n${r.error ? `Error: ${r.error}` : (r.result || "").slice(0, 400)}`
  ).join("\n\n");
  fs.writeFileSync(path.join(findingsDir, `${date}-competence-check.md`), `# Competence Check ${date}\n\n${checkReport}`);

  if (qualified.length === 0) {
    console.log("No agents qualified. Check gateway connection.");
    process.exit(1);
  }

  console.log(`${"═".repeat(55)}`);
  console.log(`PHASE 2: REAL TASKS — ${qualified.length} qualified agents`);
  console.log(`${"═".repeat(55)}\n`);

  let done = 0;
  const taskResults = await Promise.all(
    qualified
      .filter(id => AGENT_TASKS[id])
      .map(id => askAgent(id, AGENT_TASKS[id], 180_000).then(r => {
        done++;
        process.stdout.write(`[${done}/${qualified.length}] ${id} ✅\n`);
        if (r.result) {
          fs.writeFileSync(
            path.join(findingsDir, `${date}-${id}.md`),
            `# ${id}\n**Date:** ${date}\n**Status:** Qualified & Completed\n\n${r.result}`
          );
        }
        return r;
      }))
  );

  const success = taskResults.filter(r => r.result && !r.error).length;
  console.log(`\n${"═".repeat(55)}`);
  console.log(`ALL DONE: ${success}/${qualified.length} agents delivered findings`);
  console.log(`Results: memory/agent-findings/`);
  console.log(`${"═".repeat(55)}\n`);

  process.exit(0);
})();

"use strict";

/**
 * research-module — Research-First protocol for ZEUS agents
 *
 * Before any swarm.run task, agents research their domain first.
 * Findings are injected into the shared prompt context so every agent
 * starts from verified facts, not guesses.
 *
 * Search providers (priority order):
 *   1. Tavily API (TAVILY_API_KEY) — best quality, 1000 req/mo free
 *   2. DuckDuckGo Instant Answer API — no key, lightweight fallback
 *
 * Usage:
 *   const { researchBeforeTask, webSearch } = require("./research-module");
 *   const context = await researchBeforeTask(task, agentDomains);
 *   // inject context into agent system prompt
 */

const https = require("https");
const { execSync } = require("child_process");

const TAVILY_KEY = process.env.TAVILY_API_KEY || "";
const RESEARCH_TIMEOUT_MS = 8_000;
const NLM_PYTHON = process.env.NLM_PYTHON ||
  "C:/Users/user/AppData/Local/Programs/Python/Python312/python.exe";

// NotebookLM notebook IDs mapped to domain
const NOTEBOOKS = {
  adhd:        "e8fe6264",  // MindShift ADHD App Research
  color:       "8507f90b",  // ADHD Color Psychology & UI
  retention:   "78c393a0",  // App Retention & Onboarding Patterns
  psychotype:  "19efdc5d",  // ADHD Psychotypes & Personalization
  swarm:       "6b8c2269",  // ZEUS + JARVIS + AI Swarm Product
  quality:     "888d43e4",  // Quality System - Toyota+Apple+DORA
  competitive: "a76be380",  // Competitive Landscape
  agent:       "a24d147d",  // AI Agent Decision Making
  payments:    "fad04e49",  // Payment Processor Research
  telegram:    "17feb509",  // Telegram Bot Best Practices
};

// Agent → best NotebookLM notebook for their domain
const AGENT_NOTEBOOK = {
  "ux-research-agent":            NOTEBOOKS.adhd,
  "behavioral-nudge-engine":      NOTEBOOKS.psychotype,
  "accessibility-auditor":        NOTEBOOKS.color,
  "onboarding-specialist-agent":  NOTEBOOKS.retention,
  "growth-agent":                 NOTEBOOKS.retention,
  "product-agent":                NOTEBOOKS.adhd,
  "architecture-agent":           NOTEBOOKS.swarm,
  "qa-engineer":                  NOTEBOOKS.quality,
  "financial-analyst-agent":      NOTEBOOKS.payments,
  "community-manager-agent":      NOTEBOOKS.telegram,
  "cultural-intelligence-strategist": NOTEBOOKS.competitive,
};

// ── Domain → research angle mapping ─────────────────────────────────────────
// Each agent type knows what angle to research for any given task
const DOMAIN_ANGLES = {
  "security-agent":               (task) => `security vulnerabilities best practices ${task} 2025`,
  "architecture-agent":           (task) => `software architecture patterns ${task} production scale`,
  "product-agent":                (task) => `user research JTBD ${task} ADHD productivity`,
  "ux-research-agent":            (task) => `UX usability research ${task} mobile PWA`,
  "growth-agent":                 (task) => `growth retention metrics ${task} mobile app 2025`,
  "qa-engineer":                  (task) => `testing strategies edge cases ${task}`,
  "behavioral-nudge-engine":      (task) => `behavioral psychology nudge ${task} ADHD`,
  "financial-analyst-agent":      (task) => `business model monetization ${task} SaaS`,
  "cultural-intelligence-strategist": (task) => `cultural localization ${task} Azerbaijan CIS market`,
  "accessibility-auditor":        (task) => `accessibility WCAG 2.2 ${task} screen reader`,
  "performance-engineer-agent":   (task) => `performance optimization ${task} React TypeScript`,
  "devops-sre-agent":             (task) => `DevOps deployment ${task} Railway Vercel Supabase`,
  "assessment-science-agent":     (task) => `psychometric assessment IRT ${task}`,
  "legal-advisor":                (task) => `legal compliance GDPR ${task} mobile app`,
};

// ── Web search via Tavily ────────────────────────────────────────────────────
async function searchTavily(query, maxResults = 3) {
  return new Promise((resolve) => {
    const body = JSON.stringify({
      api_key: TAVILY_KEY,
      query,
      search_depth: "basic",
      max_results: maxResults,
      include_answer: true,
    });

    const req = https.request({
      hostname: "api.tavily.com",
      path: "/search",
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
    }, (res) => {
      let data = "";
      res.on("data", (c) => data += c);
      res.on("end", () => {
        try {
          const json = JSON.parse(data);
          let text = json.answer ? `Answer: ${json.answer}\n\n` : "";
          (json.results || []).slice(0, maxResults).forEach((r, i) => {
            text += `[${i+1}] ${r.title}\n${r.content?.slice(0, 300)}\nSource: ${r.url}\n\n`;
          });
          resolve(text.trim() || "No results.");
        } catch { resolve("Search parse error."); }
      });
    });

    req.on("error", () => resolve("Search unavailable."));
    setTimeout(() => { req.destroy(); resolve("Search timeout."); }, RESEARCH_TIMEOUT_MS);
    req.write(body);
    req.end();
  });
}

// ── Web search via DuckDuckGo (no key needed) ────────────────────────────────
async function searchDDG(query) {
  return new Promise((resolve) => {
    const encoded = encodeURIComponent(query);
    const req = https.request({
      hostname: "api.duckduckgo.com",
      path: `/?q=${encoded}&format=json&no_html=1&skip_disambig=1`,
      method: "GET",
      headers: { "User-Agent": "ZEUS-Research-Agent/1.0" },
    }, (res) => {
      let data = "";
      res.on("data", (c) => data += c);
      res.on("end", () => {
        try {
          const json = JSON.parse(data);
          const parts = [];
          if (json.AbstractText) parts.push(json.AbstractText);
          (json.RelatedTopics || []).slice(0, 3).forEach((t) => {
            if (t.Text) parts.push(t.Text);
          });
          resolve(parts.join("\n\n") || "No DDG results.");
        } catch { resolve("DDG parse error."); }
      });
    });
    req.on("error", () => resolve("DDG unavailable."));
    setTimeout(() => { req.destroy(); resolve("DDG timeout."); }, RESEARCH_TIMEOUT_MS);
    req.end();
  });
}

// ── Public: search with auto-fallback ────────────────────────────────────────
async function webSearch(query, maxResults = 3) {
  if (TAVILY_KEY) {
    return searchTavily(query, maxResults);
  }
  return searchDDG(query);
}

// ── Public: research-first protocol ─────────────────────────────────────────
/**
 * Each agent in agentIds researches its domain angle of the task.
 * Runs in parallel. Returns a combined research context string.
 *
 * @param {string} task - The task description
 * @param {string[]} agentIds - List of agent IDs that will work on the task
 * @returns {Promise<string>} - Research context to inject into prompts
 */
async function researchBeforeTask(task, agentIds) {
  const shortTask = task.slice(0, 120);

  // Build queries per agent domain
  const queries = agentIds
    .filter((id) => DOMAIN_ANGLES[id])
    .map((id) => ({
      agentId: id,
      query: DOMAIN_ANGLES[id](shortTask),
    }));

  // Deduplicate similar queries (avoid redundant searches)
  const seen = new Set();
  const unique = queries.filter(({ query }) => {
    const key = query.toLowerCase().slice(0, 40);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  if (unique.length === 0) return "";

  // Run in parallel (max 4 concurrent to avoid rate limits)
  const PARALLEL_LIMIT = 4;
  const results = [];

  for (let i = 0; i < unique.length; i += PARALLEL_LIMIT) {
    const batch = unique.slice(i, i + PARALLEL_LIMIT);
    const batchResults = await Promise.all(
      batch.map(async ({ agentId, query }) => {
        try {
          const findings = await webSearch(query, 2);
          return { agentId, query, findings };
        } catch {
          return { agentId, query, findings: "Research failed." };
        }
      })
    );
    results.push(...batchResults);
  }

  // Format into injected context
  const lines = ["# Research Findings (pre-task, do not ignore)", ""];
  results.forEach(({ agentId, query, findings }) => {
    lines.push(`## ${agentId} researched: "${query}"`);
    lines.push(findings);
    lines.push("");
  });
  lines.push("---");
  lines.push("Use these findings to ground your response in real data. Cite sources if relevant.");

  return lines.join("\n");
}

// ── Vote collector — agents propose what to research, we pick top-voted ──────
/**
 * Each agent proposes a research question. We deduplicate by similarity,
 * pick the top N by vote count (frequency of similar proposals).
 *
 * @param {Array<{agentId, question}>} proposals
 * @param {number} topN
 * @returns {string[]} - Top N research questions
 */
function pickTopResearchQuestions(proposals, topN = 3) {
  const votes = new Map();

  proposals.forEach(({ question }) => {
    const key = question.toLowerCase().trim().slice(0, 60);
    votes.set(key, (votes.get(key) || 0) + 1);
  });

  return [...votes.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
    .map(([key]) => proposals.find((p) => p.question.toLowerCase().slice(0, 60) === key)?.question || key);
}

// ── NotebookLM query ─────────────────────────────────────────────────────────
function queryNotebook(notebookId, question) {
  try {
    // Step 1: switch notebook context
    execSync(`"${NLM_PYTHON}" -m notebooklm use ${notebookId}`,
      { timeout: 10_000, encoding: "utf8", windowsHide: true });

    // Step 2: ask question
    const safeQ = question.replace(/"/g, "'").slice(0, 300);
    const result = execSync(
      `"${NLM_PYTHON}" -m notebooklm ask "${safeQ}"`,
      { timeout: 30_000, encoding: "utf8", windowsHide: true }
    );

    // Extract Answer section
    const match = result.match(/Answer:\n([\s\S]+?)(?:\n\nResumed|\n\+[-+]+\+|$)/);
    return match ? match[1].trim().slice(0, 600) : result.trim().slice(0, 600);
  } catch (err) {
    return `NotebookLM unavailable: ${err.message.slice(0, 100)}`;
  }
}

// ── Enhanced research: NotebookLM first, web search second ──────────────────
async function researchBeforeTask(task, agentIds) {
  const shortTask = task.slice(0, 120);

  const queries = agentIds
    .filter((id) => DOMAIN_ANGLES[id])
    .map((id) => ({
      agentId: id,
      webQuery: DOMAIN_ANGLES[id](shortTask),
      notebookId: AGENT_NOTEBOOK[id] || null,
      notebookQuestion: `In context of: "${shortTask}" — what does the research say about best practices for ${id.replace(/-/g, " ")}?`,
    }));

  // Deduplicate
  const seen = new Set();
  const unique = queries.filter(({ webQuery }) => {
    const key = webQuery.toLowerCase().slice(0, 40);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  if (unique.length === 0) return "";

  const PARALLEL_LIMIT = 3;
  const results = [];

  for (let i = 0; i < unique.length; i += PARALLEL_LIMIT) {
    const batch = unique.slice(i, i + PARALLEL_LIMIT);
    const batchResults = await Promise.all(
      batch.map(async ({ agentId, webQuery, notebookId, notebookQuestion }) => {
        // NotebookLM (sync, blocking but fast) — internal curated knowledge first
        let nlmFindings = "";
        if (notebookId) {
          nlmFindings = queryNotebook(notebookId, notebookQuestion);
        }

        // Web search — external current data
        let webFindings = "";
        try {
          webFindings = await webSearch(webQuery, 2);
        } catch { webFindings = "Web search failed."; }

        return { agentId, nlmFindings, webFindings };
      })
    );
    results.push(...batchResults);
  }

  // Format into injected context
  const lines = ["# Research Findings (pre-task, grounded in sources)", ""];
  results.forEach(({ agentId, nlmFindings, webFindings }) => {
    lines.push(`## ${agentId}`);
    if (nlmFindings && !nlmFindings.includes("unavailable")) {
      lines.push(`**Internal research (NotebookLM):**\n${nlmFindings}`);
    }
    if (webFindings && webFindings !== "No DDG results." && webFindings !== "Search unavailable.") {
      lines.push(`**Web search:**\n${webFindings}`);
    }
    lines.push("");
  });
  lines.push("---");
  lines.push("Ground your response in these findings. Do not invent facts not supported above.");

  return lines.join("\n");
}

module.exports = { webSearch, queryNotebook, researchBeforeTask, pickTopResearchQuestions };

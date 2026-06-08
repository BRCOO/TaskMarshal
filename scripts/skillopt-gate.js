#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const DEFAULT_CANDIDATE = "skills/taskmarshal/SKILL.md";
const DEFAULT_BASELINE = "skills/taskmarshal/SKILL.md";
const DEFAULT_CASES = "examples/skillopt/taskmarshal-routing-cases.jsonl";
const APPROX_CHARS_PER_TOKEN = 4;

const args = parseArgs(process.argv.slice(2));
const candidatePath = resolve(args.candidate || DEFAULT_CANDIDATE);
const baselinePath = resolve(args.baseline || DEFAULT_BASELINE);
const casesPath = resolve(args.cases || DEFAULT_CASES);
const maxChars = Number(args.maxChars || process.env.TASKMARSHAL_SKILLOPT_MAX_CHARS || 9500);
const maxGrowth = Number(args.maxGrowth || process.env.TASKMARSHAL_SKILLOPT_MAX_GROWTH || 0.05);

const checks = [];
const candidateText = readText(candidatePath, "candidate skill");
const baselineText = readText(baselinePath, "baseline skill");
const candidateLower = candidateText.toLowerCase();
const baselineChars = baselineText.length;
const growthLimitChars = Math.ceil(baselineChars * (1 + maxGrowth));
const charLimit = Math.min(maxChars, growthLimitChars);

check("candidate_exists", Boolean(candidateText), { path: candidatePath });
check("baseline_exists", Boolean(baselineText), { path: baselinePath });
check("frontmatter_present", /^---\r?\n[\s\S]*?\r?\n---/.test(candidateText));
check("frontmatter_name_taskmarshal", /name:\s*taskmarshal/i.test(candidateText));
check("frontmatter_mentions_routing", /description:[\s\S]*routing/i.test(candidateText));
check("char_budget", candidateText.length <= charLimit, {
  candidateChars: candidateText.length,
  baselineChars,
  maxChars,
  maxGrowth,
  limit: charLimit
});

const requirementGroups = [
  {
    id: "mode_policy",
    all: ["local mode", "light mode", "full marshal mode"]
  },
  {
    id: "local_machine_state_boundary",
    all: ["~/.codex", "~/.agents", "mcp config", "api-key config", "home-directory"]
  },
  {
    id: "delegation_score",
    all: ["delegation score", "score `<= 0`", "score `>= 3`"]
  },
  {
    id: "provider_model_policy",
    all: ["reasonix `flash`", "reasonix `pro`", "claude-code"]
  },
  {
    id: "persistent_session_policy",
    all: ["worker_start_session", "worker_send_task", "worker_observe", "since"]
  },
  {
    id: "compact_observation_policy",
    all: ["summary", "final", "permission", "maxchars"]
  },
  {
    id: "metrics_policy",
    all: ["worker_metrics_report", "compact: true", "eval:tokens"]
  },
  {
    id: "task_gate_policy",
    all: [
      "worker_task_gate(action: \"route\"",
      "worker_task_gate(action: \"create\"",
      "worker_task_gate(action: \"verify\"",
      "worker_task_gate(action: \"finalize\""
    ]
  },
  {
    id: "ledger_closeout_policy",
    all: ["worker_task_gate(action: \"tasks\"", "worker_task_gate(action: \"close-readonly\""]
  },
  {
    id: "pro_review_policy",
    all: ["worker_plan_pro_review", "reserve", "`pro`"]
  },
  {
    id: "approval_safety_policy",
    all: ["approve only scoped", "deny", "destructive"]
  },
  {
    id: "worker_output_contract",
    all: ["changedfiles", "commands", "verification", "risks", "next", "1200"]
  },
  {
    id: "avoid_blocking_oneshot_audits",
    all: ["avoid `worker_ask`", "persistent sessions"]
  }
];

for (const group of requirementGroups) {
  const missing = group.all.filter((needle) => !candidateLower.includes(needle.toLowerCase()));
  check(group.id, missing.length === 0, { missing });
}

const secretPatterns = [
  { id: "openai_style_key", pattern: /sk-[A-Za-z0-9_-]{20,}/ },
  { id: "api_key_assignment", pattern: /api[_-]?key\s*[=:]\s*['"]?[A-Za-z0-9_-]{12,}/i },
  { id: "password_assignment", pattern: /password\s*[=:]\s*['"]?[^'"\s]{8,}/i },
  { id: "secret_assignment", pattern: /secret\s*[=:]\s*['"]?[^'"\s]{8,}/i },
  { id: "private_key", pattern: /BEGIN [A-Z ]*PRIVATE KEY/ }
];
for (const item of secretPatterns) {
  check(`no_${item.id}`, !item.pattern.test(candidateText));
}

const cases = readJsonlCases(casesPath);
check("case_file_present", cases.length > 0, { path: casesPath, count: cases.length });
for (const item of cases) {
  const missingFields = ["id", "goal", "expectedRoute"].filter((field) => !String(item[field] || "").trim());
  check(`case_schema:${item.id || "unknown"}`, missingFields.length === 0, { missingFields });
  const missingSkillText = (item.mustContainInSkill || []).filter((needle) => !candidateLower.includes(String(needle).toLowerCase()));
  check(`case_skill_retains:${item.id || "unknown"}`, missingSkillText.length === 0, { missingSkillText });
}

const routeCases = cases.filter((item) => item.goal && item.expectedRoute);
const routeResults = routeCases.map(runRouteCase);
for (const result of routeResults) {
  check(`route_case:${result.id}`, result.ok, result);
}

const ok = checks.every((item) => item.ok);
console.log(JSON.stringify({
  ok,
  generatedAt: new Date().toISOString(),
  candidate: {
    path: candidatePath,
    chars: candidateText.length,
    approxTokens: Math.ceil(candidateText.length / APPROX_CHARS_PER_TOKEN)
  },
  baseline: {
    path: baselinePath,
    chars: baselineChars,
    approxTokens: Math.ceil(baselineChars / APPROX_CHARS_PER_TOKEN)
  },
  budgets: {
    maxChars,
    maxGrowth,
    effectiveCharLimit: charLimit,
    headroomChars: charLimit - candidateText.length
  },
  cases: {
    path: casesPath,
    count: cases.length,
    routeCount: routeResults.length
  },
  checks,
  next: ok
    ? "Candidate skill passed local SkillOpt acceptance gates; run npm run eval && npm run eval:tokens before replacing the installed skill."
    : "Reject this candidate or revise it, then rerun eval:skillopt."
}, null, 2));

if (!ok) process.exitCode = 1;

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--candidate") out.candidate = argv[++i];
    else if (arg === "--baseline") out.baseline = argv[++i];
    else if (arg === "--cases") out.cases = argv[++i];
    else if (arg === "--max-chars") out.maxChars = argv[++i];
    else if (arg === "--max-growth") out.maxGrowth = argv[++i];
    else throw new Error(`Unknown option: ${arg}`);
  }
  return out;
}

function readText(path, label) {
  if (!existsSync(path)) {
    check(`${label.replace(/\s+/g, "_")}_readable`, false, { path });
    return "";
  }
  return readFileSync(path, "utf8").replace(/^\uFEFF/, "");
}

function readJsonlCases(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (err) {
        check(`case_parse:${index + 1}`, false, { error: err.message });
        return { id: `invalid-${index + 1}` };
      }
    });
}

function runRouteCase(item) {
  const child = spawnSync(process.execPath, [
    "taskmarshalctl.js",
    "route",
    "--goal",
    item.goal,
    "--scope",
    item.scope || "",
    "--risk",
    item.risk || "medium",
    "--files",
    String(item.files ?? 0)
  ], {
    cwd: process.cwd(),
    encoding: "utf8"
  });
  let data = null;
  try {
    data = child.stdout ? JSON.parse(child.stdout) : null;
  } catch (err) {
    return {
      id: item.id,
      ok: false,
      expectedRoute: item.expectedRoute,
      actualRoute: null,
      error: err.message,
      stderr: child.stderr
    };
  }
  return {
    id: item.id,
    ok: child.status === 0 && data?.route === item.expectedRoute,
    expectedRoute: item.expectedRoute,
    actualRoute: data?.route ?? null,
    reasonCodes: data?.reasonCodes ?? [],
    stderr: child.stderr || null
  };
}

function check(id, ok, data = {}) {
  checks.push({ id, ok: Boolean(ok), ...data });
}

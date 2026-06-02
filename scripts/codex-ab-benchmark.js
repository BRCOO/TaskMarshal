#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const APPROX_CHARS_PER_TOKEN = 4;
const VARIANTS = ["codex-only", "taskmarshal"];
const BUDGETS = {
  codexTokenSavingMin: 0.25,
  mediumPlusCodexTokenSavingMin: 0.35,
  passRateDropMax: 0.05,
  severeIssueIncreaseMax: 0,
  redoIncreaseMax: 0
};

const args = parseArgs(process.argv.slice(2));
const records = args.input ? readRecords(args.input) : syntheticRecords();
const normalized = records.map(normalizeRecord);
const grouped = groupByVariant(normalized);
const comparisons = compareVariants(grouped);
const budgets = buildBudgetReport(comparisons);
const ok = comparisons.ready && Object.values(budgets).every((item) => item.ok);

console.log(JSON.stringify({
  ok,
  generatedAt: new Date().toISOString(),
  mode: args.input ? "input" : "synthetic",
  input: args.input ?? null,
  note: [
    `approxTokens uses ${APPROX_CHARS_PER_TOKEN} chars/token when explicit token counts are absent.`,
    "Codex token metrics exclude worker token metrics; totalAiTokens includes both."
  ].join(" "),
  budgets,
  summary: comparisons.summary,
  bySize: comparisons.bySize,
  schema: recordSchema()
}, null, 2));

if (!ok) process.exitCode = 1;

function parseArgs(argv) {
  const out = { input: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--input") out.input = resolve(argv[++i]);
    else throw new Error(`Unknown option: ${arg}`);
  }
  return out;
}

function readRecords(path) {
  if (!existsSync(path)) throw new Error(`Input not found: ${path}`);
  const text = readFileSync(path, "utf8").trim();
  if (!text) return [];
  if (text.startsWith("[") || text.startsWith("{")) {
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) return parsed;
      if (Array.isArray(parsed.records)) return parsed.records;
      throw new Error("JSON input must be an array or an object with records[].");
    } catch (err) {
      if (!text.includes("\n")) throw err;
    }
  }
  return text.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

function normalizeRecord(record) {
  const variant = normalizeVariant(record.variant);
  const size = normalizeSize(record.size);
  const codexInputTokens = numberOrApprox(record.codexInputTokens, record.codexInputChars);
  const codexOutputTokens = numberOrApprox(record.codexOutputTokens, record.codexOutputChars);
  const workerInputTokens = numberOrApprox(record.workerInputTokens, record.workerInputChars);
  const workerOutputTokens = numberOrApprox(record.workerOutputTokens, record.workerOutputChars);
  return {
    taskId: String(record.taskId || ""),
    variant,
    size,
    passed: Boolean(record.passed),
    qualityScore: numericOrNull(record.qualityScore),
    severeIssues: numericOrZero(record.severeIssues),
    redoCount: numericOrZero(record.redoCount),
    elapsedSec: numericOrNull(record.elapsedSec),
    codexInputTokens,
    codexOutputTokens,
    codexTotalTokens: numericOrNull(record.codexTotalTokens) ?? codexInputTokens + codexOutputTokens,
    workerInputTokens,
    workerOutputTokens,
    workerTotalTokens: numericOrNull(record.workerTotalTokens) ?? workerInputTokens + workerOutputTokens
  };
}

function normalizeVariant(value) {
  const variant = String(value || "").toLowerCase();
  if (["codex-only", "codex_only", "baseline"].includes(variant)) return "codex-only";
  if (["taskmarshal", "codex-taskmarshal", "tm"].includes(variant)) return "taskmarshal";
  throw new Error(`Invalid variant: ${value}`);
}

function normalizeSize(value) {
  const size = String(value || "unknown").toLowerCase();
  return ["small", "medium", "large"].includes(size) ? size : "unknown";
}

function numberOrApprox(tokens, chars) {
  const explicit = numericOrNull(tokens);
  if (explicit !== null) return explicit;
  return Math.ceil(numericOrZero(chars) / APPROX_CHARS_PER_TOKEN);
}

function groupByVariant(records) {
  const groups = Object.fromEntries(VARIANTS.map((variant) => [variant, []]));
  for (const record of records) groups[record.variant].push(record);
  return groups;
}

function compareVariants(groups) {
  const codexOnly = summarizeRecords(groups["codex-only"]);
  const taskmarshal = summarizeRecords(groups.taskmarshal);
  const bySize = {};
  for (const size of ["small", "medium", "large"]) {
    bySize[size] = compareSummaries({
      codexOnly: summarizeRecords(groups["codex-only"].filter((record) => record.size === size)),
      taskmarshal: summarizeRecords(groups.taskmarshal.filter((record) => record.size === size))
    });
  }
  return {
    ready: codexOnly.taskCount > 0 && taskmarshal.taskCount > 0,
    summary: compareSummaries({ codexOnly, taskmarshal }),
    bySize
  };
}

function summarizeRecords(records) {
  const taskCount = records.length;
  const passCount = records.filter((record) => record.passed).length;
  const codexTokens = sumBy(records, "codexTotalTokens");
  const workerTokens = sumBy(records, "workerTotalTokens");
  const scoreRecords = records.filter((record) => record.qualityScore !== null);
  const elapsedRecords = records.filter((record) => record.elapsedSec !== null);
  return {
    taskCount,
    passCount,
    passRate: taskCount ? round(passCount / taskCount, 4) : null,
    codexTokens,
    workerTokens,
    totalAiTokens: codexTokens + workerTokens,
    avgCodexTokens: taskCount ? Math.round(codexTokens / taskCount) : null,
    avgTotalAiTokens: taskCount ? Math.round((codexTokens + workerTokens) / taskCount) : null,
    avgQualityScore: scoreRecords.length ? round(sumBy(scoreRecords, "qualityScore") / scoreRecords.length, 3) : null,
    severeIssues: sumBy(records, "severeIssues"),
    redoCount: sumBy(records, "redoCount"),
    avgElapsedSec: elapsedRecords.length ? round(sumBy(elapsedRecords, "elapsedSec") / elapsedRecords.length, 1) : null
  };
}

function compareSummaries({ codexOnly, taskmarshal }) {
  return {
    codexOnly,
    taskmarshal,
    codexTokenSaving: ratioSaving(codexOnly.codexTokens, taskmarshal.codexTokens),
    totalAiTokenSaving: ratioSaving(codexOnly.totalAiTokens, taskmarshal.totalAiTokens),
    passRateDelta: nullableDelta(taskmarshal.passRate, codexOnly.passRate),
    qualityScoreDelta: nullableDelta(taskmarshal.avgQualityScore, codexOnly.avgQualityScore),
    severeIssueDelta: taskmarshal.severeIssues - codexOnly.severeIssues,
    redoDelta: taskmarshal.redoCount - codexOnly.redoCount
  };
}

function buildBudgetReport(comparisons) {
  const mediumPlusCodexOnly = combineSummaries([
    comparisons.bySize.medium.codexOnly,
    comparisons.bySize.large.codexOnly
  ]);
  const mediumPlusTaskmarshal = combineSummaries([
    comparisons.bySize.medium.taskmarshal,
    comparisons.bySize.large.taskmarshal
  ]);
  const mediumPlusSaving = ratioSaving(mediumPlusCodexOnly.codexTokens, mediumPlusTaskmarshal.codexTokens);
  return {
    hasBothVariants: {
      actual: comparisons.ready,
      expected: true,
      ok: comparisons.ready
    },
    codexTokenSaving: minBudget(comparisons.summary.codexTokenSaving, BUDGETS.codexTokenSavingMin),
    mediumPlusCodexTokenSaving: minBudget(mediumPlusSaving, BUDGETS.mediumPlusCodexTokenSavingMin),
    passRateDrop: maxBudget(-Math.min(comparisons.summary.passRateDelta ?? 0, 0), BUDGETS.passRateDropMax),
    severeIssueIncrease: maxBudget(comparisons.summary.severeIssueDelta, BUDGETS.severeIssueIncreaseMax),
    redoIncrease: maxBudget(comparisons.summary.redoDelta, BUDGETS.redoIncreaseMax)
  };
}

function combineSummaries(summaries) {
  const taskCount = summaries.reduce((total, summary) => total + summary.taskCount, 0);
  const passCount = summaries.reduce((total, summary) => total + summary.passCount, 0);
  const codexTokens = summaries.reduce((total, summary) => total + summary.codexTokens, 0);
  const workerTokens = summaries.reduce((total, summary) => total + summary.workerTokens, 0);
  return {
    taskCount,
    passCount,
    passRate: taskCount ? round(passCount / taskCount, 4) : null,
    codexTokens,
    workerTokens,
    totalAiTokens: codexTokens + workerTokens
  };
}

function syntheticRecords() {
  const tasks = [
    { id: "small-docs", size: "small", codexOnly: 1400, taskmarshal: 2100, worker: 0 },
    { id: "small-one-file", size: "small", codexOnly: 2200, taskmarshal: 2600, worker: 500 },
    { id: "medium-refactor", size: "medium", codexOnly: 11500, taskmarshal: 6900, worker: 5200 },
    { id: "medium-test-fix", size: "medium", codexOnly: 13200, taskmarshal: 7400, worker: 6100 },
    { id: "large-debug", size: "large", codexOnly: 36000, taskmarshal: 14800, worker: 21500 },
    { id: "large-architecture", size: "large", codexOnly: 42000, taskmarshal: 16300, worker: 24800 }
  ];
  return tasks.flatMap((task) => [
    makeSyntheticRun(task, "codex-only", task.codexOnly, 0),
    makeSyntheticRun(task, "taskmarshal", task.taskmarshal, task.worker)
  ]);
}

function makeSyntheticRun(task, variant, codexTotalTokens, workerTotalTokens) {
  const outputTokens = Math.round(codexTotalTokens * (variant === "codex-only" ? 0.16 : 0.11));
  return {
    taskId: task.id,
    size: task.size,
    variant,
    codexInputTokens: codexTotalTokens - outputTokens,
    codexOutputTokens: outputTokens,
    workerInputTokens: Math.round(workerTotalTokens * 0.45),
    workerOutputTokens: Math.round(workerTotalTokens * 0.55),
    passed: true,
    qualityScore: task.size === "small" && variant === "taskmarshal" ? 0.92 : 0.95,
    severeIssues: 0,
    redoCount: 0,
    elapsedSec: variant === "codex-only" ? codexTotalTokens / 80 : (codexTotalTokens + workerTotalTokens) / 100
  };
}

function recordSchema() {
  return {
    required: ["taskId", "size", "variant", "passed"],
    variant: ["codex-only", "taskmarshal"],
    size: ["small", "medium", "large"],
    tokenFields: [
      "codexInputTokens/codexOutputTokens or codexInputChars/codexOutputChars",
      "workerInputTokens/workerOutputTokens or workerInputChars/workerOutputChars"
    ],
    qualityFields: ["qualityScore", "severeIssues", "redoCount", "elapsedSec"]
  };
}

function ratioSaving(before, after) {
  return before > 0 ? round(1 - after / before, 4) : null;
}

function nullableDelta(after, before) {
  return after === null || before === null ? null : round(after - before, 4);
}

function minBudget(actual, min) {
  return {
    actual,
    min,
    ok: actual !== null && actual >= min,
    headroom: actual === null ? null : round(actual - min, 4)
  };
}

function maxBudget(actual, max) {
  return {
    actual,
    max,
    ok: actual !== null && actual <= max,
    headroom: actual === null ? null : round(max - actual, 4)
  };
}

function sumBy(items, key) {
  return items.reduce((total, item) => total + numericOrZero(item[key]), 0);
}

function numericOrZero(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function numericOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function round(value, digits) {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

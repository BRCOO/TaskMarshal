#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { resolve } from "node:path";

const REPO_ROOT = process.cwd();
const RUN_DIR = mkdtempSync(resolve(tmpdir(), "taskmarshal-quality-"));
const SESSION_ID = "tm-quality-benchmark";
const SESSION_DIR = resolve(homedir(), ".reasonixctl", "sessions", SESSION_ID);
const TASK_METRICS_PATH = resolve(RUN_DIR, ".taskmarshal", "task-metrics.jsonl");
const TASKMARSHAL_CLI = resolve(REPO_ROOT, "taskmarshalctl.js");
const BUDGETS = {
  successRateMin: 1,
  taskPassRateMin: 1,
  unknownVerificationRateMax: 0,
  redoCountMax: 0,
  avgAssistantCharsMax: 1200,
  outputContractCoverageMin: 1,
  compactMetricsCharsMax: 3600
};

process.on("exit", cleanup);

prepareIsolatedFixture();
const compactMetrics = runTaskmarshal(["metrics", "--limit", "20", "--max-sessions", "1", "--compact"]);
const report = compactMetrics.data;
const taskVerification = report.taskVerification ?? { count: 0, byStatus: {} };
const totals = report.totals ?? {};
const quality = {
  workerTurnCount: totals.turnCount ?? 0,
  workerSuccessRate: totals.successRate ?? null,
  taskVerificationCount: taskVerification.count ?? 0,
  taskPassCount: taskVerification.byStatus?.pass ?? 0,
  taskFailCount: taskVerification.byStatus?.fail ?? 0,
  taskSkipCount: taskVerification.byStatus?.skip ?? 0,
  taskPassRate: taskVerification.count ? round((taskVerification.byStatus?.pass ?? 0) / taskVerification.count, 3) : null,
  unknownVerificationRate: totals.turnCount
    ? round((totals.unknownVerificationCount ?? 0) / totals.turnCount, 3)
    : null,
  redoCount: totals.redoCount ?? 0,
  avgAssistantChars: totals.avgAssistantChars ?? null,
  avgAssistantRawChars: totals.avgAssistantRawChars ?? null,
  outputContractCoverage: totals.turnCount
    ? round((totals.outputContractAppliedCount ?? 0) / totals.turnCount, 3)
    : null,
  outputContractTruncatedCount: totals.outputContractTruncatedCount ?? 0,
  compactMetricsChars: JSON.stringify(report).length,
  routingHints: report.routingHints ?? []
};
const budget = buildBudgetReport(quality);
const ok = compactMetrics.ok && Object.values(budget).every((item) => item.ok);

console.log(JSON.stringify({
  ok,
  generatedAt: new Date().toISOString(),
  note: "Deterministic local fixture. This is a quality regression gate for compact TaskMarshal telemetry, not a live worker A/B test.",
  budgets: budget,
  quality,
  compactMetrics: {
    compact: report.compact,
    totals: report.totals,
    taskVerification: report.taskVerification,
    routingHints: report.routingHints,
    recentCount: report.recentCount,
    metricsScan: report.metricsScan
  }
}, null, 2));

if (!ok) process.exitCode = 1;

function prepareIsolatedFixture() {
  cleanup();
  mkdirSync(SESSION_DIR, { recursive: true });
  mkdirSync(resolve(RUN_DIR, ".taskmarshal"), { recursive: true });
  const now = new Date().toISOString();
  const fixtureSortKey = "9999-12-31T23:59:59.999Z";
  const metrics = Array.from({ length: 6 }, (_, index) => ({
    ts: new Date(Date.now() - index * 1000).toISOString(),
    provider: "reasonix",
    session: SESSION_ID,
    model: index === 0 ? "deepseek-v4-pro" : "deepseek-v4-flash",
    turnId: `quality-turn-${index + 1}`,
    taskId: `quality-task-${index + 1}`,
    ok: true,
    stopReason: "end_turn",
    elapsedMs: 30000 + index,
    promptChars: 700 + index,
    workerPromptChars: 920 + index,
    assistantChars: 880 + index * 15,
    assistantRawChars: 5400 + index * 250,
    outputContractApplied: true,
    outputContractTruncated: true,
    outputContractMaxChars: 1200,
    permissionRequests: index === 0 ? 1 : 0,
    approvals: index === 0 ? 1 : 0,
    denials: 0,
    autoPermissions: 0,
    filesChanged: ["taskmarshalctl.js", "mcp-server.js"].slice(0, index % 2 + 1),
    verification: "unknown",
    redoCount: 0,
    error: null
  }));
  writeFileSync(resolve(SESSION_DIR, "metrics.jsonl"), `${metrics.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");
  writeFileSync(resolve(SESSION_DIR, "events.jsonl"), "", "utf8");
  writeFileSync(resolve(SESSION_DIR, "transcript.jsonl"), "", "utf8");
  writeFileSync(resolve(SESSION_DIR, "session.json"), `${JSON.stringify({
    id: SESSION_ID,
    status: "ready",
    busy: false,
    pid: null,
    port: null,
    token: null,
    dir: RUN_DIR,
    approve: "manual",
    model: "deepseek-v4-flash",
    sessionId: "synthetic-quality-benchmark",
    transcript: resolve(SESSION_DIR, "transcript.jsonl"),
    events: resolve(SESSION_DIR, "events.jsonl"),
    metrics: resolve(SESSION_DIR, "metrics.jsonl"),
    turnCount: metrics.length,
    errors: [],
    updatedAt: fixtureSortKey
  }, null, 2)}\n`, "utf8");
  writeFileSync(TASK_METRICS_PATH, `${metrics.map((record) => JSON.stringify({
    ts: record.ts,
    taskId: record.taskId,
    route: record.model === "deepseek-v4-pro" ? "pro" : "flash",
    risk: record.model === "deepseek-v4-pro" ? "high" : "medium",
    verification: "pass",
    command: "quality-fixture",
    exitCode: 0,
    session: SESSION_ID,
    turnId: record.turnId,
    stepCount: 3,
    completedSteps: 3
  })).join("\n")}\n`, "utf8");
}

function buildBudgetReport(quality) {
  return {
    workerSuccessRate: minBudget(quality.workerSuccessRate, BUDGETS.successRateMin),
    taskPassRate: minBudget(quality.taskPassRate, BUDGETS.taskPassRateMin),
    unknownVerificationRate: maxBudget(quality.unknownVerificationRate, BUDGETS.unknownVerificationRateMax),
    redoCount: maxBudget(quality.redoCount, BUDGETS.redoCountMax),
    avgAssistantChars: maxBudget(quality.avgAssistantChars, BUDGETS.avgAssistantCharsMax),
    outputContractCoverage: minBudget(quality.outputContractCoverage, BUDGETS.outputContractCoverageMin),
    compactMetricsChars: maxBudget(quality.compactMetricsChars, BUDGETS.compactMetricsCharsMax)
  };
}

function minBudget(actual, min) {
  return {
    actual,
    min,
    ok: actual !== null && actual >= min,
    headroom: actual === null ? null : round(actual - min, 3)
  };
}

function maxBudget(actual, max) {
  return {
    actual,
    max,
    ok: actual !== null && actual <= max,
    headroom: actual === null ? null : round(max - actual, 3)
  };
}

function runTaskmarshal(args) {
  const child = spawnSync(process.execPath, [TASKMARSHAL_CLI, ...args], {
    cwd: RUN_DIR,
    encoding: "utf8"
  });
  let data = null;
  try {
    data = child.stdout ? JSON.parse(child.stdout) : null;
  } catch (err) {
    return { ok: false, data: null, error: err.message, stderr: child.stderr };
  }
  return {
    ok: child.status === 0 && data?.ok !== false,
    data,
    error: child.stderr || data?.error || null
  };
}

function cleanup() {
  if (existsSync(SESSION_DIR)) rmSync(SESSION_DIR, { recursive: true, force: true });
  if (existsSync(RUN_DIR)) rmSync(RUN_DIR, { recursive: true, force: true });
}

function round(value, digits) {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

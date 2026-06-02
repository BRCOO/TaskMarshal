#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

const cases = [
  {
    name: "small local",
    args: ["route", "--goal", "tiny docs edit", "--scope", "README.md", "--risk", "low", "--files", "1"],
    expect: (data) => data.route === "local"
  },
  {
    name: "multi file flash",
    args: ["route", "--goal", "refactor provider adapter", "--scope", "a.js,b.js,c.js", "--risk", "medium", "--files", "3"],
    expect: (data) => data.route === "flash"
  },
  {
    name: "security pro",
    args: ["route", "--goal", "security auth migration review", "--scope", "auth.js", "--risk", "high", "--files", "1"],
    expect: (data) => data.route === "pro"
  }
];

const results = [];
for (const test of cases) {
  const result = run(test.args);
  const passed = result.ok && test.expect(result.data);
  results.push({ name: test.name, passed, data: result.data, error: result.error });
}

const metricsAwareRoute = run(["route", "--goal", "refactor provider adapter", "--scope", "a.js,b.js,c.js", "--risk", "medium", "--files", "3"]);
results.push({
  name: "metrics-aware route evidence",
  passed: metricsAwareRoute.ok
    && metricsAwareRoute.data?.metricsEvidence?.source === "compact_metrics"
    && Number.isInteger(metricsAwareRoute.data?.metricsEvidence?.turnCount),
  data: metricsAwareRoute.data,
  error: metricsAwareRoute.error
});

const task = run(["task-create", "--goal", "eval token firewall", "--scope", "taskmarshalctl.js", "--risk", "low", "--route", "flash", "--steps", "plan;verify"]);
let gatePassed = false;
if (task.ok && task.data.taskId) {
  run(["checkpoint", "--id", task.data.taskId, "--step", "s1", "--note", "eval"]);
  run(["checkpoint", "--id", task.data.taskId, "--step", "s2", "--note", "eval"]);
  run(["verify", "--id", task.data.taskId, "--status", "pass", "--command", "eval"]);
  const done = run(["finalize", "--id", task.data.taskId]);
  gatePassed = done.ok && done.data.done === true && typeof done.data.taskKey === "string";
  results.push({ name: "task gate finalizes", passed: gatePassed, data: done.data, error: done.error });
} else {
  results.push({ name: "task gate finalizes", passed: false, data: task.data, error: task.error });
}

const verificationSessionId = "tm-eval-verification-link";
const verificationTurnId = "synthetic-verify-turn";
createSyntheticMetricsSession(verificationSessionId, verificationTurnId);
const linkedTask = run(["task-create", "--goal", "eval verification link", "--scope", "taskmarshalctl.js", "--risk", "low", "--route", "flash", "--steps", "verify"]);
if (linkedTask.ok && linkedTask.data.taskId) {
  run(["checkpoint", "--id", linkedTask.data.taskId, "--step", "s1", "--note", "eval"]);
  const linkedVerify = run([
    "verify",
    "--id",
    linkedTask.data.taskId,
    "--status",
    "pass",
    "--command",
    "eval",
    "--session",
    verificationSessionId,
    "--turn-id",
    verificationTurnId
  ]);
  const metrics = readSyntheticMetrics(verificationSessionId);
  results.push({
    name: "verification links session metric",
    passed: linkedVerify.ok
      && linkedVerify.data?.linkedMetric?.ok === true
      && metrics.some((record) => record.turnId === verificationTurnId && record.verification === "pass"),
    data: { verify: linkedVerify.data, metrics },
    error: linkedVerify.error
  });
} else {
  results.push({ name: "verification links session metric", passed: false, data: linkedTask.data, error: linkedTask.error });
}

const compactMetrics = run(["metrics", "--limit", "8", "--compact"]);
results.push({
  name: "compact metrics",
  passed: compactMetrics.ok
    && compactMetrics.data?.compact === true
    && Array.isArray(compactMetrics.data?.routingHints)
    && Array.isArray(compactMetrics.data?.recent)
    && compactMetrics.data.recent.length <= 3
    && compactMetrics.data?.metricsScan?.perSessionMetricLimit <= 50
    && compactMetrics.data?.taskVerification?.recent === undefined,
  data: compactMetrics.data,
  error: compactMetrics.error
});

const observeSessionId = "tm-eval-observe-cursor";
createSyntheticSession(observeSessionId);
const observeOne = run(["observe", observeSessionId, "--mode", "summary", "--tail", "5"], false);
if (observeOne.ok && Number.isInteger(observeOne.data?.cursor?.cursor)) {
  const observeTwo = run(["observe", observeSessionId, "--mode", "summary", "--tail", "5", "--since", String(observeOne.data.cursor.cursor)], false);
  results.push({
    name: "observe cursor",
    passed: observeTwo.ok && observeTwo.data?.cursor?.since === observeOne.data.cursor.cursor,
    data: observeTwo.data,
    error: observeTwo.error
  });
}

const ok = results.every((item) => item.passed);
console.log(JSON.stringify({ ok, results }, null, 2));
if (!ok) process.exitCode = 1;

function run(args, includeError = true) {
  const child = spawnSync(process.execPath, ["taskmarshalctl.js", ...args], {
    cwd: process.cwd(),
    encoding: "utf8"
  });
  let data = null;
  try {
    data = child.stdout ? JSON.parse(child.stdout) : null;
  } catch (err) {
    return { ok: false, data: null, error: err.message };
  }
  return {
    ok: child.status === 0 && data?.ok !== false,
    data,
    error: includeError ? child.stderr || data?.error || null : null
  };
}

function createSyntheticSession(id) {
  const sessionDir = resolve(homedir(), ".reasonixctl", "sessions", id);
  if (existsSync(sessionDir)) rmSync(sessionDir, { recursive: true, force: true });
  mkdirSync(sessionDir, { recursive: true });
  const eventsPath = resolve(sessionDir, "events.jsonl");
  const now = new Date().toISOString();
  const events = [
    { ts: now, method: "control/start", id },
    { ts: now, type: "agent_message_chunk", text: "synthetic" },
    { ts: now, method: "control/turn_finished", turn: { turnId: "synthetic-turn", finishedAt: now, stopReason: "end_turn" } }
  ];
  writeFileSync(eventsPath, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");
  writeFileSync(resolve(sessionDir, "session.json"), `${JSON.stringify({
    id,
    status: "ready",
    busy: false,
    pid: null,
    port: null,
    token: null,
    dir: process.cwd(),
    approve: "cancel",
    model: "deepseek-v4-flash",
    events: eventsPath,
    errors: [],
    lastTurn: events.at(-1).turn,
    updatedAt: now
  }, null, 2)}\n`, "utf8");
}

function createSyntheticMetricsSession(id, turnId) {
  createSyntheticSession(id);
  const now = new Date().toISOString();
  const sessionDir = resolve(homedir(), ".reasonixctl", "sessions", id);
  writeFileSync(resolve(sessionDir, "metrics.jsonl"), `${JSON.stringify({
    ts: now,
    provider: "reasonix",
    session: id,
    model: "deepseek-v4-flash",
    turnId,
    ok: true,
    stopReason: "end_turn",
    elapsedMs: 100,
    promptChars: 10,
    assistantChars: 20,
    permissionRequests: 0,
    approvals: 0,
    denials: 0,
    autoPermissions: 0,
    filesChanged: [],
    verification: "unknown",
    redoCount: 0,
    error: null
  })}\n`, "utf8");
}

function readSyntheticMetrics(id) {
  const metricsPath = resolve(homedir(), ".reasonixctl", "sessions", id, "metrics.jsonl");
  return existsSync(metricsPath)
    ? readFileSync(metricsPath, "utf8").trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))
    : [];
}

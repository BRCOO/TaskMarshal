#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import {
  enforceWorkerOutputContract,
  prepareWorkerPrompt,
  resolveWorkerOutputContract
} from "../lib/worker-output-contract.js";

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
  },
  {
    name: "local machine state stays local",
    args: ["route", "--goal", "audit installed TaskMarshal skill in ~/.codex/skills", "--scope", "~/.codex/skills/taskmarshal/SKILL.md", "--risk", "medium", "--files", "3"],
    expect: (data) => data.route === "local" && data.reasonCodes?.includes("LOCAL_MACHINE_STATE")
  },
  {
    name: "local logs and ledgers stay local",
    args: ["route", "--goal", "inspect .reasonixctl session logs and .taskmarshal task ledgers", "--scope", ".reasonixctl,.taskmarshal", "--risk", "low", "--files", "3"],
    expect: (data) => data.route === "local" && data.reasonCodes?.includes("LOCAL_MACHINE_STATE")
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

const defaultContract = resolveWorkerOutputContract({}, {});
const preparedContract = prepareWorkerPrompt("inspect the provider adapter", defaultContract);
const longWorkerText = "changedFiles: none\ncommands: none\nverification: pending\nrisks: ".padEnd(1800, "x");
const enforcedContract = enforceWorkerOutputContract(longWorkerText, defaultContract);
const disabledContract = resolveWorkerOutputContract({}, { TASKMARSHAL_WORKER_OUTPUT_CONTRACT: "0" });
results.push({
  name: "worker output contract",
  passed: defaultContract.enabled === true
    && defaultContract.maxChars === 1200
    && preparedContract.workerText.includes("Output contract:")
    && preparedContract.workerText.includes("changedFiles, commands, verification, risks, next")
    && enforcedContract.truncated === true
    && enforcedContract.text.length <= defaultContract.maxChars
    && disabledContract.enabled === false,
  data: {
    defaultContract,
    injected: preparedContract.outputContract.injected,
    enforced: {
      rawChars: enforcedContract.rawChars,
      finalChars: enforcedContract.text.length,
      truncated: enforcedContract.truncated
    },
    disabledContract
  },
  error: null
});

const configPath = resolve(process.cwd(), ".taskmarshal", "eval-codex-config.toml");
if (existsSync(configPath)) rmSync(configPath, { force: true });
const configPrint = run(["install-codex-config"]);
const configWrite = run(["install-codex-config", "--write-user", "--config", configPath, "--server", resolve(process.cwd(), "mcp-server.js")]);
const configWriteAgain = run(["install-codex-config", "--write-user", "--config", configPath, "--server", resolve(process.cwd(), "mcp-server.js")]);
const configUltraPrint = run(["install-codex-config", "--profile", "ultra-minimal"]);
const configText = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";
const configMergePath = resolve(process.cwd(), ".taskmarshal", "eval-codex-config-merge.toml");
writeFileSync(configMergePath, [
  "[mcp_servers.taskmarshal-mcp]",
  "command = \"old-node\"",
  "custom = \"keep\"",
  "",
  "[mcp_servers.taskmarshal-mcp.env]",
  "EXISTING_FLAG = \"keep\"",
  "TASKMARSHAL_TOOL_PROFILE = \"standard\"",
  ""
].join("\n"), "utf8");
const configMerge = run(["install-codex-config", "--write-user", "--config", configMergePath, "--server", resolve(process.cwd(), "mcp-server.js")]);
const configMergeText = existsSync(configMergePath) ? readFileSync(configMergePath, "utf8") : "";
results.push({
  name: "install codex config",
  passed: configPrint.ok
    && configPrint.data?.snippet?.includes("TASKMARSHAL_TOOL_PROFILE = \"minimal\"")
    && configUltraPrint.ok
    && configUltraPrint.data?.env?.TASKMARSHAL_TOOL_PROFILE === "ultra-minimal"
    && configUltraPrint.data?.snippet?.includes("TASKMARSHAL_TOOL_PROFILE = \"ultra-minimal\"")
    && configWrite.ok
    && configWrite.data?.changed === true
    && configWriteAgain.ok
    && configWriteAgain.data?.changed === false
    && configText.includes("[mcp_servers.taskmarshal-mcp.env]")
    && configText.includes("TASKMARSHAL_COMPACT_TOOL_TEXT = \"1\"")
    && configText.includes("TASKMARSHAL_WORKER_OUTPUT_CONTRACT = \"1\"")
    && configText.includes("TASKMARSHAL_WORKER_OUTPUT_MAX_CHARS = \"1200\"")
    && configMerge.ok
    && configMergeText.includes("custom = \"keep\"")
    && configMergeText.includes("EXISTING_FLAG = \"keep\"")
    && configMergeText.includes("TASKMARSHAL_TOOL_PROFILE = \"minimal\"")
    && configMergeText.includes("TASKMARSHAL_WORKER_OUTPUT_MAX_CHARS = \"1200\""),
  data: { print: configPrint.data, ultraPrint: configUltraPrint.data, write: configWrite.data, writeAgain: configWriteAgain.data, merge: configMerge.data },
  error: configPrint.error || configUltraPrint.error || configWrite.error || configWriteAgain.error || configMerge.error
});

const task = run(["task-create", "--id", "tm-eval-token-firewall", "--goal", "eval token firewall", "--scope", "taskmarshalctl.js", "--risk", "low", "--route", "flash", "--steps", "plan;verify"]);
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

const readonlyTask = run([
  "task-create",
  "--id",
  "tm-eval-readonly-close",
  "--goal",
  "eval read-only close helper",
  "--scope",
  "taskmarshalctl.js",
  "--risk",
  "low",
  "--route",
  "flash",
  "--steps",
  "inspect;report"
]);
if (readonlyTask.ok && readonlyTask.data.taskId) {
  const closeReadonly = run([
    "close-readonly",
    "--id",
    readonlyTask.data.taskId,
    "--status",
    "pass",
    "--command",
    "read-only eval",
    "--note",
    "eval"
  ]);
  results.push({
    name: "close-readonly finalizes read-only task",
    passed: closeReadonly.ok
      && closeReadonly.data?.done === true
      && closeReadonly.data?.completed === closeReadonly.data?.totalSteps
      && typeof closeReadonly.data?.taskKey === "string",
    data: closeReadonly.data,
    error: closeReadonly.error
  });
} else {
  results.push({ name: "close-readonly finalizes read-only task", passed: false, data: readonlyTask.data, error: readonlyTask.error });
}

const compactTasks = run(["tasks", "--compact", "--limit", "5"]);
results.push({
  name: "compact tasks report",
  passed: compactTasks.ok
    && compactTasks.data?.compact === true
    && compactTasks.data?.totals?.taskCount >= 1
    && Number.isInteger(compactTasks.data?.totals?.openOrBlockedCount)
    && Array.isArray(compactTasks.data?.guidance)
    && Array.isArray(compactTasks.data?.recent)
    && compactTasks.data.recent.length <= 3,
  data: compactTasks.data,
  error: compactTasks.error
});

const verificationSessionId = "tm-eval-verification-link";
const verificationTurnId = "synthetic-verify-turn";
createSyntheticMetricsSession(verificationSessionId, verificationTurnId);
const linkedTask = run(["task-create", "--id", "tm-eval-verification-link-task", "--goal", "eval verification link", "--scope", "taskmarshalctl.js", "--risk", "low", "--route", "flash", "--steps", "verify"]);
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

const mergeSessionId = "tm-eval-taskid-merge";
const mergeTurnId = "synthetic-merge-turn";
const mergeTask = run(["task-create", "--id", "tm-eval-taskid-merge-task", "--goal", "eval taskid merge", "--scope", "taskmarshalctl.js", "--risk", "low", "--route", "flash", "--steps", "verify"]);
if (mergeTask.ok && mergeTask.data.taskId) {
  createSyntheticMetricsSession(mergeSessionId, mergeTurnId, mergeTask.data.taskId);
  run(["checkpoint", "--id", mergeTask.data.taskId, "--step", "s1", "--note", "eval"]);
  run(["verify", "--id", mergeTask.data.taskId, "--status", "fail", "--command", "eval-fail"]);
  const mergeVerify = run(["verify", "--id", mergeTask.data.taskId, "--status", "pass", "--command", "eval"]);
  const mergedMetrics = run(["metrics", "--limit", "20", "--compact"]);
  const mergedRecord = mergedMetrics.data?.recent?.find((record) => record.verification === "pass" && record.assistantChars === 20);
  results.push({
    name: "metrics merge verification by task id",
    passed: mergeVerify.ok && mergedMetrics.ok && Boolean(mergedRecord),
    data: { verify: mergeVerify.data, mergedRecord, taskVerification: mergedMetrics.data?.taskVerification },
    error: mergeVerify.error || mergedMetrics.error
  });
} else {
  results.push({ name: "metrics merge verification by task id", passed: false, data: mergeTask.data, error: mergeTask.error });
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

function createSyntheticMetricsSession(id, turnId, taskId = null) {
  createSyntheticSession(id);
  const now = new Date().toISOString();
  const sessionDir = resolve(homedir(), ".reasonixctl", "sessions", id);
  writeFileSync(resolve(sessionDir, "metrics.jsonl"), `${JSON.stringify({
    ts: now,
    provider: "reasonix",
    session: id,
    model: "deepseek-v4-flash",
    turnId,
    taskId,
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

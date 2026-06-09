#!/usr/bin/env node
import { spawn } from "node:child_process";
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  statSync,
  writeFileSync
} from "node:fs";
import { readdir } from "node:fs/promises";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { AcpClient, compactEvent } from "./lib/acp-client.js";
import { buildContextPacket } from "./lib/context-adapter.js";
import {
  DEFAULT_WORKER_OUTPUT_MAX_CHARS,
  WORKER_OUTPUT_FIELDS,
  contractPromptRecord,
  enforceWorkerOutputContract,
  outputContractRecord,
  prepareWorkerPrompt,
  resolveWorkerOutputContract
} from "./lib/worker-output-contract.js";

const VERSION = "0.1.0";
const WORKFLOW_DIR = resolve(process.cwd(), ".taskmarshal");
const TASK_DIR = resolve(WORKFLOW_DIR, "tasks");
const STATE_DIR = resolve(homedir(), ".reasonixctl");
const SESSION_DIR = resolve(STATE_DIR, "sessions");
const REASONIX_COMMAND = resolveReasonixCommand();
const THIS_FILE = fileURLToPath(import.meta.url);
const REASONIX_MODELS = [
  {
    id: "deepseek-v4-flash",
    aliases: ["flash", "v4-flash", "deepseek-flash"],
    useFor: "Fast, low-cost analysis, repo exploration, routine implementation, and long sessions."
  },
  {
    id: "deepseek-v4-pro",
    aliases: ["pro", "v4-pro", "deepseek-pro"],
    useFor: "Hard architecture, tricky debugging, final review, and tasks where higher reasoning quality is worth the cost."
  }
];
const REASONIX_MODEL_ALIASES = new Map(
  REASONIX_MODELS.flatMap((model) => [[model.id, model.id], ...model.aliases.map((alias) => [alias, model.id])])
);
function main() {
  const [cmd = "help", ...args] = process.argv.slice(2);
  if (cmd === "help" || cmd === "-h" || cmd === "--help") return help();
  if (cmd === "version" || cmd === "--version" || cmd === "-V") return output({ version: VERSION });
  if (cmd === "doctor") return doctor();
  if (cmd === "models") return models();
  if (cmd === "install-codex-config") return installCodexConfig(args);
  if (cmd === "ask") return ask(args);
  if (cmd === "smoke") return smoke();
  if (cmd === "context") return contextCommand(args);
  if (cmd === "metrics") return metricsReport(args);
  if (cmd === "tasks") return tasksReport(args);
  if (cmd === "route") return routeDecision(args);
  if (cmd === "task-create") return taskCreate(args);
  if (cmd === "checkpoint") return checkpointStep(args);
  if (cmd === "verify") return recordVerification(args);
  if (cmd === "close-readonly") return closeReadonlyTask(args);
  if (cmd === "close-verified") return closeVerifiedTask(args);
  if (cmd === "finalize") return finalizeTask(args);
  if (cmd === "start") return startSession(args);
  if (cmd === "list") return listSessions();
  if (cmd === "status") return statusSession(args);
  if (cmd === "send") return sendSession(args);
  if (cmd === "observe") return observeSession(args);
  if (cmd === "summarize") return summarizeSession(args);
  if (cmd === "cancel") return postSessionCommand(args, "cancel");
  if (cmd === "approve") return permissionCommand(args, "approve");
  if (cmd === "deny") return permissionCommand(args, "deny");
  if (cmd === "stop") return postSessionCommand(args, "stop");
  if (cmd === "daemon") return daemon(args);
  throw new Error(`Unknown command: ${cmd}`);
}

async function doctor() {
  const reasonix = await runCommand(REASONIX_COMMAND.command, [...REASONIX_COMMAND.prefixArgs, "--version"]);
  const cfgPath = resolve(homedir(), ".reasonix", "config.json");
  const cfg = readJsonLenient(cfgPath);
  output({
    ok: reasonix.exitCode === 0 && Boolean(cfg?.apiKey),
    reasonix: {
      exitCode: reasonix.exitCode,
      version: reasonix.stdout.split(/\r?\n/).find(Boolean) || null
    },
    config: {
      path: cfgPath,
      exists: existsSync(cfgPath),
      apiKeyConfigured: Boolean(cfg?.apiKey),
      preset: cfg?.preset ?? null
    },
    stateDir: STATE_DIR,
    sessionDir: SESSION_DIR,
    node: process.version
  });
}

function installCodexConfig(args) {
  const opts = parseInstallCodexConfigArgs(args);
  const configPath = opts.config
    ? resolve(opts.config)
    : resolve(homedir(), ".codex", "config.toml");
  const serverName = opts.name || "taskmarshal-mcp";
  const serverPath = opts.server
    ? resolve(opts.server)
    : THIS_FILE.replace(/[\\/]taskmarshalctl\.js$/, `${process.platform === "win32" ? "\\" : "/"}mcp-server.js`);
  const snippet = buildCodexMcpTomlSnippet({ name: serverName, serverPath, profile: opts.profile });

  if (!opts.writeUser) {
    output({
      ok: true,
      mode: "print",
      configPath,
      serverName,
      serverPath,
      env: codexMcpEnv({ profile: opts.profile }),
      snippet,
      next: `Run with --write-user to update ${configPath}. Restart Codex after changing MCP config.`
    });
    return;
  }

  const result = writeCodexMcpConfig({ configPath, name: serverName, serverPath, profile: opts.profile });
  output({
    ok: true,
    mode: "write",
    configPath,
    backupPath: result.backupPath,
    serverName,
    serverPath,
    env: codexMcpEnv({ profile: opts.profile }),
    changed: result.changed,
    next: "Restart Codex or open a fresh thread for MCP config changes to take effect."
  });
}

function models() {
  output({
    ok: true,
    provider: "reasonix",
    models: REASONIX_MODELS,
    presets: ["auto", "flash", "pro"],
    note: "TaskMarshal accepts aliases such as flash/pro and passes canonical DeepSeek v4 model ids to reasonix --model."
  });
}

async function smoke() {
  const dir = ensureRunDir();
  const transcript = resolve(dir, "smoke-transcript.jsonl");
  const events = resolve(dir, "smoke-events.jsonl");
  const result = await runAcpTurn({
    dir: process.cwd(),
    text: "Say exactly: taskmarshalctl smoke ok. Do not use tools.",
    transcript,
    events,
    approve: "cancel",
    outputContract: { enabled: false }
  });
  output({ ok: true, run: result });
}

async function ask(args) {
  const parsed = parseAskArgs(args);
  if (!parsed.text) throw new Error("ask requires a prompt. Example: taskmarshalctl ask \"summarize this repo\"");
  const runDir = ensureRunDir();
  const transcript = parsed.transcript || resolve(runDir, "transcript.jsonl");
  const events = parsed.events || resolve(runDir, "events.jsonl");
  const result = await runAcpTurn({
    dir: parsed.dir,
    text: parsed.text,
    transcript,
    events,
    approve: parsed.approve,
    yolo: parsed.yolo,
    model: parsed.model,
    preset: parsed.preset,
    budget: parsed.budget,
    outputContract: parsed.outputContract
  });
  output(result, parsed.json);
}

async function startSession(args) {
  const opts = parseStartArgs(args);
  const id = opts.id || `rx-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${randomBytes(3).toString("hex")}`;
  const dir = resolve(opts.dir);
  const runDir = resolve(SESSION_DIR, id);
  const existingMeta = readJsonLenient(resolve(runDir, "session.json"));
  if (existingMeta?.pid && processAlive(existingMeta.pid)) {
    output({ ok: false, error: `session already running: ${id}`, session: redactMeta(existingMeta) });
    process.exitCode = 1;
    return;
  }
  mkdirSync(runDir, { recursive: true });
  const metaPath = resolve(runDir, "session.json");
  const transcript = resolve(runDir, "transcript.jsonl");
  const events = resolve(runDir, "events.jsonl");
  const metrics = resolve(runDir, "metrics.jsonl");
  const token = randomBytes(18).toString("hex");
  const baseMeta = {
    id,
    status: "starting",
    startedAt: new Date().toISOString(),
    dir,
    pid: null,
    port: null,
    token,
    approve: opts.approve,
    model: opts.model ?? null,
    preset: opts.preset ?? null,
    budget: opts.budget ?? null,
    sessionId: null,
    transcript,
    events,
    metrics
  };
  writeJson(metaPath, baseMeta);

  const childArgs = [
    THIS_FILE,
    "daemon",
    "--id", id,
    "--dir", dir,
    "--meta", metaPath,
    "--token", token,
    "--approve", opts.approve,
    "--transcript", transcript,
    "--events", events,
    "--metrics", metrics
  ];
  if (opts.yolo) childArgs.push("--yolo");
  if (opts.model) childArgs.push("--model", opts.model);
  if (opts.preset) childArgs.push("--preset", opts.preset);
  if (opts.budget) childArgs.push("--budget", opts.budget);

  const child = spawn(process.execPath, childArgs, {
    cwd: dir,
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });
  child.unref();
  await waitForReady(metaPath, 15000);
  const meta = readJsonLenient(metaPath);
  const payload = {
    ok: meta?.status === "ready",
    id,
    status: meta?.status,
    pid: meta?.pid,
    port: meta?.port,
    dir,
    sessionId: meta?.sessionId,
    approve: meta?.approve,
    model: meta?.model ?? null,
    preset: meta?.preset ?? null,
    budget: meta?.budget ?? null,
    transcript,
    events,
    metrics
  };
  output(payload);
}

async function listSessions() {
  mkdirSync(SESSION_DIR, { recursive: true });
  const names = await readdir(SESSION_DIR).catch(() => []);
  const sessions = [];
  for (const name of names) {
    const metaPath = resolve(SESSION_DIR, name, "session.json");
    const meta = readJsonLenient(metaPath);
    if (!meta) continue;
    const alive = processAlive(meta.pid);
    sessions.push({
      id: meta.id,
      status: alive ? meta.status : "offline",
      pid: meta.pid,
      alive,
      dir: meta.dir,
      sessionId: meta.sessionId,
      approve: meta.approve,
      model: meta.model ?? null,
      preset: meta.preset ?? null,
      budget: meta.budget ?? null,
      startedAt: meta.startedAt,
      lastTurn: meta.lastTurn ?? null
    });
  }
  sessions.sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
  output({ ok: true, sessions });
}

async function statusSession(args) {
  const id = requireSessionId(args);
  const meta = readSessionMeta(id);
  const status = await daemonRequest(meta, "GET", "/status").catch((err) => ({ ok: false, error: err.message }));
  output({ ok: true, id, meta: redactMeta(meta), daemon: status });
}

async function sendSession(args) {
  const parsed = parseSendArgs(args);
  if (!parsed.text) throw new Error("send requires text. Example: taskmarshalctl send SESSION_ID \"analyze only\"");
  const meta = readSessionMeta(parsed.id);
  const result = await daemonRequest(meta, "POST", "/send", {
    text: parsed.text,
    wait: parsed.wait,
    taskId: parsed.taskId,
    outputContract: parsed.outputContract
  });
  output(result);
}

async function observeSession(args) {
  const { id, tail, mode, maxChars, since } = parseObserveArgs(args);
  const meta = readSessionMeta(id);
  const eventWindow = readJsonlWindow(meta.events, { tail, since });
  let daemonStatus = null;
  try {
    daemonStatus = await daemonRequest(meta, "GET", "/status");
  } catch {
    daemonStatus = { ok: false, status: "offline" };
  }
  output(formatObservation({
    id,
    mode,
    maxChars,
    eventWindow,
    status: daemonStatus,
    events: displayEvents(eventWindow.events),
    meta
  }));
}

async function summarizeSession(args) {
  const { id, maxChars } = parseSummarizeArgs(args);
  output(writeSessionSummary(id, { maxChars }));
}

async function metricsReport(args) {
  output(await buildMetricsReport(parseMetricsArgs(args)));
}

function tasksReport(args) {
  output(buildTasksReport(parseTasksArgs(args)));
}

async function contextCommand(args) {
  const [subcmd = "query", ...rest] = args;
  if (subcmd !== "query") throw new Error("context usage: taskmarshalctl context query --goal TEXT [--scope FILES] [--max-chars N] [--backend auto|codegraph|local-static]");
  const input = parseKeyValueArgs(rest);
  const goal = cleanText(input.goal);
  if (!goal) throw new Error("context query requires --goal TEXT");
  output(await buildContextPacket({
    root: input.dir ? resolve(input.dir) : process.cwd(),
    goal,
    scope: input.scope || "",
    maxChars: input.maxChars,
    backend: input.backend
  }));
}

async function routeDecision(args) {
  const input = parseKeyValueArgs(args);
  const metrics = await buildMetricsReport({ limit: 20, maxSessions: 200, compact: true });
  output(buildRouteDecision({ input, metrics }));
}

async function taskCreate(args) {
  const input = parseKeyValueArgs(args);
  const goal = cleanText(input.goal);
  if (!goal) throw new Error("task-create requires --goal TEXT");
  const scope = splitList(input.scope);
  const risk = normalizeRisk(input.risk);
  const route = input.route || buildRouteDecision({
    input: { ...input, risk, scope: scope.join(",") },
    metrics: await buildMetricsReport({ limit: 20, compact: true })
  }).route;
  const id = input.id || makeTaskId(goal);
  const dir = taskDir(id);
  const steps = buildTaskSteps({ goal, scope, risk, route, steps: splitList(input.steps) });
  const task = {
    id,
    version: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    goal: limitText(goal, 500),
    scope,
    risk,
    route,
    status: "open",
    steps,
    verification: null,
    taskKey: null
  };
  mkdirSync(dir, { recursive: true });
  writeJson(resolve(dir, "task.json"), task);
  writeJson(resolve(dir, "steps.json"), { taskId: id, steps });
  writeJson(resolve(dir, "worker-prompt.json"), buildWorkerPromptPacket(task));
  output(taskControlPacket(task, "send_worker"));
}

function recordVerification(args) {
  const input = parseKeyValueArgs(args);
  const id = input.id;
  if (!id) throw new Error("verify requires --id TASK_ID");
  const status = normalizeVerification(input.status);
  const task = readTask(id);
  output(recordVerificationData({
    task,
    status,
    command: input.command,
    exitCode: input.exitCode,
    note: input.note,
    session: input.session,
    turnId: input.turnId
  }));
}

function recordVerificationData({ task, status, command, exitCode, note, session, turnId }) {
  const verification = {
    status,
    command: limitText(cleanText(command), 300) || null,
    exitCode: exitCode === undefined ? null : Number(exitCode),
    note: limitText(cleanText(note), 500) || null,
    session: limitText(cleanText(session), 120) || null,
    turnId: limitText(cleanText(turnId), 120) || null,
    recordedAt: new Date().toISOString()
  };
  task.verification = verification;
  task.updatedAt = verification.recordedAt;
  writeTask(task);
  appendJsonl(resolve(WORKFLOW_DIR, "task-metrics.jsonl"), {
    ts: verification.recordedAt,
    taskId: task.id,
    route: task.route,
    risk: task.risk,
    verification: status,
    command: verification.command,
    exitCode: verification.exitCode,
    session: verification.session,
    turnId: verification.turnId,
    stepCount: task.steps.length,
    completedSteps: task.steps.filter((step) => step.status === "done").length
  });
  const linkedMetric = verification.session || verification.turnId
    ? updateSessionMetricVerification({
      sessionId: verification.session,
      turnId: verification.turnId,
      taskId: task.id,
      verification: status,
      verifiedAt: verification.recordedAt
    })
    : updateRecentSessionMetricVerificationByTaskId({
      taskId: task.id,
      verification: status,
      verifiedAt: verification.recordedAt
    });
  return {
    ok: true,
    taskId: task.id,
    verification: status,
    exitCode: verification.exitCode,
    linkedMetric,
    next: status === "pass" ? "finalize" : "fix_or_skip"
  };
}

function closeReadonlyTask(args) {
  const input = parseKeyValueArgs(args);
  const id = input.id;
  if (!id) throw new Error("close-readonly requires --id TASK_ID");
  const status = normalizeVerification(input.status || "pass");
  const task = readTask(id);
  const now = new Date().toISOString();
  const note = limitText(cleanText(input.note), 300) || "Read-only worker task closed.";
  for (const step of task.steps) {
    if (step.status !== "done") {
      step.status = "done";
      step.note = note;
      step.completedAt = now;
    }
  }
  task.updatedAt = now;
  writeTask(task);
  const verification = recordVerificationData({
    task,
    status,
    command: cleanText(input.command) || "read-only worker audit accepted",
    exitCode: input.exitCode,
    note,
    session: input.session,
    turnId: input.turnId
  });
  const finalized = finalizeTaskData(task.id);
  output({
    ok: Boolean(finalized.done),
    taskId: task.id,
    verification: verification.verification,
    linkedMetric: verification.linkedMetric,
    done: finalized.done,
    taskKey: finalized.taskKey,
    completed: finalized.completed,
    totalSteps: finalized.totalSteps,
    next: finalized.done ? "accept" : "inspect_task"
  });
}

function closeVerifiedTask(args) {
  const input = parseKeyValueArgs(args);
  const id = input.id;
  if (!id) throw new Error("close-verified requires --id TASK_ID");
  const task = readTask(id);
  const verification = task.verification?.status ?? "unknown";
  if (!["pass", "skip"].includes(verification)) {
    throw new Error("close-verified requires an existing pass or skip verification");
  }
  const now = new Date().toISOString();
  const note = limitText(cleanText(input.note), 300) || "Verified task closed.";
  for (const step of task.steps) {
    if (step.status !== "done") {
      step.status = "done";
      step.note = note;
      step.completedAt = now;
    }
  }
  task.updatedAt = now;
  writeTask(task);
  const finalized = finalizeTaskData(task.id);
  output({
    ok: Boolean(finalized.done),
    taskId: task.id,
    verification,
    done: finalized.done,
    taskKey: finalized.taskKey,
    completed: finalized.completed,
    totalSteps: finalized.totalSteps,
    next: finalized.done ? "accept" : "inspect_task"
  });
}

function checkpointStep(args) {
  const input = parseKeyValueArgs(args);
  const id = input.id;
  const stepId = input.step;
  if (!id) throw new Error("checkpoint requires --id TASK_ID");
  if (!stepId) throw new Error("checkpoint requires --step STEP_ID");
  const task = readTask(id);
  const step = task.steps.find((item) => item.id === stepId);
  if (!step) throw new Error(`Unknown step: ${stepId}`);
  step.status = "done";
  step.note = limitText(cleanText(input.note), 300) || null;
  step.completedAt = new Date().toISOString();
  task.updatedAt = step.completedAt;
  writeTask(task);
  const completed = task.steps.filter((item) => item.status === "done").length;
  output({
    ok: true,
    taskId: task.id,
    step: step.id,
    status: step.status,
    completed,
    totalSteps: task.steps.length,
    next: completed === task.steps.length ? "verify" : "checkpoint"
  });
}

function finalizeTask(args) {
  const input = parseKeyValueArgs(args);
  const id = input.id;
  if (!id) throw new Error("finalize requires --id TASK_ID");
  output(finalizeTaskData(id));
}

function finalizeTaskData(id) {
  const task = readTask(id);
  const completed = task.steps.filter((step) => step.status === "done").length;
  const verification = task.verification?.status ?? "unknown";
  const done = completed === task.steps.length && ["pass", "skip"].includes(verification);
  const taskKey = done ? task.taskKey || makeTaskKey(task) : null;
  task.status = done ? "done" : "blocked";
  task.taskKey = taskKey;
  task.updatedAt = new Date().toISOString();
  writeTask(task);
  return {
    ok: done,
    taskId: task.id,
    done,
    taskKey,
    completed,
    totalSteps: task.steps.length,
    verification,
    next: done ? "accept" : "complete_steps_or_verify"
  };
}

async function postSessionCommand(args, command) {
  const id = requireSessionId(args);
  const meta = readSessionMeta(id);
  const daemonStatus = command === "stop"
    ? await daemonRequest(meta, "GET", "/status").catch(() => null)
    : null;
  const result = await daemonRequest(meta, "POST", `/${command}`, {});
  if (command === "stop") {
    output({ ...result, summary: writeSessionSummary(id, { daemonStatus }) });
    return;
  }
  output(result);
}

async function permissionCommand(args, action) {
  const id = requireSessionId(args);
  const meta = readSessionMeta(id);
  const result = await daemonRequest(meta, "POST", "/permission", { action });
  output(result);
}

async function daemon(args) {
  const opts = parseDaemonArgs(args);
  const metaPath = opts.meta;
  const events = opts.events;
  const transcript = opts.transcript;
  const dir = opts.dir;
  const token = opts.token;
  const state = {
    id: opts.id,
    status: "starting",
    busy: false,
    currentTurnId: null,
    currentPrompt: null,
    currentTaskId: null,
    currentOutputContract: null,
    assistantText: "",
    pendingPermission: null,
    permissionResolver: null,
    metrics: {
      permissionRequests: 0,
      approvals: 0,
      denials: 0,
      autoPermissions: 0
    },
    currentTurnMetrics: null,
    turns: [],
    errors: []
  };
  const eventSink = (record) => appendJsonl(events, { ts: new Date().toISOString(), ...record });

  const acpArgs = [...REASONIX_COMMAND.prefixArgs, "acp", "--dir", dir, "--transcript", transcript];
  if (opts.yolo) acpArgs.push("--yolo");
  if (opts.model) acpArgs.push("--model", opts.model);
  if (opts.preset) acpArgs.push("--preset", opts.preset);
  if (opts.budget) acpArgs.push("--budget", opts.budget);
  const client = new AcpClient({ command: REASONIX_COMMAND.command, args: acpArgs, cwd: dir });

  client.on("session/update", (params) => {
    const compact = compactEvent({ method: "session/update", params });
    eventSink(compact);
    if (compact.type === "agent_message_chunk") state.assistantText += compact.text;
  });
  client.on("session/request_permission", (params) => {
    eventSink({ method: "session/request_permission", params });
    state.metrics.permissionRequests += 1;
    if (state.currentTurnMetrics) state.currentTurnMetrics.permissionRequests += 1;
    if (opts.approve !== "manual") {
      const optionId = choosePermissionOption(params, opts.approve);
      eventSink({ method: "control/permission_auto", mode: opts.approve, selected: Boolean(optionId) });
      state.metrics.autoPermissions += 1;
      if (state.currentTurnMetrics) state.currentTurnMetrics.autoPermissions += 1;
      if (!optionId) return { outcome: { outcome: "cancelled" } };
      return { outcome: { outcome: "selected", optionId } };
    }
    const permissionId = `perm-${Date.now()}`;
    return new Promise((resolvePermission) => {
      state.pendingPermission = { id: permissionId, params, createdAt: new Date().toISOString() };
      state.permissionResolver = resolvePermission;
      writeDaemonMeta(metaPath, opts, state);
    });
  });

  client.start();
  const init = await client.initialize();
  const session = await client.newSession({ cwd: dir });
  state.status = "ready";
  state.sessionId = session.sessionId;

  const server = createServer(async (req, res) => {
    try {
      if (req.headers["x-reasonixctl-token"] !== token) {
        return sendHttp(res, 401, { ok: false, error: "unauthorized" });
      }
      if (req.method === "GET" && req.url === "/status") {
        return sendHttp(res, 200, publicDaemonState(opts, state));
      }
      if (req.method === "POST" && req.url === "/send") {
        const body = await readBody(req);
        if (state.busy) return sendHttp(res, 409, { ok: false, error: "session busy", state: publicDaemonState(opts, state) });
        const turnId = randomUUID();
        const userText = body.text || "";
        const outputContract = resolveWorkerOutputContract(body.outputContract);
        const preparedPrompt = prepareWorkerPrompt(userText, outputContract);
        state.busy = true;
        state.status = "running";
        state.currentTurnId = turnId;
        state.currentPrompt = userText;
        state.currentTaskId = cleanTaskId(body.taskId);
        state.currentOutputContract = preparedPrompt.outputContract;
        state.assistantText = "";
        state.currentTurnMetrics = {
          permissionRequests: 0,
          approvals: 0,
          denials: 0,
          autoPermissions: 0,
          outputContract: preparedPrompt.outputContract
        };
        writeDaemonMeta(metaPath, opts, state);
        runTurn(client, opts, state, eventSink, metaPath, preparedPrompt, turnId).catch((err) => {
          state.errors.push({ ts: new Date().toISOString(), message: err.message });
          state.status = "error";
          state.busy = false;
          writeDaemonMeta(metaPath, opts, state);
        });
        return sendHttp(res, 202, { ok: true, id: opts.id, turnId, status: "accepted" });
      }
      if (req.method === "POST" && req.url === "/cancel") {
        if (state.pendingPermission && state.permissionResolver) {
          state.permissionResolver({ outcome: { outcome: "cancelled" } });
          state.pendingPermission = null;
          state.permissionResolver = null;
        }
        client.cancel(session.sessionId);
        eventSink({ method: "control/cancel", turnId: state.currentTurnId });
        return sendHttp(res, 200, { ok: true, status: "cancel_requested" });
      }
      if (req.method === "POST" && req.url === "/permission") {
        const body = await readBody(req);
        if (!state.pendingPermission || !state.permissionResolver) {
          return sendHttp(res, 404, { ok: false, error: "no pending permission" });
        }
        const resolver = state.permissionResolver;
        const pending = state.pendingPermission;
        state.pendingPermission = null;
        state.permissionResolver = null;
        const optionId = body.action === "approve"
          ? choosePermissionOption(pending.params, "once")
          : choosePermissionOption(pending.params, "reject");
        eventSink({ method: "control/permission", action: body.action, permissionId: pending.id });
        if (body.action === "approve") {
          state.metrics.approvals += 1;
          if (state.currentTurnMetrics) state.currentTurnMetrics.approvals += 1;
        } else {
          state.metrics.denials += 1;
          if (state.currentTurnMetrics) state.currentTurnMetrics.denials += 1;
        }
        if (!optionId || body.action === "deny") resolver({ outcome: { outcome: "cancelled" } });
        else resolver({ outcome: { outcome: "selected", optionId } });
        writeDaemonMeta(metaPath, opts, state);
        return sendHttp(res, 200, { ok: true, action: body.action });
      }
      if (req.method === "POST" && req.url === "/stop") {
        sendHttp(res, 200, { ok: true, status: "stopping" });
        setTimeout(() => {
          client.close();
          server.close();
          process.exit(0);
        }, 50);
        return;
      }
      return sendHttp(res, 404, { ok: false, error: "not found" });
    } catch (err) {
      return sendHttp(res, 500, { ok: false, error: err.message });
    }
  });

  await new Promise((resolveServer) => server.listen(0, "127.0.0.1", resolveServer));
  const address = server.address();
  state.port = address.port;
  state.init = init;
  writeDaemonMeta(metaPath, opts, state);
}

async function runAcpTurn({ dir, text, transcript, events, approve = "cancel", yolo = false, model, preset, budget, outputContract }) {
  const acpArgs = [...REASONIX_COMMAND.prefixArgs, "acp", "--dir", dir, "--transcript", transcript];
  if (yolo) acpArgs.push("--yolo");
  if (model) acpArgs.push("--model", model);
  if (preset) acpArgs.push("--preset", preset);
  if (budget) acpArgs.push("--budget", budget);
  const client = new AcpClient({ command: REASONIX_COMMAND.command, args: acpArgs, cwd: dir });
  const startedAt = new Date().toISOString();
  const eventSink = (record) => appendJsonl(events, { ts: new Date().toISOString(), ...record });
  let assistantText = "";
  let permissionRequests = 0;

  client.on("session/update", (params) => {
    const compact = compactEvent({ method: "session/update", params });
    eventSink(compact);
    if (compact.type === "agent_message_chunk") assistantText += compact.text;
  });
  client.on("session/request_permission", (params) => {
    permissionRequests += 1;
    eventSink({ method: "session/request_permission", params });
    const optionId = choosePermissionOption(params, approve);
    if (!optionId) return { outcome: { outcome: "cancelled" } };
    return { outcome: { outcome: "selected", optionId } };
  });

  client.start();
  try {
    const init = await client.initialize();
    const session = await client.newSession({ cwd: dir });
    const preparedPrompt = prepareWorkerPrompt(text, resolveWorkerOutputContract(outputContract));
    const turn = await client.prompt({ sessionId: session.sessionId, text: preparedPrompt.workerText });
    const enforced = enforceWorkerOutputContract(assistantText.trim(), preparedPrompt.outputContract);
    const result = {
      ok: true,
      startedAt,
      finishedAt: new Date().toISOString(),
      dir,
      sessionId: session.sessionId,
      stopReason: turn.stopReason,
      promptChars: text.length,
      workerPromptChars: preparedPrompt.workerText.length,
      assistantText: enforced.text,
      assistantRawChars: enforced.rawChars,
      outputContract: outputContractRecord(preparedPrompt.outputContract, enforced),
      transcript,
      events,
      permissionRequests,
      acp: { initialize: init }
    };
    writeFileSync(resolve(dirname(events), "last-run.json"), JSON.stringify(result, null, 2), "utf8");
    return result;
  } finally {
    client.close();
  }
}

function choosePermissionOption(params, mode) {
  const options = params?.options || [];
  if (mode === "cancel") return null;
  if (mode === "always") {
    return options.find((o) => o.kind === "allow_always")?.optionId
      ?? options.find((o) => o.kind === "allow_once")?.optionId
      ?? null;
  }
  if (mode === "once") {
    return options.find((o) => o.kind === "allow_once")?.optionId ?? null;
  }
  if (mode === "reject") {
    return options.find((o) => o.kind?.startsWith("reject"))?.optionId ?? null;
  }
  return null;
}

function parseAskArgs(args) {
  const out = {
    dir: process.cwd(),
    approve: "cancel",
    json: true,
    yolo: false,
    outputContract: resolveWorkerOutputContract(),
    text: ""
  };
  const rest = [];
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === "--dir") out.dir = resolve(args[++i]);
    else if (a === "--approve") out.approve = args[++i];
    else if (a === "--model") out.model = args[++i];
    else if (a === "--preset") out.preset = args[++i];
    else if (a === "--budget") out.budget = args[++i];
    else if (a === "--transcript") out.transcript = resolve(args[++i]);
    else if (a === "--events") out.events = resolve(args[++i]);
    else if (a === "--yolo") out.yolo = true;
    else if (a === "--no-output-contract") out.outputContract = { enabled: false };
    else if (a === "--output-max-chars") out.outputContract = resolveWorkerOutputContract({ maxChars: args[++i] });
    else if (a === "--no-json") out.json = false;
    else if (a === "--json") out.json = true;
    else rest.push(a);
  }
  out.text = rest.join(" ").trim();
  out.dir = resolve(out.dir);
  if (!["cancel", "once", "always", "reject"].includes(out.approve)) {
    throw new Error("--approve must be one of: cancel, once, always, reject");
  }
  out.model = normalizeReasonixModel(out.model);
  validateReasonixPreset(out.preset);
  return out;
}

function parseStartArgs(args) {
  const out = {
    id: "",
    dir: process.cwd(),
    approve: "manual",
    yolo: false
  };
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === "--id") out.id = args[++i];
    else if (a === "--dir") out.dir = resolve(args[++i]);
    else if (a === "--approve") out.approve = args[++i];
    else if (a === "--model") out.model = args[++i];
    else if (a === "--preset") out.preset = args[++i];
    else if (a === "--budget") out.budget = args[++i];
    else if (a === "--yolo") out.yolo = true;
    else throw new Error(`Unknown start option: ${a}`);
  }
  validateApproveMode(out.approve, true);
  out.model = normalizeReasonixModel(out.model);
  validateReasonixPreset(out.preset);
  return out;
}

function parseDaemonArgs(args) {
  const out = {};
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === "--id") out.id = args[++i];
    else if (a === "--dir") out.dir = resolve(args[++i]);
    else if (a === "--meta") out.meta = resolve(args[++i]);
    else if (a === "--token") out.token = args[++i];
    else if (a === "--approve") out.approve = args[++i];
    else if (a === "--transcript") out.transcript = resolve(args[++i]);
    else if (a === "--events") out.events = resolve(args[++i]);
    else if (a === "--metrics") out.metrics = resolve(args[++i]);
    else if (a === "--model") out.model = args[++i];
    else if (a === "--preset") out.preset = args[++i];
    else if (a === "--budget") out.budget = args[++i];
    else if (a === "--yolo") out.yolo = true;
    else throw new Error(`Unknown daemon option: ${a}`);
  }
  for (const key of ["id", "dir", "meta", "token", "approve", "transcript", "events", "metrics"]) {
    if (!out[key]) throw new Error(`daemon missing --${key}`);
  }
  validateApproveMode(out.approve, true);
  out.model = normalizeReasonixModel(out.model);
  validateReasonixPreset(out.preset);
  return out;
}

function parseSendArgs(args) {
  if (args.length < 2) throw new Error("send usage: taskmarshalctl send SESSION_ID \"prompt\"");
  const [id, ...rest] = args;
  let taskId = null;
  let outputContract = resolveWorkerOutputContract();
  const text = [];
  for (let i = 0; i < rest.length; i += 1) {
    const item = rest[i];
    if (item === "--task-id") {
      taskId = rest[++i] || null;
    } else if (item === "--no-output-contract") {
      outputContract = { enabled: false };
    } else if (item === "--output-max-chars") {
      outputContract = resolveWorkerOutputContract({ maxChars: rest[++i] });
    } else {
      text.push(item);
    }
  }
  return { id, wait: false, taskId: cleanTaskId(taskId), outputContract, text: text.join(" ").trim() };
}

function parseInstallCodexConfigArgs(args) {
  const out = {
    writeUser: false,
    config: null,
    server: null,
    name: "taskmarshal-mcp",
    profile: "minimal"
  };
  for (let i = 0; i < args.length; i += 1) {
    const item = args[i];
    if (item === "--write-user") out.writeUser = true;
    else if (item === "--config") out.config = args[++i];
    else if (item === "--server") out.server = args[++i];
    else if (item === "--name") out.name = args[++i];
    else if (item === "--profile") out.profile = normalizeToolProfileArg(args[++i]);
    else throw new Error(`Unknown install-codex-config option: ${item}`);
  }
  if (!/^[A-Za-z0-9_.-]+$/.test(out.name)) throw new Error("--name must contain only letters, digits, dot, underscore, or dash");
  return out;
}

function parseObserveArgs(args) {
  const id = args[0];
  if (!id) throw new Error("observe requires SESSION_ID");
  let tail = 40;
  let mode = "summary";
  let maxChars = 12000;
  let since = 0;
  for (let i = 1; i < args.length; i += 1) {
    if (args[i] === "--tail") tail = Number(args[++i] || 40);
    else if (args[i] === "--mode") mode = args[++i] || "summary";
    else if (args[i] === "--max-chars") maxChars = Number(args[++i] || 12000);
    else if (args[i] === "--since") since = Number(args[++i] || 0);
    else throw new Error(`Unknown observe option: ${args[i]}`);
  }
  if (!["events", "summary", "final", "permission"].includes(mode)) {
    throw new Error("--mode must be one of: events, summary, final, permission");
  }
  if (!Number.isFinite(maxChars) || maxChars < 500) {
    throw new Error("--max-chars must be a number >= 500");
  }
  if (!Number.isInteger(tail) || tail < 1 || tail > 400) {
    throw new Error("--tail must be an integer between 1 and 400");
  }
  if (!Number.isInteger(since) || since < 0) {
    throw new Error("--since must be an integer cursor >= 0");
  }
  return { id, tail, mode, maxChars, since };
}

function parseSummarizeArgs(args) {
  const id = args[0];
  if (!id) throw new Error("summarize requires SESSION_ID");
  let maxChars = 6000;
  for (let i = 1; i < args.length; i += 1) {
    if (args[i] === "--max-chars") maxChars = Number(args[++i] || 6000);
    else throw new Error(`Unknown summarize option: ${args[i]}`);
  }
  if (!Number.isFinite(maxChars) || maxChars < 500) {
    throw new Error("--max-chars must be a number >= 500");
  }
  return { id, maxChars };
}

function parseMetricsArgs(args) {
  const out = {
    limit: 20,
    provider: null,
    model: null,
    since: null,
    maxSessions: 200,
    compact: false
  };
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === "--limit") out.limit = Number(args[++i] || out.limit);
    else if (a === "--provider") out.provider = args[++i] || null;
    else if (a === "--model") out.model = args[++i] || null;
    else if (a === "--since") out.since = args[++i] || null;
    else if (a === "--max-sessions") out.maxSessions = Number(args[++i] || out.maxSessions);
    else if (a === "--compact") out.compact = true;
    else throw new Error(`Unknown metrics option: ${a}`);
  }
  if (!Number.isInteger(out.limit) || out.limit < 1 || out.limit > 500) {
    throw new Error("--limit must be an integer between 1 and 500");
  }
  if (!Number.isInteger(out.maxSessions) || out.maxSessions < 1 || out.maxSessions > 2000) {
    throw new Error("--max-sessions must be an integer between 1 and 2000");
  }
  if (out.since && Number.isNaN(Date.parse(out.since))) {
    throw new Error("--since must be a parseable date or timestamp");
  }
  return out;
}

function parseTasksArgs(args) {
  const out = {
    limit: 20,
    status: null,
    compact: false
  };
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === "--limit") out.limit = Number(args[++i] || out.limit);
    else if (a === "--status") out.status = args[++i] || null;
    else if (a === "--compact") out.compact = true;
    else throw new Error(`Unknown tasks option: ${a}`);
  }
  if (!Number.isInteger(out.limit) || out.limit < 1 || out.limit > 500) {
    throw new Error("--limit must be an integer between 1 and 500");
  }
  if (out.status && !["open", "blocked", "done"].includes(out.status)) {
    throw new Error("--status must be one of: open, blocked, done");
  }
  return out;
}

function parseKeyValueArgs(args) {
  const out = {};
  for (let i = 0; i < args.length; i += 1) {
    const item = args[i];
    if (!item.startsWith("--")) throw new Error(`Unexpected argument: ${item}`);
    const key = item.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const next = args[i + 1];
    if (next === undefined || next.startsWith("--")) out[key] = true;
    else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
}

function requireSessionId(args) {
  const id = args[0];
  if (!id) throw new Error("SESSION_ID required");
  return id;
}

function validateApproveMode(mode, allowManual = false) {
  const allowed = allowManual ? ["manual", "cancel", "once", "always", "reject"] : ["cancel", "once", "always", "reject"];
  if (!allowed.includes(mode)) throw new Error(`approve mode must be one of: ${allowed.join(", ")}`);
}

function normalizeReasonixModel(model) {
  if (!model) return undefined;
  const key = String(model).trim().toLowerCase();
  if (!key) return undefined;
  return REASONIX_MODEL_ALIASES.get(key) ?? model;
}

function validateReasonixPreset(preset) {
  if (!preset) return;
  if (!["auto", "flash", "pro"].includes(preset)) {
    throw new Error("--preset must be one of: auto, flash, pro");
  }
}

function help() {
  console.log(`taskmarshalctl ${VERSION}

Usage:
  taskmarshalctl doctor
  taskmarshalctl models
  taskmarshalctl install-codex-config [--write-user] [--config PATH] [--server PATH] [--name taskmarshal-mcp] [--profile minimal|ultra-minimal|standard|full]
  taskmarshalctl ask "prompt" [--dir PATH] [--approve cancel|once|always|reject] [--model flash|pro|MODEL] [--preset auto|flash|pro] [--output-max-chars N] [--no-output-contract] [--yolo]
  taskmarshalctl context query --goal TEXT [--scope FILES] [--max-chars N] [--dir PATH] [--backend auto|codegraph|local-static]
  taskmarshalctl metrics [--limit N] [--provider NAME] [--model MODEL] [--since ISO_DATE] [--compact]
  taskmarshalctl route --goal TEXT [--scope FILES] [--risk low|medium|high] [--files N]
  taskmarshalctl task-create --goal TEXT [--scope FILES] [--risk low|medium|high] [--route local|flash|pro]
  taskmarshalctl checkpoint --id TASK_ID --step STEP_ID [--note TEXT]
  taskmarshalctl verify --id TASK_ID --status pass|fail|skip [--command CMD] [--exit-code N] [--session SESSION_ID] [--turn-id TURN_ID]
  taskmarshalctl close-verified --id TASK_ID [--note TEXT]
  taskmarshalctl finalize --id TASK_ID
  taskmarshalctl start [--dir PATH] [--approve manual|cancel|once|always|reject] [--model flash|pro|MODEL] [--preset auto|flash|pro]
  taskmarshalctl list
  taskmarshalctl status SESSION_ID
  taskmarshalctl send SESSION_ID [--task-id TASK_ID] [--output-max-chars N] [--no-output-contract] "prompt"
  taskmarshalctl observe SESSION_ID [--tail N] [--mode summary|final|permission|events] [--max-chars N] [--since CURSOR]
  taskmarshalctl summarize SESSION_ID [--max-chars N]
  taskmarshalctl approve SESSION_ID
  taskmarshalctl deny SESSION_ID
  taskmarshalctl cancel SESSION_ID
  taskmarshalctl stop SESSION_ID
  taskmarshalctl smoke

Notes:
  DeepSeek v4 aliases: flash -> deepseek-v4-flash, pro -> deepseek-v4-pro.
  ask uses Reasonix's native ACP JSON-RPC stdio agent.
  Events and transcripts are written under ~/.reasonixctl/runs by default.
  start creates a persistent local daemon backed by reasonix acp.
  observe defaults to summary mode; pass --mode events only when raw event tails are needed.
  worker output contract is default-on: final worker text is capped at ${DEFAULT_WORKER_OUTPUT_MAX_CHARS} chars unless disabled.
  install-codex-config prints a minimal+compact Codex MCP config by default; use --profile ultra-minimal for the smallest tool list.
`);
}

function ensureRunDir() {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = resolve(STATE_DIR, "runs", stamp);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function appendJsonl(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(value)}\n`, "utf8");
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function readJsonLenient(path) {
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, "utf8").replace(/^\uFEFF/, "");
  return JSON.parse(raw);
}

function readJsonOptional(path) {
  try {
    return readJsonLenient(path);
  } catch {
    return null;
  }
}

function codexMcpEnv({ profile = "minimal" } = {}) {
  return {
    TASKMARSHAL_TOOL_PROFILE: profile,
    TASKMARSHAL_COMPACT_TOOL_TEXT: "1",
    TASKMARSHAL_WORKER_OUTPUT_CONTRACT: "1",
    TASKMARSHAL_WORKER_OUTPUT_MAX_CHARS: String(DEFAULT_WORKER_OUTPUT_MAX_CHARS)
  };
}

function buildCodexMcpTomlSnippet({ name, serverPath, profile = "minimal" }) {
  if (serverPath.includes("'")) throw new Error("server path cannot contain single quotes for TOML literal args");
  return [
    `[mcp_servers.${name}]`,
    `command = "node"`,
    `args = ['${serverPath}']`,
    ``,
    `[mcp_servers.${name}.env]`,
    `TASKMARSHAL_TOOL_PROFILE = "${profile}"`,
    `TASKMARSHAL_COMPACT_TOOL_TEXT = "1"`,
    `TASKMARSHAL_WORKER_OUTPUT_CONTRACT = "1"`,
    `TASKMARSHAL_WORKER_OUTPUT_MAX_CHARS = "${DEFAULT_WORKER_OUTPUT_MAX_CHARS}"`,
    ``
  ].join("\n");
}

function writeCodexMcpConfig({ configPath, name, serverPath, profile = "minimal" }) {
  if (serverPath.includes("'")) throw new Error("server path cannot contain single quotes for TOML literal args");
  const existing = existsSync(configPath) ? readFileSync(configPath, "utf8").replace(/^\uFEFF/, "") : "";
  const next = upsertTomlKeyValues(
    upsertTomlKeyValues(existing, `mcp_servers.${name}`, {
      command: `"node"`,
      args: `['${serverPath}']`
    }),
    `mcp_servers.${name}.env`,
    {
      TASKMARSHAL_TOOL_PROFILE: `"${profile}"`,
      TASKMARSHAL_COMPACT_TOOL_TEXT: `"1"`,
      TASKMARSHAL_WORKER_OUTPUT_CONTRACT: `"1"`,
      TASKMARSHAL_WORKER_OUTPUT_MAX_CHARS: `"${DEFAULT_WORKER_OUTPUT_MAX_CHARS}"`
    }
  );
  if (existing === next) return { changed: false, backupPath: null };
  mkdirSync(dirname(configPath), { recursive: true });
  let backupPath = null;
  if (existsSync(configPath)) {
    const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
    backupPath = `${configPath}.bak-${stamp}`;
    writeFileSync(backupPath, existing, "utf8");
  }
  writeFileSync(configPath, next, "utf8");
  return { changed: true, backupPath };
}

function normalizeToolProfileArg(value) {
  const profile = String(value || "").trim().toLowerCase();
  if (["ultra", "tiny", "lean"].includes(profile)) return "ultra-minimal";
  if (["ultra-minimal", "minimal", "standard", "full"].includes(profile)) return profile;
  throw new Error("--profile must be one of: minimal, ultra-minimal, standard, full");
}

function upsertTomlKeyValues(existing, sectionName, values) {
  const lines = existing.split(/\r?\n/);
  const header = `[${sectionName}]`;
  const start = lines.findIndex((line) => line.trim() === header);
  if (start === -1) {
    const body = [
      header,
      ...Object.entries(values).map(([key, value]) => `${key} = ${value}`)
    ].join("\n");
    const prefix = existing.trimEnd();
    return `${prefix}${prefix ? "\n\n" : ""}${body}\n`;
  }
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    const trimmed = lines[i].trim();
    if (/^\[.+\]$/.test(trimmed)) {
      end = i;
      break;
    }
  }
  const block = lines.slice(start, end);
  for (const [key, value] of Object.entries(values)) {
    const keyPattern = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=`);
    const index = block.findIndex((line, lineIndex) => lineIndex > 0 && keyPattern.test(line));
    if (index === -1) block.push(`${key} = ${value}`);
    else block[index] = `${key} = ${value}`;
  }
  const nextLines = [...lines.slice(0, start), ...block, ...lines.slice(end)];
  return `${nextLines.join("\n").trimEnd()}\n`;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function buildMetricsReport({ limit = 20, provider = null, model = null, since = null, maxSessions = 200, compact = false } = {}) {
  const sinceMs = since ? Date.parse(since) : null;
  const records = [];
  const sessionDirs = await listSessionDirs(maxSessions);
  const perSessionMetricLimit = compact ? Math.max(5, Math.min(50, limit * 2)) : 2000;
  for (const dir of sessionDirs) {
    const meta = readJsonOptional(resolve(dir, "session.json"));
    const summary = readJsonOptional(resolve(dir, "session-summary.json"));
    for (const metric of readJsonlTail(resolve(dir, "metrics.jsonl"), perSessionMetricLimit)) {
      if (metric.malformed) continue;
      const tsMs = metric.ts ? Date.parse(metric.ts) : NaN;
      if (Number.isFinite(sinceMs) && Number.isFinite(tsMs) && tsMs < sinceMs) continue;
      const row = normalizeMetricRecord(metric, { meta, summary, dir });
      if (provider && row.provider !== provider) continue;
      if (model && row.model !== model) continue;
      records.push(row);
    }
  }
  const taskMetricRecords = readJsonlTail(resolve(WORKFLOW_DIR, "task-metrics.jsonl"), compact ? 500 : 2000);
  applyTaskVerificationToMetrics(records, taskMetricRecords);
  records.sort((a, b) => String(b.ts || "").localeCompare(String(a.ts || "")));
  const recent = records.slice(0, limit);
  const totals = summarizeMetrics(records);
  const taskVerification = summarizeTaskVerification(taskMetricRecords, { compact });
  const report = {
    ok: true,
    generatedAt: new Date().toISOString(),
    source: "reasonix persistent session metrics",
    filters: { limit, provider, model, since, maxSessions, compact },
    totals,
    byModel: groupMetrics(records, "model"),
    byProvider: groupMetrics(records, "provider"),
    taskVerification,
    guidance: buildMetricsGuidance(totals)
  };
  if (compact) {
    report.compact = true;
    report.recentCount = recent.length;
    report.metricsScan = {
      sessionCount: sessionDirs.length,
      perSessionMetricLimit
    };
    report.routingHints = buildRoutingHints({ totals, taskVerification });
    report.recent = recent.slice(0, Math.min(limit, 3)).map(compactMetricRecord);
    return report;
  }
  report.recent = recent;
  return report;
}

async function listSessionDirs(maxSessions) {
  if (!existsSync(SESSION_DIR)) return [];
  const entries = await readdir(SESSION_DIR, { withFileTypes: true });
  const dirs = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const dir = resolve(SESSION_DIR, entry.name);
      const meta = readJsonOptional(resolve(dir, "session.json"));
      const summary = readJsonOptional(resolve(dir, "session-summary.json"));
      return {
        dir,
        updatedAt: meta?.updatedAt ?? summary?.finishedAt ?? summary?.generatedAt ?? ""
      };
    })
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
    .slice(0, maxSessions)
    .map((entry) => entry.dir);
  return dirs;
}

function normalizeMetricRecord(metric, { meta, summary, dir }) {
  return {
    ts: metric.ts ?? null,
    provider: metric.provider ?? summary?.provider ?? "reasonix",
    session: metric.session ?? meta?.id ?? summary?.id ?? dirname(dir),
    model: metric.model ?? meta?.model ?? summary?.model ?? null,
    approveMode: metric.approveMode ?? meta?.approve ?? summary?.metrics?.approveMode ?? null,
    taskId: metric.taskId ?? null,
    ok: metric.ok ?? null,
    stopReason: metric.stopReason ?? null,
    elapsedMs: numericOrNull(metric.elapsedMs),
    promptChars: numericOrZero(metric.promptChars),
    workerPromptChars: numericOrZero(metric.workerPromptChars),
    assistantChars: numericOrZero(metric.assistantChars),
    assistantRawChars: numericOrZero(metric.assistantRawChars ?? metric.assistantChars),
    outputContractApplied: Boolean(metric.outputContractApplied ?? metric.outputContract?.enabled),
    outputContractTruncated: Boolean(metric.outputContractTruncated ?? metric.outputContract?.truncated),
    outputContractMaxChars: numericOrNull(metric.outputContractMaxChars ?? metric.outputContract?.maxChars),
    permissionRequests: numericOrZero(metric.permissionRequests),
    approvals: numericOrZero(metric.approvals),
    denials: numericOrZero(metric.denials),
    autoPermissions: numericOrZero(metric.autoPermissions),
    filesChangedCount: Array.isArray(metric.filesChanged) ? metric.filesChanged.length : numericOrZero(metric.filesChangedCount),
    verification: metric.verification ?? "unknown",
    redoCount: numericOrZero(metric.redoCount),
    error: metric.error ?? null
  };
}

function applyTaskVerificationToMetrics(records, taskMetricRecords) {
  const byTask = new Map();
  for (const record of taskMetricRecords) {
    if (record.malformed || !record.taskId || !["pass", "fail", "skip"].includes(record.verification)) continue;
    const existing = byTask.get(record.taskId);
    if (!existing || String(record.ts || "").localeCompare(String(existing.ts || "")) > 0) {
      byTask.set(record.taskId, record);
    }
  }
  for (const record of records) {
    if (record.verification !== "unknown" || !record.taskId) continue;
    const verified = byTask.get(record.taskId);
    if (!verified) continue;
    record.verification = verified.verification;
    record.verifiedAt = verified.ts ?? null;
  }
}

function summarizeMetrics(records) {
  const elapsedRecords = records.filter((record) => Number.isFinite(record.elapsedMs));
  const okCount = records.filter((record) => record.ok === true).length;
  const failedCount = records.filter((record) => record.ok === false).length;
  return {
    turnCount: records.length,
    okCount,
    failedCount,
    successRate: records.length ? round(okCount / records.length, 3) : null,
    elapsedMs: sumBy(records, "elapsedMs"),
    avgElapsedMs: elapsedRecords.length ? Math.round(sumBy(elapsedRecords, "elapsedMs") / elapsedRecords.length) : null,
    promptChars: sumBy(records, "promptChars"),
    workerPromptChars: sumBy(records, "workerPromptChars"),
    assistantChars: sumBy(records, "assistantChars"),
    assistantRawChars: sumBy(records, "assistantRawChars"),
    avgAssistantChars: records.length ? Math.round(sumBy(records, "assistantChars") / records.length) : null,
    avgAssistantRawChars: records.length ? Math.round(sumBy(records, "assistantRawChars") / records.length) : null,
    outputContractAppliedCount: records.filter((record) => record.outputContractApplied).length,
    outputContractTruncatedCount: records.filter((record) => record.outputContractTruncated).length,
    permissionRequests: sumBy(records, "permissionRequests"),
    autoPermissions: sumBy(records, "autoPermissions"),
    filesChangedCount: sumBy(records, "filesChangedCount"),
    unknownVerificationCount: records.filter((record) => record.verification === "unknown").length,
    redoCount: sumBy(records, "redoCount"),
    totalCostUsd: sumBy(records, "totalCostUsd")
  };
}

function groupMetrics(records, key) {
  const groups = new Map();
  for (const record of records) {
    const name = record[key] ?? "unknown";
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(record);
  }
  return Object.fromEntries(
    [...groups.entries()]
      .sort(([a], [b]) => String(a).localeCompare(String(b)))
      .map(([name, items]) => [name, summarizeMetrics(items)])
  );
}

function buildMetricsGuidance(totals) {
  const guidance = [];
  if (!totals.turnCount) {
    guidance.push("No persistent-session metrics found yet. Run persistent worker sessions to collect small metrics records.");
    return guidance;
  }
  const outputContractCoverage = totals.turnCount
    ? (totals.outputContractAppliedCount || 0) / totals.turnCount
    : 0;
  const unknownVerificationRate = totals.turnCount
    ? (totals.unknownVerificationCount || 0) / totals.turnCount
    : 0;
  if (totals.avgAssistantChars && totals.avgAssistantChars > 8000) {
    guidance.push("Average worker output is large; tighten yield-summary budgets and prefer worker_observe summary/final modes.");
  }
  if (outputContractCoverage < 0.9) {
    guidance.push("Some recent turns missed the worker output contract; restart the MCP/session with TASKMARSHAL_WORKER_OUTPUT_CONTRACT=1 and pass task ids on worker_send_task.");
  }
  if (totals.avgAssistantRawChars && totals.avgAssistantChars && totals.avgAssistantRawChars > totals.avgAssistantChars * 2) {
    guidance.push("Output contract is reducing worker final text; inspect raw logs only when debugging worker quality.");
  }
  if (unknownVerificationRate > 0.25) {
    guidance.push("Many turns still have unknown verification; use worker_task_gate(action:'verify') or pass session+turnId when recording checks.");
  } else if (totals.unknownVerificationCount > 0) {
    guidance.push("Verification is still unknown for some turns; record pass/fail/skip to make routing decisions evidence-based.");
  }
  if (totals.permissionRequests > 0 && totals.autoPermissions === totals.permissionRequests) {
    guidance.push("Recent turns used automatic permission handling; use manual approval for risky implementation sessions.");
  }
  if (!guidance.length) guidance.push("Metrics are healthy enough for static Local/flash/pro routing.");
  return guidance;
}

function buildRoutingHints({ totals, taskVerification }) {
  const hints = [];
  const failCount = taskVerification.byStatus.fail || 0;
  const passCount = taskVerification.byStatus.pass || 0;
  const outputContractCoverage = totals.turnCount
    ? (totals.outputContractAppliedCount || 0) / totals.turnCount
    : 1;
  if (failCount > 0 && failCount >= passCount) hints.push("tighten_scope_or_upgrade_model");
  if (totals.avgAssistantChars && totals.avgAssistantChars > 8000) hints.push("tighten_worker_yield");
  if (outputContractCoverage < 0.9) hints.push("enforce_output_contract");
  if (totals.outputContractTruncatedCount > 0) hints.push("review_worker_compactness");
  if (totals.unknownVerificationCount > 0) hints.push("record_verification");
  if (!hints.length) hints.push("static_route_ok");
  return hints;
}

function compactMetricRecord(record) {
  return {
    ts: record.ts,
    provider: record.provider,
    model: record.model,
    ok: record.ok,
    assistantChars: record.assistantChars,
    assistantRawChars: record.assistantRawChars,
    outputContractTruncated: record.outputContractTruncated,
    verification: record.verification,
    error: record.error
  };
}

function summarizeTaskVerification(records, { compact = false } = {}) {
  const valid = latestTaskVerificationRecords(records.filter((record) => !record.malformed));
  const byStatus = {};
  for (const record of valid) {
    const status = record.verification || "unknown";
    byStatus[status] = (byStatus[status] || 0) + 1;
  }
  const summary = {
    count: valid.length,
    byStatus
  };
  if (compact) {
    summary.recentCount = Math.min(valid.length, 5);
    return summary;
  }
  summary.recent = valid.slice(-5).reverse().map((record) => ({
      taskId: record.taskId,
      route: record.route,
      verification: record.verification,
      exitCode: record.exitCode ?? null
  }));
  return summary;
}

function latestTaskVerificationRecords(records) {
  const keyed = new Map();
  const unkeyed = [];
  for (const record of records) {
    if (!record.taskId) {
      unkeyed.push(record);
      continue;
    }
    const existing = keyed.get(record.taskId);
    if (!existing || String(record.ts || "").localeCompare(String(existing.ts || "")) > 0) {
      keyed.set(record.taskId, record);
    }
  }
  return [...unkeyed, ...keyed.values()];
}

function buildTasksReport({ limit = 20, status = null, compact = false } = {}) {
  const tasks = readAllTasks();
  const valid = tasks.filter((item) => !item.malformed);
  const filtered = status ? valid.filter((item) => item.status === status) : valid;
  const staleCutoff = Date.now() - 24 * 60 * 60 * 1000;
  const openish = valid.filter((item) => item.status !== "done");
  const passButNotDone = valid.filter((item) => item.verification === "pass" && item.status !== "done");
  const openWorkerTasks = openish.filter((item) => item.route !== "local" && item.verification === "none");
  const recent = filtered
    .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")))
    .slice(0, limit);
  const report = {
    ok: true,
    generatedAt: new Date().toISOString(),
    source: ".taskmarshal/tasks",
    filters: { limit, status, compact },
    totals: {
      taskCount: valid.length,
      malformedCount: tasks.length - valid.length,
      byStatus: countBy(valid, "status"),
      byVerification: countBy(valid, "verification"),
      openOrBlockedCount: openish.length,
      passButNotDoneCount: passButNotDone.length,
      staleOpenCount: openish.filter((item) => {
        const ts = Date.parse(item.updatedAt || "");
        return Number.isFinite(ts) && ts < staleCutoff;
      }).length
    },
    guidance: buildTasksGuidance({ openish, passButNotDone, openWorkerTasks, malformedCount: tasks.length - valid.length })
  };
  if (compact) {
    report.compact = true;
    report.guidance = buildCompactTasksGuidance({ openish, passButNotDone, openWorkerTasks, malformedCount: tasks.length - valid.length });
    report.recent = recent.slice(0, Math.min(limit, 3)).map(compactTaskRecord);
    report.attention = [
      ...passButNotDone.slice(0, 2).map((item) => ({ kind: "pass_not_finalized", ...compactTaskRecord(item) })),
      ...openWorkerTasks.slice(0, 2).map((item) => ({ kind: "open_worker_task", ...compactTaskRecord(item) }))
    ].slice(0, 3);
    return report;
  }
  report.recent = recent;
  return report;
}

function readAllTasks() {
  if (!existsSync(TASK_DIR)) return [];
  return readdirSyncSafe(TASK_DIR)
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const path = resolve(TASK_DIR, entry.name, "task.json");
      const raw = existsSync(path) ? readFileSync(path, "utf8").replace(/^\uFEFF/, "") : "";
      try {
        return normalizeTaskRecord(JSON.parse(raw));
      } catch (err) {
        return {
          id: entry.name,
          status: "malformed",
          route: null,
          risk: null,
          verification: "malformed",
          updatedAt: null,
          doneSteps: 0,
          totalSteps: 0,
          taskKey: false,
          goal: "",
          malformed: true,
          error: err.message
        };
      }
    });
}

function normalizeTaskRecord(task) {
  const steps = Array.isArray(task.steps) ? task.steps : [];
  return {
    id: task.id,
    status: task.status || "unknown",
    route: task.route || null,
    risk: task.risk || null,
    verification: task.verification?.status || "none",
    updatedAt: task.updatedAt || task.createdAt || null,
    doneSteps: steps.filter((step) => step.status === "done").length,
    totalSteps: steps.length,
    taskKey: Boolean(task.taskKey),
    goal: limitText(cleanText(task.goal), 160),
    malformed: false
  };
}

function compactTaskRecord(task) {
  return {
    id: task.id,
    status: task.status,
    route: task.route,
    verification: task.verification,
    steps: `${task.doneSteps}/${task.totalSteps}`,
    taskKey: task.taskKey,
    updatedAt: String(task.updatedAt || "").slice(0, 19) || null,
    goal: limitText(task.goal, 80)
  };
}

function buildCompactTasksGuidance({ openish, passButNotDone, openWorkerTasks, malformedCount }) {
  const guidance = [];
  if (passButNotDone.length) guidance.push("close_pass_not_finalized");
  if (openWorkerTasks.length) guidance.push("record_worker_verification");
  if (malformedCount) guidance.push("cleanup_malformed");
  if (openish.length > 20) guidance.push("cleanup_stale_open");
  if (!guidance.length) guidance.push("healthy");
  return guidance;
}

function buildTasksGuidance({ openish, passButNotDone, openWorkerTasks, malformedCount }) {
  const guidance = [];
  if (passButNotDone.length) {
    guidance.push("Some tasks have pass verification but are not finalized; use close-readonly or finalize after checkpointing steps.");
  }
  if (openWorkerTasks.length) {
    guidance.push("Some worker tasks remain open with no verification; record pass/fail/skip with session+turnId or close read-only audits.");
  }
  if (malformedCount) {
    guidance.push("Some task ledgers are malformed; compact reports skip them and include malformedCount for cleanup.");
  }
  if (openish.length > 20) {
    guidance.push("Open task ledger count is high; periodically close stale read-only audits to keep metrics actionable.");
  }
  if (!guidance.length) guidance.push("Task ledgers look healthy.");
  return guidance;
}

function countBy(items, key) {
  const counts = {};
  for (const item of items) {
    const value = item[key] ?? "unknown";
    counts[value] = (counts[value] || 0) + 1;
  }
  return counts;
}

function readdirSyncSafe(path) {
  try {
    return readdirSync(path, { withFileTypes: true });
  } catch {
    return [];
  }
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

function buildRouteDecision({ input, metrics }) {
  const goal = cleanText(input.goal);
  const scope = splitList(input.scope);
  const risk = normalizeRisk(input.risk);
  const files = Number(input.files ?? scope.length) || scope.length;
  const localOnly = isLocalMachineStateTask(goal, scope);
  const explicitRoute = ["local", "flash", "pro"].includes(String(input.route || "").toLowerCase())
    ? String(input.route).toLowerCase()
    : null;
  const totals = metrics?.totals ?? {};
  const flashMetrics = getMetricGroup(metrics, "deepseek-v4-flash", "flash");
  const taskVerification = metrics?.taskVerification ?? {};
  const evidence = buildRoutingEvidence({ totals, flashMetrics, taskVerification });
  const reasonCodes = [];
  let route = "local";
  if (explicitRoute) {
    route = explicitRoute;
    reasonCodes.push("EXPLICIT_ROUTE");
  } else if (localOnly) {
    route = "local";
    reasonCodes.push("LOCAL_MACHINE_STATE");
  } else if (risk === "high" || hasHighRiskWords(goal)) {
    route = "pro";
    reasonCodes.push("HIGH_RISK");
  } else if (files >= 3 || hasDelegationWords(goal)) {
    route = "flash";
    reasonCodes.push(files >= 3 ? "MULTI_FILE" : "DELEGATION_FIT");
  } else {
    reasonCodes.push("SMALL_LOCAL");
  }
  if (route === "flash" && evidence.upgradeFlashToPro) {
    route = "pro";
    reasonCodes.push("METRICS_UPGRADE_TO_PRO");
  }
  if (route === "pro" && totals.unknownVerificationCount > 0) {
    reasonCodes.push("REQUIRE_VERIFICATION_RECORD");
  }
  const outputBudget = route === "local" ? "short" : evidence.tightOutput ? "tight" : "short";
  if (route !== "local" && outputBudget === "tight") reasonCodes.push("WORKER_OUTPUT_TOO_LONG");
  if (evidence.taskFailCount > 0) reasonCodes.push("TASK_FAILURE_HISTORY");
  return {
    ok: true,
    route,
    provider: route === "local" ? null : "reasonix",
    model: route === "pro" ? "pro" : route === "flash" ? "flash" : null,
    reasonCodes,
    metricsEvidence: evidence,
    outputBudget,
    maxCodexChars: 900,
    next: route === "local" ? "do_local" : "task-create"
  };
}

function isLocalMachineStateTask(goal, scope) {
  const text = [goal, ...scope].join(" ").toLowerCase();
  const patterns = [
    "~/.codex",
    ".codex/skills",
    ".codex\\skills",
    ".codex/config",
    ".codex\\config",
    "~/.agents",
    ".agents/skills",
    ".agents\\skills",
    "installed skill",
    "local skill",
    "user skill",
    "skill directory",
    "mcp config",
    "codex config",
    ".reasonixctl",
    ".taskmarshal",
    "reasonixctl",
    "session logs",
    "session log",
    "metrics logs",
    "metrics log",
    "task ledger",
    "task ledgers",
    "worker logs",
    "worker log",
    "api-key config",
    "apikey config",
    "api key config",
    "shell profile",
    "$profile",
    ".bashrc",
    ".zshrc",
    ".profile",
    "home-directory",
    "home directory"
  ];
  return patterns.some((pattern) => text.includes(pattern));
}

function getMetricGroup(metrics, ...names) {
  for (const name of names) {
    if (metrics?.byModel?.[name]) return metrics.byModel[name];
    if (metrics?.byProvider?.[name]) return metrics.byProvider[name];
  }
  return {};
}

function buildRoutingEvidence({ totals, flashMetrics, taskVerification }) {
  const byStatus = taskVerification?.byStatus ?? {};
  const taskFailCount = byStatus.fail || 0;
  const taskPassCount = byStatus.pass || 0;
  const flashFailureRate = flashMetrics.turnCount
    ? round((flashMetrics.failedCount || 0) / flashMetrics.turnCount, 3)
    : 0;
  const unknownVerificationRate = totals.turnCount
    ? round((totals.unknownVerificationCount || 0) / totals.turnCount, 3)
    : 0;
  return {
    source: "compact_metrics",
    turnCount: totals.turnCount || 0,
    taskPassCount,
    taskFailCount,
    flashTurnCount: flashMetrics.turnCount || 0,
    flashFailureRate,
    unknownVerificationRate,
    avgAssistantChars: totals.avgAssistantChars || 0,
    tightOutput: Boolean(totals.avgAssistantChars && totals.avgAssistantChars > 8000),
    upgradeFlashToPro: Boolean(
      flashMetrics.turnCount >= 3
      && (
        flashFailureRate >= 0.25
        || (taskFailCount > 0 && taskFailCount >= taskPassCount)
      )
    )
  };
}

function buildTaskSteps({ goal, scope, risk, route, steps }) {
  const provided = steps.length ? steps : [
    "plan bounded change",
    "implement scoped work",
    "run verification",
    "yield compact summary"
  ];
  return provided.slice(0, 8).map((description, index) => ({
    id: `s${index + 1}`,
    description: limitText(cleanText(description), 180),
    status: "pending",
    required: true
  }));
}

function buildWorkerPromptPacket(task) {
  return {
    taskId: task.id,
    goal: task.goal,
    scope: task.scope,
    risk: task.risk,
    route: task.route,
    outputContract: {
      maxChars: DEFAULT_WORKER_OUTPUT_MAX_CHARS,
      format: WORKER_OUTPUT_FIELDS.join(", "),
      noFullLogs: true,
      noFullDiffs: true
    },
    steps: task.steps.map((step) => ({ id: step.id, description: step.description }))
  };
}

function taskControlPacket(task, next) {
  return {
    ok: true,
    taskId: task.id,
    route: task.route,
    risk: task.risk,
    stepCount: task.steps.length,
    next,
    artifactRoot: `.taskmarshal/tasks/${task.id}`,
    maxCodexChars: 900
  };
}

function makeTaskId(goal) {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  const slug = cleanText(goal)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "task";
  return `${stamp}-${slug}-${randomBytes(3).toString("hex")}`;
}

function makeTaskKey(task) {
  const body = JSON.stringify({
    id: task.id,
    goal: task.goal,
    steps: task.steps.map((step) => [step.id, step.status]),
    verification: task.verification?.status ?? null
  });
  return randomBytes(4).toString("hex") + Buffer.from(body).toString("base64url").slice(0, 16);
}

function taskDir(id) {
  if (!/^[A-Za-z0-9_.-]+$/.test(id)) throw new Error("invalid task id");
  return resolve(TASK_DIR, id);
}

function readTask(id) {
  const task = readJsonLenient(resolve(taskDir(id), "task.json"));
  if (!task) throw new Error(`Unknown task: ${id}`);
  return task;
}

function writeTask(task) {
  writeJson(resolve(taskDir(task.id), "task.json"), task);
  if (Array.isArray(task.steps)) {
    writeJson(resolve(taskDir(task.id), "steps.json"), { taskId: task.id, steps: task.steps });
  }
}

function cleanText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function splitList(value) {
  if (Array.isArray(value)) return value.map(cleanText).filter(Boolean);
  return String(value ?? "")
    .split(/[,\n;]/)
    .map(cleanText)
    .filter(Boolean)
    .slice(0, 20);
}

function normalizeRisk(value) {
  const risk = String(value || "medium").toLowerCase();
  if (["low", "medium", "high"].includes(risk)) return risk;
  return "medium";
}

function normalizeVerification(value) {
  const status = String(value || "").toLowerCase();
  if (!["pass", "fail", "skip"].includes(status)) throw new Error("--status must be pass, fail, or skip");
  return status;
}

function cleanTaskId(value) {
  const id = cleanText(value);
  return /^[A-Za-z0-9_.-]+$/.test(id) ? id : null;
}

function hasHighRiskWords(text) {
  return /\b(auth|security|secret|migration|data loss|payment|release|production|权限|密钥|迁移|安全|上线)\b/i.test(text);
}

function hasDelegationWords(text) {
  return /\b(refactor|debug|audit|review|architecture|research|multi-file|worker|agent|调研|审查|架构|多文件|重构)\b/i.test(text);
}

function readSessionMeta(id) {
  const metaPath = resolve(SESSION_DIR, id, "session.json");
  const meta = readJsonLenient(metaPath);
  if (!meta) throw new Error(`Unknown session: ${id}`);
  return meta;
}

function writeSessionSummary(id, { maxChars = 6000, daemonStatus = null } = {}) {
  const meta = readSessionMeta(id);
  const events = readJsonl(meta.events);
  const summary = buildReasonixSessionSummary({ meta, daemonStatus, events, maxChars });
  const summaryPath = resolve(SESSION_DIR, id, "session-summary.json");
  writeJson(summaryPath, summary);
  return { ...summary, summaryPath };
}

function redactMeta(meta) {
  return {
    ...meta,
    token: meta.token ? `${meta.token.slice(0, 4)}...${meta.token.slice(-4)}` : null
  };
}

function writeDaemonMeta(metaPath, opts, state) {
  const previous = readJsonLenient(metaPath) ?? {};
  writeJson(metaPath, {
    ...previous,
    id: opts.id,
    status: state.status,
    busy: state.busy,
    pid: process.pid,
    port: state.port ?? previous.port ?? null,
    dir: opts.dir,
    approve: opts.approve,
    model: opts.model ?? null,
    preset: opts.preset ?? null,
    budget: opts.budget ?? null,
    sessionId: state.sessionId ?? previous.sessionId ?? null,
    currentTurnId: state.currentTurnId,
    currentPrompt: state.currentPrompt,
    currentTaskId: state.currentTaskId,
    currentOutputContract: state.currentOutputContract,
    assistantTextPreview: state.assistantText.slice(-2000),
    pendingPermission: state.pendingPermission ? {
      id: state.pendingPermission.id,
      createdAt: state.pendingPermission.createdAt,
      toolCall: state.pendingPermission.params?.toolCall ?? null,
      options: state.pendingPermission.params?.options ?? []
    } : null,
    lastTurn: state.turns[state.turns.length - 1] ?? previous.lastTurn ?? null,
    turnCount: state.turns.length,
    errors: state.errors.slice(-5),
    updatedAt: new Date().toISOString()
  });
}

function publicDaemonState(opts, state) {
  return {
    ok: true,
    id: opts.id,
    status: state.status,
    busy: state.busy,
    pid: process.pid,
    port: state.port,
    dir: opts.dir,
    approve: opts.approve,
    model: opts.model ?? null,
    preset: opts.preset ?? null,
    budget: opts.budget ?? null,
    sessionId: state.sessionId,
    currentTurnId: state.currentTurnId,
    currentPrompt: state.currentPrompt,
    currentTaskId: state.currentTaskId,
    currentOutputContract: state.currentOutputContract,
    assistantTextPreview: state.assistantText.slice(-2000),
    pendingPermission: state.pendingPermission ? {
      id: state.pendingPermission.id,
      createdAt: state.pendingPermission.createdAt,
      toolCall: state.pendingPermission.params?.toolCall ?? null,
      options: state.pendingPermission.params?.options ?? []
    } : null,
    turns: state.turns.slice(-5),
    errors: state.errors.slice(-5)
  };
}

async function runTurn(client, opts, state, eventSink, metaPath, preparedPrompt, turnId) {
  const startedAt = new Date().toISOString();
  const text = preparedPrompt.userText;
  eventSink({
    method: "control/send",
    turnId,
    text,
    outputContract: contractPromptRecord(preparedPrompt.outputContract)
  });
  try {
    const result = await client.prompt({ sessionId: state.sessionId, text: preparedPrompt.workerText });
    const enforced = enforceWorkerOutputContract(state.assistantText.trim(), preparedPrompt.outputContract);
    state.assistantText = enforced.text;
    const turn = {
      turnId,
      startedAt,
      finishedAt: new Date().toISOString(),
      stopReason: result.stopReason,
      promptChars: text.length,
      workerPromptChars: preparedPrompt.workerText.length,
      assistantText: enforced.text,
      assistantRawChars: enforced.rawChars,
      outputContract: outputContractRecord(preparedPrompt.outputContract, enforced)
    };
    const metric = buildTurnMetric({ opts, state, turn, ok: true });
    state.turns.push(turn);
    state.status = "ready";
    state.busy = false;
    state.currentTurnId = null;
    state.currentPrompt = null;
    state.currentTaskId = null;
    state.currentOutputContract = null;
    state.currentTurnMetrics = null;
    state.pendingPermission = null;
    state.permissionResolver = null;
    appendJsonl(opts.metrics, metric);
    eventSink({ method: "control/turn_finished", turnId, stopReason: result.stopReason });
    writeDaemonMeta(metaPath, opts, state);
  } catch (err) {
    const enforced = enforceWorkerOutputContract(state.assistantText.trim(), preparedPrompt.outputContract);
    state.assistantText = enforced.text;
    const failedTurn = {
      turnId,
      startedAt,
      finishedAt: new Date().toISOString(),
      stopReason: "error",
      promptChars: text.length,
      workerPromptChars: preparedPrompt.workerText.length,
      assistantText: enforced.text,
      assistantRawChars: enforced.rawChars,
      outputContract: outputContractRecord(preparedPrompt.outputContract, enforced),
      error: err.message
    };
    appendJsonl(opts.metrics, buildTurnMetric({ opts, state, turn: failedTurn, ok: false }));
    state.status = "ready";
    state.busy = false;
    state.currentTaskId = null;
    state.currentOutputContract = null;
    state.currentTurnMetrics = null;
    state.errors.push({ ts: new Date().toISOString(), turnId, message: err.message });
    eventSink({ method: "control/turn_error", turnId, error: err.message });
    writeDaemonMeta(metaPath, opts, state);
  }
}

function buildTurnMetric({ opts, state, turn, ok }) {
  const turnMetrics = state.currentTurnMetrics ?? {};
  const elapsedMs = turn.startedAt && turn.finishedAt ? Date.parse(turn.finishedAt) - Date.parse(turn.startedAt) : null;
  const outputContract = turn.outputContract ?? outputContractRecord(turnMetrics.outputContract, {
    text: turn.assistantText ?? "",
    rawChars: String(turn.assistantText ?? "").length,
    truncated: false
  });
  return {
    ts: turn.finishedAt,
    provider: "reasonix",
    session: opts.id,
    model: opts.model ?? null,
    preset: opts.preset ?? null,
    budget: opts.budget ?? null,
    approveMode: opts.approve,
    turnId: turn.turnId,
    taskId: cleanTaskId(state.currentTaskId),
    ok,
    stopReason: turn.stopReason,
    elapsedMs: Number.isFinite(elapsedMs) ? elapsedMs : null,
    promptChars: turn.promptChars ?? 0,
    workerPromptChars: turn.workerPromptChars ?? turn.promptChars ?? 0,
    assistantChars: String(turn.assistantText ?? "").length,
    assistantRawChars: turn.assistantRawChars ?? String(turn.assistantText ?? "").length,
    outputContract,
    outputContractApplied: Boolean(outputContract?.enabled),
    outputContractTruncated: Boolean(outputContract?.truncated),
    outputContractMaxChars: outputContract?.maxChars ?? null,
    permissionRequests: turnMetrics.permissionRequests ?? 0,
    approvals: turnMetrics.approvals ?? 0,
    denials: turnMetrics.denials ?? 0,
    autoPermissions: turnMetrics.autoPermissions ?? 0,
    filesChanged: [],
    verification: "unknown",
    redoCount: 0,
    error: turn.error ?? null
  };
}

async function waitForReady(metaPath, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const meta = readJsonLenient(metaPath);
    if (meta?.status === "ready" && meta?.port) return meta;
    if (meta?.status === "error") throw new Error(`daemon failed: ${meta.errors?.[0]?.message || "unknown"}`);
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`Timed out waiting for daemon: ${metaPath}`);
}

async function daemonRequest(meta, method, path, body) {
  if (!meta?.port || !meta?.token) throw new Error("session metadata is missing port/token");
  const res = await fetch(`http://127.0.0.1:${meta.port}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      "x-reasonixctl-token": meta.token
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(json.error || `daemon request failed: ${res.status}`);
  return json;
}

async function readBody(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

function sendHttp(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function readTailJsonl(path, count) {
  return readJsonlWindow(path, { tail: count }).events;
}

function readJsonlWindow(path, { tail = 40, since = 0 } = {}) {
  if (!existsSync(path)) return { events: [], total: 0, since: 0, cursor: 0, deltaCount: 0 };
  const lines = readFileSync(path, "utf8").trim().split(/\r?\n/).filter(Boolean);
  const total = lines.length;
  const start = since > 0 ? Math.min(since, total) : Math.max(0, total - tail);
  const selected = lines.slice(start);
  const events = selected.map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      return { malformed: line };
    }
  });
  return {
    events,
    total,
    since,
    cursor: total,
    deltaCount: Math.max(0, total - start)
  };
}

function readJsonl(path) {
  if (!path) return [];
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return { malformed: line };
      }
    });
}

function updateSessionMetricVerification({ sessionId, turnId, taskId, verification, verifiedAt }) {
  if (!sessionId) return { ok: false, reason: "no_session" };
  if (!/^[A-Za-z0-9_.-]+$/.test(sessionId)) return { ok: false, reason: "invalid_session" };
  if (!turnId) return { ok: false, reason: "turn_id_required" };
  const metricsPath = resolve(SESSION_DIR, sessionId, "metrics.jsonl");
  if (!existsSync(metricsPath)) return { ok: false, reason: "metrics_not_found" };
  const records = readJsonl(metricsPath);
  const validIndexes = records
    .map((record, index) => ({ record, index }))
    .filter(({ record }) => !record.malformed);
  if (!validIndexes.length) return { ok: false, reason: "empty_metrics" };
  const match = validIndexes.find(({ record }) => record.turnId === turnId);
  if (!match) return { ok: false, reason: "turn_not_found" };
  records[match.index] = {
    ...match.record,
    verification,
    verifiedAt,
    taskId
  };
  writeFileSync(metricsPath, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");
  return {
    ok: true,
    session: sessionId,
    turnId: records[match.index].turnId ?? null,
    verification
  };
}

function updateRecentSessionMetricVerificationByTaskId({ taskId, verification, verifiedAt, maxSessions = 80 }) {
  if (!taskId) return { ok: false, reason: "no_task_id" };
  if (!existsSync(SESSION_DIR)) return { ok: false, reason: "session_dir_not_found" };
  const matches = [];
  const sessionEntries = readdirSyncSafe(SESSION_DIR)
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const dir = resolve(SESSION_DIR, entry.name);
      const metricsPath = resolve(dir, "metrics.jsonl");
      const meta = readJsonOptional(resolve(dir, "session.json"));
      const updatedAt = meta?.updatedAt ?? (existsSync(metricsPath) ? statSync(metricsPath).mtime.toISOString() : "");
      return { name: entry.name, metricsPath, updatedAt };
    })
    .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")))
    .slice(0, maxSessions);
  for (const entry of sessionEntries) {
    const metricsPath = entry.metricsPath;
    if (!existsSync(metricsPath)) continue;
    const records = readJsonlTail(metricsPath, 20);
    records.forEach((record) => {
      if (record.malformed) return;
      if (record.taskId !== taskId) return;
      if (!metricVerificationPatchable(record)) return;
      matches.push({
        session: entry.name,
        metricsPath,
        ts: record.ts ?? "",
        turnId: record.turnId ?? null
      });
    });
  }
  matches.sort((a, b) => String(b.ts || "").localeCompare(String(a.ts || "")));
  const match = matches[0];
  if (!match) return { ok: false, reason: "task_metric_not_found" };
  const records = readJsonl(match.metricsPath);
  let patched = false;
  const next = records.map((record) => {
    if (patched || record.malformed) return record;
    if (record.taskId !== taskId) return record;
    if (!metricVerificationPatchable(record)) return record;
    if (record.turnId !== match.turnId || record.ts !== match.ts) return record;
    patched = true;
    return {
      ...record,
      verification,
      verifiedAt
    };
  });
  if (!patched) return { ok: false, reason: "task_metric_match_lost" };
  writeFileSync(match.metricsPath, `${next.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");
  return {
    ok: true,
    session: match.session,
    turnId: match.turnId,
    verification,
    matchedBy: "taskId"
  };
}

function metricVerificationPatchable(record) {
  return (record.verification ?? "unknown") === "unknown" || Boolean(record.verifiedAt);
}

function readJsonlTail(path, count) {
  if (!path) return [];
  if (!Number.isFinite(count) || count <= 0) return [];
  if (!existsSync(path)) return [];
  const stat = statSync(path);
  if (stat.size === 0) return [];
  const chunkSize = 64 * 1024;
  let offset = stat.size;
  let text = "";
  let newlineCount = 0;
  const fd = openSync(path, "r");
  try {
    while (offset > 0 && newlineCount <= count) {
      const length = Math.min(chunkSize, offset);
      offset -= length;
      const buffer = Buffer.allocUnsafe(length);
      const bytesRead = readSync(fd, buffer, 0, length, offset);
      text = buffer.toString("utf8", 0, bytesRead) + text;
      newlineCount = (text.match(/\n/g) || []).length;
    }
  } finally {
    closeSync(fd);
  }
  const lines = text.trim().split(/\r?\n/).filter(Boolean);
  return lines.slice(-count).map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      return { malformed: line };
    }
  });
}

function displayEvents(events) {
  return events.filter((event) => {
    if (event.type === "agent_thought_chunk") return false;
    return true;
  });
}

function buildReasonixSessionSummary({ meta, daemonStatus, events, maxChars }) {
  const status = daemonStatus && daemonStatus.ok ? daemonStatus : null;
  const metricsRecords = readJsonl(meta.metrics);
  const turns = Array.isArray(status?.turns) && status.turns.length
    ? status.turns
    : [meta.lastTurn].filter(Boolean);
  const permissionRequests = events.filter((event) => event.method === "session/request_permission").length;
  const approvals = events.filter((event) => event.method === "control/permission" && event.action === "approve").length;
  const denials = events.filter((event) => event.method === "control/permission" && event.action === "deny").length;
  const autoPermissions = events.filter((event) => event.method === "control/permission_auto").length;
  const errors = [
    ...(Array.isArray(status?.errors) ? status.errors : []),
    ...(Array.isArray(meta.errors) ? meta.errors : []),
    ...events.filter((event) => event.method === "control/turn_error")
  ].slice(-10);
  const startedAt = meta.startedAt ?? turns[0]?.startedAt ?? null;
  const finishedAt = turns[turns.length - 1]?.finishedAt ?? meta.updatedAt ?? null;
  const elapsedMs = startedAt && finishedAt ? Date.parse(finishedAt) - Date.parse(startedAt) : null;
  const assistantText = turns.map((turn) => turn.assistantText || "").filter(Boolean).join("\n\n");
  const lastTurn = turns[turns.length - 1] ?? null;
  const summary = {
    ok: true,
    provider: "reasonix",
    id: meta.id,
    generatedAt: new Date().toISOString(),
    status: status?.status ?? meta.status ?? "unknown",
    dir: meta.dir,
    model: meta.model ?? null,
    preset: meta.preset ?? null,
    budget: meta.budget ?? null,
    sessionId: meta.sessionId ?? null,
    startedAt,
    finishedAt,
    metrics: {
      provider: "reasonix",
      model: meta.model ?? null,
      approveMode: meta.approve ?? null,
      elapsedMs: Number.isFinite(elapsedMs) ? elapsedMs : null,
      turnCount: turns.length,
      permissionRequests,
      approvals,
      denials,
      autoPermissions,
      errorCount: errors.length,
      promptChars: metricsRecords.length ? sumBy(metricsRecords, "promptChars") : sumBy(turns, "promptChars"),
      assistantChars: metricsRecords.length ? sumBy(metricsRecords, "assistantChars") : assistantText.length,
      recordedTurns: metricsRecords.length,
      filesChanged: [],
      verification: "unknown",
      redoCount: 0
    },
    lastTurn: summarizeTurn(lastTurn),
    assistantTextPreview: limitText(assistantText || meta.assistantTextPreview || "", maxChars),
    pendingPermission: status?.pendingPermission ?? meta.pendingPermission ?? null,
    errors
  };
  return compactTextFields(summary, maxChars);
}

function sumBy(items, key) {
  return items.reduce((total, item) => {
    const value = Number(item?.[key]);
    return Number.isFinite(value) ? total + value : total;
  }, 0);
}

function formatObservation({ id, mode, maxChars, status, events, eventWindow, meta }) {
  const safeStatus = compactSessionStatus(status, maxChars);
  const cursor = eventWindow ? {
    since: eventWindow.since,
    cursor: eventWindow.cursor,
    total: eventWindow.total,
    deltaCount: eventWindow.deltaCount
  } : null;
  const base = {
    ok: true,
    id,
    mode,
    cursor,
    status: safeStatus
  };
  if (mode === "summary") {
    return compactTextFields({
      ...base,
      eventCount: events.length,
      recentEventTypes: events.slice(-10).map((event) => event.type || event.method || "unknown"),
      lastTurn: summarizeTurn(status?.turns?.[status.turns.length - 1] ?? status?.lastTurn ?? meta.lastTurn ?? null),
      assistantTextPreview: status?.assistantTextPreview ?? meta.assistantTextPreview ?? null,
      pendingPermission: status?.pendingPermission ?? null,
      errors: status?.errors ?? meta.errors ?? []
    }, maxChars);
  }
  if (mode === "final") {
    const lastTurn = status?.turns?.[status.turns.length - 1] ?? status?.lastTurn ?? meta.lastTurn ?? null;
    return compactTextFields({
      ...base,
      lastTurn: summarizeTurn(lastTurn),
      final: lastTurn?.assistantText ?? status?.assistantTextPreview ?? meta.assistantTextPreview ?? null
    }, maxChars);
  }
  if (mode === "permission") {
    return compactTextFields({
      ...base,
      pendingPermission: status?.pendingPermission ?? null,
      busy: status?.busy ?? null,
      currentTurnId: status?.currentTurnId ?? null
    }, maxChars);
  }
  return compactTextFields({
    ...base,
    events
  }, maxChars);
}

function compactSessionStatus(status, maxChars) {
  if (!status || typeof status !== "object") return status;
  return compactTextFields({
    ok: status.ok,
    id: status.id,
    status: status.status,
    busy: status.busy,
    pid: status.pid,
    port: status.port,
    dir: status.dir,
    approve: status.approve,
    model: status.model,
    preset: status.preset,
    budget: status.budget,
    sessionId: status.sessionId,
    currentTurnId: status.currentTurnId,
    pendingPermission: status.pendingPermission ?? null,
    turnCount: Array.isArray(status.turns) ? status.turns.length : undefined,
    errors: status.errors ?? []
  }, maxChars);
}

function summarizeTurn(turn) {
  if (!turn || typeof turn !== "object") return turn ?? null;
  return {
    turnId: turn.turnId,
    startedAt: turn.startedAt,
    finishedAt: turn.finishedAt,
    stopReason: turn.stopReason,
    ok: turn.ok,
    error: turn.error
  };
}

function compactTextFields(value, maxChars) {
  if (typeof value === "string") return limitText(value, maxChars);
  if (Array.isArray(value)) return value.map((item) => compactTextFields(item, maxChars));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, compactTextFields(entry, maxChars)])
  );
}

function limitText(text, maxChars) {
  if (!Number.isFinite(maxChars) || text.length <= maxChars) return text;
  const omitted = text.length - maxChars;
  return `${text.slice(0, maxChars)}\n[truncated ${omitted} chars]`;
}

function processAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function runCommand(command, args) {
  return new Promise((resolveCommand) => {
    const child = spawn(command, args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (exitCode) => resolveCommand({ exitCode, stdout, stderr }));
  });
}

function resolveReasonixCommand() {
  const npmPrefix = resolve(homedir(), "AppData", "Roaming", "npm", "node_modules", "reasonix", "dist", "cli", "index.js");
  if (process.platform === "win32" && existsSync(npmPrefix)) {
    return { command: process.execPath, prefixArgs: [npmPrefix] };
  }
  return { command: "reasonix", prefixArgs: [] };
}

function output(value, json = true) {
  if (json) console.log(JSON.stringify(value, null, 2));
  else console.log(String(value));
}

// reasonixctl.js is a compatibility shim that imports this module for this side effect.
Promise.resolve(main()).catch((err) => {
  console.error(err.stack || err.message || String(err));
  process.exit(1);
});

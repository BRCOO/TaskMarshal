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
  if (cmd === "ask") return ask(args);
  if (cmd === "smoke") return smoke();
  if (cmd === "metrics") return metricsReport(args);
  if (cmd === "route") return routeDecision(args);
  if (cmd === "task-create") return taskCreate(args);
  if (cmd === "checkpoint") return checkpointStep(args);
  if (cmd === "verify") return recordVerification(args);
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
    approve: "cancel"
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
    budget: parsed.budget
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
  const result = await daemonRequest(meta, "POST", "/send", { text: parsed.text, wait: parsed.wait, taskId: parsed.taskId });
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
  const verification = {
    status,
    command: limitText(cleanText(input.command), 300) || null,
    exitCode: input.exitCode === undefined ? null : Number(input.exitCode),
    note: limitText(cleanText(input.note), 500) || null,
    session: limitText(cleanText(input.session), 120) || null,
    turnId: limitText(cleanText(input.turnId), 120) || null,
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
  const linkedMetric = updateSessionMetricVerification({
    sessionId: verification.session,
    turnId: verification.turnId,
    taskId: task.id,
    verification: status,
    verifiedAt: verification.recordedAt
  });
  output({
    ok: true,
    taskId: task.id,
    verification: status,
    exitCode: verification.exitCode,
    linkedMetric,
    next: status === "pass" ? "finalize" : "fix_or_skip"
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
  const task = readTask(id);
  const completed = task.steps.filter((step) => step.status === "done").length;
  const verification = task.verification?.status ?? "unknown";
  const done = completed === task.steps.length && ["pass", "skip"].includes(verification);
  const taskKey = done ? task.taskKey || makeTaskKey(task) : null;
  task.status = done ? "done" : "blocked";
  task.taskKey = taskKey;
  task.updatedAt = new Date().toISOString();
  writeTask(task);
  output({
    ok: done,
    taskId: task.id,
    done,
    taskKey,
    completed,
    totalSteps: task.steps.length,
    verification,
    next: done ? "accept" : "complete_steps_or_verify"
  });
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
        state.busy = true;
        state.status = "running";
        state.currentTurnId = turnId;
        state.currentPrompt = body.text || "";
        state.currentTaskId = cleanTaskId(body.taskId);
        state.assistantText = "";
        state.currentTurnMetrics = {
          permissionRequests: 0,
          approvals: 0,
          denials: 0,
          autoPermissions: 0
        };
        writeDaemonMeta(metaPath, opts, state);
        runTurn(client, opts, state, eventSink, metaPath, body.text || "", turnId).catch((err) => {
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

async function runAcpTurn({ dir, text, transcript, events, approve = "cancel", yolo = false, model, preset, budget }) {
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
    const turn = await client.prompt({ sessionId: session.sessionId, text });
    const result = {
      ok: true,
      startedAt,
      finishedAt: new Date().toISOString(),
      dir,
      sessionId: session.sessionId,
      stopReason: turn.stopReason,
      assistantText: assistantText.trim(),
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
  const text = [];
  for (let i = 0; i < rest.length; i += 1) {
    const item = rest[i];
    if (item === "--task-id") {
      taskId = rest[++i] || null;
    } else {
      text.push(item);
    }
  }
  return { id, wait: false, taskId: cleanTaskId(taskId), text: text.join(" ").trim() };
}

function parseObserveArgs(args) {
  const id = args[0];
  if (!id) throw new Error("observe requires SESSION_ID");
  let tail = 40;
  let mode = "events";
  let maxChars = 12000;
  let since = 0;
  for (let i = 1; i < args.length; i += 1) {
    if (args[i] === "--tail") tail = Number(args[++i] || 40);
    else if (args[i] === "--mode") mode = args[++i] || "events";
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
  taskmarshalctl ask "prompt" [--dir PATH] [--approve cancel|once|always|reject] [--model flash|pro|MODEL] [--preset auto|flash|pro] [--yolo]
  taskmarshalctl metrics [--limit N] [--provider NAME] [--model MODEL] [--since ISO_DATE] [--compact]
  taskmarshalctl route --goal TEXT [--scope FILES] [--risk low|medium|high] [--files N]
  taskmarshalctl task-create --goal TEXT [--scope FILES] [--risk low|medium|high] [--route local|flash|pro]
  taskmarshalctl checkpoint --id TASK_ID --step STEP_ID [--note TEXT]
  taskmarshalctl verify --id TASK_ID --status pass|fail|skip [--command CMD] [--exit-code N] [--session SESSION_ID] [--turn-id TURN_ID]
  taskmarshalctl finalize --id TASK_ID
  taskmarshalctl start [--dir PATH] [--approve manual|cancel|once|always|reject] [--model flash|pro|MODEL] [--preset auto|flash|pro]
  taskmarshalctl list
  taskmarshalctl status SESSION_ID
  taskmarshalctl send SESSION_ID [--task-id TASK_ID] "prompt"
  taskmarshalctl observe SESSION_ID [--tail N] [--mode events|summary|final|permission] [--max-chars N] [--since CURSOR]
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
    assistantChars: numericOrZero(metric.assistantChars),
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
    assistantChars: sumBy(records, "assistantChars"),
    avgAssistantChars: records.length ? Math.round(sumBy(records, "assistantChars") / records.length) : null,
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
  if (totals.avgAssistantChars && totals.avgAssistantChars > 8000) {
    guidance.push("Average worker output is large; tighten yield-summary budgets and prefer worker_observe summary/final modes.");
  }
  if (totals.unknownVerificationCount > 0) {
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
  if (failCount > 0 && failCount >= passCount) hints.push("tighten_scope_or_upgrade_model");
  if (totals.avgAssistantChars && totals.avgAssistantChars > 8000) hints.push("tighten_worker_yield");
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
      maxChars: 1200,
      format: "changedFiles, commands, tests, risks, next",
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

async function runTurn(client, opts, state, eventSink, metaPath, text, turnId) {
  const startedAt = new Date().toISOString();
  eventSink({ method: "control/send", turnId, text });
  try {
    const result = await client.prompt({ sessionId: state.sessionId, text });
    const turn = {
      turnId,
      startedAt,
      finishedAt: new Date().toISOString(),
      stopReason: result.stopReason,
      promptChars: text.length,
      assistantText: state.assistantText.trim()
    };
    const metric = buildTurnMetric({ opts, state, turn, ok: true });
    state.turns.push(turn);
    state.status = "ready";
    state.busy = false;
    state.currentTurnId = null;
    state.currentPrompt = null;
    state.currentTaskId = null;
    state.currentTurnMetrics = null;
    state.pendingPermission = null;
    state.permissionResolver = null;
    appendJsonl(opts.metrics, metric);
    eventSink({ method: "control/turn_finished", turnId, stopReason: result.stopReason });
    writeDaemonMeta(metaPath, opts, state);
  } catch (err) {
    const failedTurn = {
      turnId,
      startedAt,
      finishedAt: new Date().toISOString(),
      stopReason: "error",
      promptChars: text.length,
      assistantText: state.assistantText.trim(),
      error: err.message
    };
    appendJsonl(opts.metrics, buildTurnMetric({ opts, state, turn: failedTurn, ok: false }));
    state.status = "ready";
    state.busy = false;
    state.currentTaskId = null;
    state.currentTurnMetrics = null;
    state.errors.push({ ts: new Date().toISOString(), turnId, message: err.message });
    eventSink({ method: "control/turn_error", turnId, error: err.message });
    writeDaemonMeta(metaPath, opts, state);
  }
}

function buildTurnMetric({ opts, state, turn, ok }) {
  const turnMetrics = state.currentTurnMetrics ?? {};
  const elapsedMs = turn.startedAt && turn.finishedAt ? Date.parse(turn.finishedAt) - Date.parse(turn.startedAt) : null;
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
    assistantChars: String(turn.assistantText ?? "").length,
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

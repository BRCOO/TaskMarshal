#!/usr/bin/env node
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { AcpClient, compactEvent } from "./lib/acp-client.js";

const VERSION = "0.1.0";
const STATE_DIR = resolve(homedir(), ".reasonixctl");
const SESSION_DIR = resolve(STATE_DIR, "sessions");
const REASONIX_COMMAND = resolveReasonixCommand();
const THIS_FILE = fileURLToPath(import.meta.url);

function main() {
  const [cmd = "help", ...args] = process.argv.slice(2);
  if (cmd === "help" || cmd === "-h" || cmd === "--help") return help();
  if (cmd === "version" || cmd === "--version" || cmd === "-V") return output({ version: VERSION });
  if (cmd === "doctor") return doctor();
  if (cmd === "ask") return ask(args);
  if (cmd === "smoke") return smoke();
  if (cmd === "start") return startSession(args);
  if (cmd === "list") return listSessions();
  if (cmd === "status") return statusSession(args);
  if (cmd === "send") return sendSession(args);
  if (cmd === "observe") return observeSession(args);
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

async function smoke() {
  const dir = ensureRunDir();
  const transcript = resolve(dir, "smoke-transcript.jsonl");
  const events = resolve(dir, "smoke-events.jsonl");
  const result = await runAcpTurn({
    dir: process.cwd(),
    text: "Say exactly: reasonixctl smoke ok. Do not use tools.",
    transcript,
    events,
    approve: "cancel"
  });
  output({ ok: true, run: result });
}

async function ask(args) {
  const parsed = parseAskArgs(args);
  if (!parsed.text) throw new Error("ask requires a prompt. Example: reasonixctl ask \"summarize this repo\"");
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
    sessionId: null,
    transcript,
    events
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
    "--events", events
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
    transcript,
    events
  };
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
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
  if (!parsed.text) throw new Error("send requires text. Example: reasonixctl send SESSION_ID \"analyze only\"");
  const meta = readSessionMeta(parsed.id);
  const result = await daemonRequest(meta, "POST", "/send", { text: parsed.text, wait: parsed.wait });
  output(result);
}

async function observeSession(args) {
  const { id, tail } = parseObserveArgs(args);
  const meta = readSessionMeta(id);
  const lines = readTailJsonl(meta.events, tail);
  let daemonStatus = null;
  try {
    daemonStatus = await daemonRequest(meta, "GET", "/status");
  } catch {
    daemonStatus = { ok: false, status: "offline" };
  }
  output({ ok: true, id, status: daemonStatus, events: displayEvents(lines) });
}

async function postSessionCommand(args, command) {
  const id = requireSessionId(args);
  const meta = readSessionMeta(id);
  const result = await daemonRequest(meta, "POST", `/${command}`, {});
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
    assistantText: "",
    pendingPermission: null,
    permissionResolver: null,
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
    if (opts.approve !== "manual") {
      const optionId = choosePermissionOption(params, opts.approve);
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
        state.assistantText = "";
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
    else if (a === "--model") out.model = args[++i];
    else if (a === "--preset") out.preset = args[++i];
    else if (a === "--budget") out.budget = args[++i];
    else if (a === "--yolo") out.yolo = true;
    else throw new Error(`Unknown daemon option: ${a}`);
  }
  for (const key of ["id", "dir", "meta", "token", "approve", "transcript", "events"]) {
    if (!out[key]) throw new Error(`daemon missing --${key}`);
  }
  validateApproveMode(out.approve, true);
  return out;
}

function parseSendArgs(args) {
  if (args.length < 2) throw new Error("send usage: reasonixctl send SESSION_ID \"prompt\"");
  const [id, ...rest] = args;
  return { id, wait: false, text: rest.join(" ").trim() };
}

function parseObserveArgs(args) {
  const id = args[0];
  if (!id) throw new Error("observe requires SESSION_ID");
  let tail = 40;
  for (let i = 1; i < args.length; i += 1) {
    if (args[i] === "--tail") tail = Number(args[++i] || 40);
    else throw new Error(`Unknown observe option: ${args[i]}`);
  }
  return { id, tail };
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

function help() {
  console.log(`reasonixctl ${VERSION}

Usage:
  reasonixctl doctor
  reasonixctl ask "prompt" [--dir PATH] [--approve cancel|once|always|reject] [--yolo]
  reasonixctl start [--dir PATH] [--approve manual|cancel|once|always|reject]
  reasonixctl list
  reasonixctl status SESSION_ID
  reasonixctl send SESSION_ID "prompt"
  reasonixctl observe SESSION_ID [--tail N]
  reasonixctl approve SESSION_ID
  reasonixctl deny SESSION_ID
  reasonixctl cancel SESSION_ID
  reasonixctl stop SESSION_ID
  reasonixctl smoke

Notes:
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

function readSessionMeta(id) {
  const metaPath = resolve(SESSION_DIR, id, "session.json");
  const meta = readJsonLenient(metaPath);
  if (!meta) throw new Error(`Unknown session: ${id}`);
  return meta;
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
    sessionId: state.sessionId ?? previous.sessionId ?? null,
    currentTurnId: state.currentTurnId,
    currentPrompt: state.currentPrompt,
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
    sessionId: state.sessionId,
    currentTurnId: state.currentTurnId,
    currentPrompt: state.currentPrompt,
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
      assistantText: state.assistantText.trim()
    };
    state.turns.push(turn);
    state.status = "ready";
    state.busy = false;
    state.currentTurnId = null;
    state.currentPrompt = null;
    state.pendingPermission = null;
    state.permissionResolver = null;
    eventSink({ method: "control/turn_finished", turnId, stopReason: result.stopReason });
    writeDaemonMeta(metaPath, opts, state);
  } catch (err) {
    state.status = "ready";
    state.busy = false;
    state.errors.push({ ts: new Date().toISOString(), turnId, message: err.message });
    eventSink({ method: "control/turn_error", turnId, error: err.message });
    writeDaemonMeta(metaPath, opts, state);
  }
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
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, "utf8").trim().split(/\r?\n/).filter(Boolean);
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

main().catch((err) => {
  console.error(err.stack || err.message || String(err));
  process.exit(1);
});

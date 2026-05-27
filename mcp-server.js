#!/usr/bin/env node
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";

const VERSION = "0.1.0";
const ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)));
const CTL = resolve(ROOT, "reasonixctl.js");
const STATE_DIR = resolve(homedir(), ".taskmarshal");
const CLAUDE_SESSION_DIR = resolve(STATE_DIR, "providers", "claude-code", "sessions");
const CLAUDE_COMMAND = process.platform === "win32" ? "cmd.exe" : "claude";
const CLAUDE_PREFIX_ARGS = process.platform === "win32" ? ["/d", "/s", "/c", "claude"] : [];

const Provider = z.enum(["reasonix", "claude-code"]);
const ApproveMode = z.enum(["manual", "cancel", "once", "always", "reject"]);
const AskApproveMode = z.enum(["cancel", "once", "always", "reject"]);
const REASONIX_MODEL_DESCRIPTION = "Optional Reasonix model override. Accepts flash/pro aliases or full ids: deepseek-v4-flash, deepseek-v4-pro.";

const providers = [
  {
    id: "reasonix",
    displayName: "Reasonix",
    adapter: "reasonixctl",
    command: "reasonix acp",
    status: "implemented",
    strengths: [
      "DeepSeek-native coding worker",
      "DeepSeek v4 flash/pro model selection",
      "persistent ACP sessions",
      "manual permission gate",
      "low-cost long sessions via DeepSeek cache design"
    ],
    models: [
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
    ],
    presets: ["auto", "flash", "pro"],
    tools: {
      oneShot: true,
      persistentSessions: true,
      observeEvents: true,
      manualApproval: true,
      cancel: true
    }
  },
  {
    id: "claude-code",
    displayName: "Claude Code",
    adapter: "claude-cli",
    command: "claude -p",
    status: "implemented",
    strengths: [
      "Claude Code one-shot and resumable CLI sessions",
      "JSON output with session ids",
      "large-context coding analysis",
      "native Claude Code tool and permission modes"
    ],
    tools: {
      oneShot: true,
      persistentSessions: true,
      observeEvents: true,
      manualApproval: false,
      cancel: false
    },
    notes: [
      "TaskMarshal records and resumes Claude Code sessions, but Claude Code does not expose an external permission callback like Reasonix ACP.",
      "Use Claude Code permission modes for safety; worker_approve, worker_deny, and worker_cancel return unsupported for this provider."
    ]
  }
];

const server = new McpServer({
  name: "taskmarshal-mcp",
  version: VERSION
});

registerWorkerTools();
registerReasonixCompatTools();

function registerWorkerTools() {
  server.registerTool("worker_list_providers", {
    title: "TaskMarshal List Providers",
    description: "List local CLI coding-agent providers available to TaskMarshal.",
    annotations: readOnlyAnnotations()
  }, async () => toolResult(success({ providers })));

  server.registerTool("worker_doctor", {
    title: "TaskMarshal Provider Doctor",
    description: "Check a provider installation and configuration.",
    inputSchema: {
      provider: Provider.default("reasonix").describe("Worker provider to check.")
    },
    annotations: readOnlyAnnotations()
  }, async ({ provider }) => routeProvider(provider, {
    reasonix: () => runCtl(["doctor"]),
    "claude-code": () => claudeDoctor()
  }));

  server.registerTool("worker_ask", {
    title: "TaskMarshal One-Shot Ask",
    description: "Run a single prompt with a worker provider. Prefer approve='cancel' for read-only analysis.",
    inputSchema: {
      provider: Provider.default("reasonix").describe("Worker provider to use."),
      prompt: z.string().min(1).describe("Prompt to send to the worker."),
      dir: z.string().optional().describe("Working directory. Defaults to the MCP server directory."),
      approve: AskApproveMode.default("cancel").describe("Automatic permission policy for this one-shot turn."),
      model: z.string().optional().describe("Optional provider model override. For Reasonix, accepts flash/pro aliases or full ids: deepseek-v4-flash, deepseek-v4-pro."),
      preset: z.string().optional().describe("Optional provider preset override."),
      budget: z.string().optional().describe("Optional provider budget override."),
      yolo: z.boolean().default(false).describe("Pass provider-specific all-permissions mode. Use only for fully trusted tasks.")
    },
    annotations: actionAnnotations({ openWorld: true })
  }, async ({ provider, prompt, dir, approve, model, preset, budget, yolo }) => routeProvider(provider, {
    reasonix: () => {
      const args = ["ask", prompt, "--approve", approve];
      if (dir) args.push("--dir", dir);
      if (model) args.push("--model", model);
      if (preset) args.push("--preset", preset);
      if (budget) args.push("--budget", budget);
      if (yolo) args.push("--yolo");
      return runCtl(args, { cwd: dir });
    },
    "claude-code": () => claudeAsk({ prompt, dir, approve, model, budget, yolo })
  }));

  server.registerTool("worker_start_session", {
    title: "TaskMarshal Start Worker Session",
    description: "Start a persistent worker session. Use approve='manual' when Codex should gate tool permissions.",
    inputSchema: {
      provider: Provider.default("reasonix").describe("Worker provider to use."),
      id: z.string().regex(/^[A-Za-z0-9_.-]+$/).optional().describe("Optional stable session id."),
      dir: z.string().optional().describe("Working directory for the worker. Defaults to the MCP server directory."),
      approve: ApproveMode.default("manual").describe("Permission policy. 'manual' pauses until worker_approve or worker_deny."),
      model: z.string().optional().describe("Optional provider model override. For Reasonix, accepts flash/pro aliases or full ids: deepseek-v4-flash, deepseek-v4-pro."),
      preset: z.string().optional().describe("Optional provider preset override."),
      budget: z.string().optional().describe("Optional provider budget override."),
      yolo: z.boolean().default(false).describe("Pass provider-specific all-permissions mode. Use only for fully trusted tasks.")
    },
    annotations: actionAnnotations({ openWorld: true })
  }, async ({ provider, id, dir, approve, model, preset, budget, yolo }) => routeProvider(provider, {
    reasonix: () => {
      const args = ["start", "--approve", approve];
      if (id) args.push("--id", id);
      if (dir) args.push("--dir", dir);
      if (model) args.push("--model", model);
      if (preset) args.push("--preset", preset);
      if (budget) args.push("--budget", budget);
      if (yolo) args.push("--yolo");
      return runCtl(args, { cwd: dir });
    },
    "claude-code": () => claudeStartSession({ id, dir, approve, model, budget, yolo })
  }));

  server.registerTool("worker_list_sessions", {
    title: "TaskMarshal List Worker Sessions",
    description: "List known persistent worker sessions and whether their daemons are alive.",
    inputSchema: {
      provider: Provider.default("reasonix").describe("Worker provider to inspect.")
    },
    annotations: readOnlyAnnotations()
  }, async ({ provider }) => routeProvider(provider, {
    reasonix: () => runCtl(["list"]),
    "claude-code": () => claudeListSessions()
  }));

  server.registerTool("worker_status", {
    title: "TaskMarshal Worker Session Status",
    description: "Get detailed state for a persistent worker session, including pending permission requests.",
    inputSchema: {
      provider: Provider.default("reasonix").describe("Worker provider to inspect."),
      id: z.string().min(1).describe("Worker session id.")
    },
    annotations: readOnlyAnnotations()
  }, async ({ provider, id }) => routeProvider(provider, {
    reasonix: () => runCtl(["status", id]),
    "claude-code": () => claudeStatus(id)
  }));

  server.registerTool("worker_send_task", {
    title: "TaskMarshal Send Task",
    description: "Send a task prompt to an existing persistent worker session. Observe separately with worker_observe.",
    inputSchema: {
      provider: Provider.default("reasonix").describe("Worker provider to use."),
      id: z.string().min(1).describe("Worker session id."),
      prompt: z.string().min(1).describe("Task prompt for the worker.")
    },
    annotations: actionAnnotations({ openWorld: true })
  }, async ({ provider, id, prompt }) => routeProvider(provider, {
    reasonix: () => runCtl(["send", id, prompt]),
    "claude-code": () => claudeSendTask({ id, prompt })
  }));

  server.registerTool("worker_observe", {
    title: "TaskMarshal Observe Worker",
    description: "Read recent events from a persistent worker session, including assistant chunks and permission prompts.",
    inputSchema: {
      provider: Provider.default("reasonix").describe("Worker provider to inspect."),
      id: z.string().min(1).describe("Worker session id."),
      tail: z.number().int().min(1).max(400).default(80).describe("Number of event records to return.")
    },
    annotations: readOnlyAnnotations()
  }, async ({ provider, id, tail }) => routeProvider(provider, {
    reasonix: () => runCtl(["observe", id, "--tail", String(tail)]),
    "claude-code": () => claudeObserve({ id, tail })
  }));

  server.registerTool("worker_approve", {
    title: "TaskMarshal Approve Permission",
    description: "Approve the currently pending permission request in a manual worker session.",
    inputSchema: {
      provider: Provider.default("reasonix").describe("Worker provider to control."),
      id: z.string().min(1).describe("Worker session id.")
    },
    annotations: actionAnnotations()
  }, async ({ provider, id }) => routeProvider(provider, {
    reasonix: () => runCtl(["approve", id]),
    "claude-code": () => claudeUnsupported("external permission approval", id)
  }));

  server.registerTool("worker_deny", {
    title: "TaskMarshal Deny Permission",
    description: "Deny the currently pending permission request in a manual worker session.",
    inputSchema: {
      provider: Provider.default("reasonix").describe("Worker provider to control."),
      id: z.string().min(1).describe("Worker session id.")
    },
    annotations: actionAnnotations()
  }, async ({ provider, id }) => routeProvider(provider, {
    reasonix: () => runCtl(["deny", id]),
    "claude-code": () => claudeUnsupported("external permission denial", id)
  }));

  server.registerTool("worker_cancel", {
    title: "TaskMarshal Cancel Turn",
    description: "Cancel the currently running turn in a persistent worker session.",
    inputSchema: {
      provider: Provider.default("reasonix").describe("Worker provider to control."),
      id: z.string().min(1).describe("Worker session id.")
    },
    annotations: actionAnnotations({ destructive: true })
  }, async ({ provider, id }) => routeProvider(provider, {
    reasonix: () => runCtl(["cancel", id]),
    "claude-code": () => claudeUnsupported("external turn cancellation", id)
  }));

  server.registerTool("worker_stop", {
    title: "TaskMarshal Stop Worker Session",
    description: "Stop a persistent worker session daemon.",
    inputSchema: {
      provider: Provider.default("reasonix").describe("Worker provider to control."),
      id: z.string().min(1).describe("Worker session id.")
    },
    annotations: actionAnnotations({ destructive: true })
  }, async ({ provider, id }) => routeProvider(provider, {
    reasonix: () => runCtl(["stop", id]),
    "claude-code": () => claudeStop(id)
  }));
}

function registerReasonixCompatTools() {
  server.registerTool("reasonix_doctor", {
    title: "Reasonix Doctor",
    description: "Compatibility alias for worker_doctor with provider='reasonix'.",
    annotations: readOnlyAnnotations()
  }, async () => toolResult(await runCtl(["doctor"])));

  server.registerTool("reasonix_ask", {
    title: "Reasonix One-Shot Ask",
    description: "Compatibility alias for worker_ask with provider='reasonix'.",
    inputSchema: {
      prompt: z.string().min(1).describe("Prompt to send to Reasonix."),
      dir: z.string().optional().describe("Working directory. Defaults to the MCP server directory."),
      approve: AskApproveMode.default("cancel").describe("Automatic permission policy for this one-shot turn."),
      model: z.string().optional().describe(REASONIX_MODEL_DESCRIPTION),
      preset: z.string().optional().describe("Optional Reasonix preset override."),
      budget: z.string().optional().describe("Optional Reasonix budget override."),
      yolo: z.boolean().default(false).describe("Pass --yolo to Reasonix. Use only for fully trusted tasks.")
    },
    annotations: actionAnnotations({ openWorld: true })
  }, async ({ prompt, dir, approve, model, preset, budget, yolo }) => {
    const args = ["ask", prompt, "--approve", approve];
    if (dir) args.push("--dir", dir);
    if (model) args.push("--model", model);
    if (preset) args.push("--preset", preset);
    if (budget) args.push("--budget", budget);
    if (yolo) args.push("--yolo");
    return toolResult(await runCtl(args, { cwd: dir }));
  });

  server.registerTool("reasonix_start_session", {
    title: "Reasonix Start Session",
    description: "Compatibility alias for worker_start_session with provider='reasonix'.",
    inputSchema: {
      id: z.string().regex(/^[A-Za-z0-9_.-]+$/).optional().describe("Optional stable session id."),
      dir: z.string().optional().describe("Working directory for Reasonix. Defaults to the MCP server directory."),
      approve: ApproveMode.default("manual").describe("Permission policy. 'manual' pauses until reasonix_approve or reasonix_deny."),
      model: z.string().optional().describe(REASONIX_MODEL_DESCRIPTION),
      preset: z.string().optional().describe("Optional Reasonix preset override."),
      budget: z.string().optional().describe("Optional Reasonix budget override."),
      yolo: z.boolean().default(false).describe("Pass --yolo to Reasonix. Use only for fully trusted tasks.")
    },
    annotations: actionAnnotations({ openWorld: true })
  }, async ({ id, dir, approve, model, preset, budget, yolo }) => {
    const args = ["start", "--approve", approve];
    if (id) args.push("--id", id);
    if (dir) args.push("--dir", dir);
    if (model) args.push("--model", model);
    if (preset) args.push("--preset", preset);
    if (budget) args.push("--budget", budget);
    if (yolo) args.push("--yolo");
    return toolResult(await runCtl(args, { cwd: dir }));
  });

  server.registerTool("reasonix_list_sessions", {
    title: "Reasonix List Sessions",
    description: "Compatibility alias for worker_list_sessions with provider='reasonix'.",
    annotations: readOnlyAnnotations()
  }, async () => toolResult(await runCtl(["list"])));

  server.registerTool("reasonix_status", {
    title: "Reasonix Session Status",
    description: "Compatibility alias for worker_status with provider='reasonix'.",
    inputSchema: {
      id: z.string().min(1).describe("Reasonix session id.")
    },
    annotations: readOnlyAnnotations()
  }, async ({ id }) => toolResult(await runCtl(["status", id])));

  server.registerTool("reasonix_send_task", {
    title: "Reasonix Send Task",
    description: "Compatibility alias for worker_send_task with provider='reasonix'.",
    inputSchema: {
      id: z.string().min(1).describe("Reasonix session id."),
      prompt: z.string().min(1).describe("Task prompt for Reasonix.")
    },
    annotations: actionAnnotations({ openWorld: true })
  }, async ({ id, prompt }) => toolResult(await runCtl(["send", id, prompt])));

  server.registerTool("reasonix_observe", {
    title: "Reasonix Observe",
    description: "Compatibility alias for worker_observe with provider='reasonix'.",
    inputSchema: {
      id: z.string().min(1).describe("Reasonix session id."),
      tail: z.number().int().min(1).max(400).default(80).describe("Number of event records to return.")
    },
    annotations: readOnlyAnnotations()
  }, async ({ id, tail }) => toolResult(await runCtl(["observe", id, "--tail", String(tail)])));

  server.registerTool("reasonix_approve", {
    title: "Reasonix Approve Permission",
    description: "Compatibility alias for worker_approve with provider='reasonix'.",
    inputSchema: {
      id: z.string().min(1).describe("Reasonix session id.")
    },
    annotations: actionAnnotations()
  }, async ({ id }) => toolResult(await runCtl(["approve", id])));

  server.registerTool("reasonix_deny", {
    title: "Reasonix Deny Permission",
    description: "Compatibility alias for worker_deny with provider='reasonix'.",
    inputSchema: {
      id: z.string().min(1).describe("Reasonix session id.")
    },
    annotations: actionAnnotations()
  }, async ({ id }) => toolResult(await runCtl(["deny", id])));

  server.registerTool("reasonix_cancel", {
    title: "Reasonix Cancel Turn",
    description: "Compatibility alias for worker_cancel with provider='reasonix'.",
    inputSchema: {
      id: z.string().min(1).describe("Reasonix session id.")
    },
    annotations: actionAnnotations({ destructive: true })
  }, async ({ id }) => toolResult(await runCtl(["cancel", id])));

  server.registerTool("reasonix_stop", {
    title: "Reasonix Stop Session",
    description: "Compatibility alias for worker_stop with provider='reasonix'.",
    inputSchema: {
      id: z.string().min(1).describe("Reasonix session id.")
    },
    annotations: actionAnnotations({ destructive: true })
  }, async ({ id }) => toolResult(await runCtl(["stop", id])));
}

async function routeProvider(provider, handlers) {
  const run = handlers[provider];
  if (!run) {
    return toolResult(failure(`Unsupported provider: ${provider}`));
  }
  try {
    return toolResult(await run());
  } catch (err) {
    return toolResult(failure(err.message || String(err)));
  }
}

async function claudeDoctor() {
  const run = await runProcess(CLAUDE_COMMAND, [...CLAUDE_PREFIX_ARGS, "--version"], { cwd: ROOT });
  return {
    ok: run.exitCode === 0,
    exitCode: run.exitCode,
    stderr: run.stderr,
    stdout: run.stdout,
    data: {
      provider: "claude-code",
      command: [CLAUDE_COMMAND, ...CLAUDE_PREFIX_ARGS].join(" "),
      version: run.stdout.trim() || null,
      available: run.exitCode === 0
    },
    error: run.exitCode === 0 ? undefined : run.stderr.trim() || run.stdout.trim() || "claude --version failed"
  };
}

async function claudeAsk({ prompt, dir, approve, model, budget, yolo }) {
  const result = await runClaudePrint({ prompt, dir, approve, model, budget, yolo });
  if (!result.ok) return result;
  return success({
    provider: "claude-code",
    mode: "one-shot",
    result: result.data.result,
    sessionId: result.data.sessionId,
    stopReason: result.data.stopReason,
    totalCostUsd: result.data.totalCostUsd,
    raw: result.data.raw
  });
}

async function claudeStartSession({ id, dir, approve, model, budget, yolo }) {
  const sessionId = id || `claude-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${randomUUID().slice(0, 8)}`;
  const sessionDir = claudeSessionDir(sessionId);
  mkdirSync(sessionDir, { recursive: true });
  const events = resolve(sessionDir, "events.jsonl");
  const meta = {
    provider: "claude-code",
    id: sessionId,
    status: "ready",
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    dir: resolve(dir || ROOT),
    approve,
    model: model ?? null,
    budget: budget ?? null,
    yolo: Boolean(yolo),
    claudeSessionId: null,
    events,
    turnCount: 0,
    lastTurn: null,
    warnings: [
      "Claude Code sessions are resumed by session id, but TaskMarshal cannot externally approve or deny Claude Code permission prompts."
    ]
  };
  writeJson(claudeMetaPath(sessionId), meta);
  appendJsonl(events, { ts: new Date().toISOString(), method: "control/start", provider: "claude-code", id: sessionId });
  return success(publicClaudeMeta(meta));
}

function claudeListSessions() {
  mkdirSync(CLAUDE_SESSION_DIR, { recursive: true });
  const sessions = readdirSync(CLAUDE_SESSION_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => readJsonLenient(resolve(CLAUDE_SESSION_DIR, entry.name, "session.json")))
    .filter(Boolean)
    .map(publicClaudeMeta)
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  return success({ provider: "claude-code", sessions });
}

function claudeStatus(id) {
  return success(publicClaudeMeta(readClaudeMeta(id)));
}

async function claudeSendTask({ id, prompt }) {
  const meta = readClaudeMeta(id);
  if (meta.status === "stopped") return failure(`Claude Code session is stopped: ${id}`);
  const turnId = randomUUID();
  const startedAt = new Date().toISOString();
  appendJsonl(meta.events, { ts: startedAt, method: "control/send", provider: "claude-code", id, turnId, prompt });
  meta.status = "running";
  meta.updatedAt = startedAt;
  writeJson(claudeMetaPath(id), meta);

  const result = await runClaudePrint({
    prompt,
    dir: meta.dir,
    approve: meta.approve,
    model: meta.model,
    budget: meta.budget,
    yolo: meta.yolo,
    sessionId: meta.claudeSessionId
  });
  const finishedAt = new Date().toISOString();

  if (!result.ok) {
    meta.status = "ready";
    meta.updatedAt = finishedAt;
    meta.lastTurn = { turnId, startedAt, finishedAt, ok: false, error: result.error };
    meta.turnCount = (meta.turnCount ?? 0) + 1;
    writeJson(claudeMetaPath(id), meta);
    appendJsonl(meta.events, { ts: finishedAt, method: "control/turn_error", provider: "claude-code", id, turnId, error: result.error });
    return result;
  }

  if (result.data.sessionId) meta.claudeSessionId = result.data.sessionId;
  const turn = {
    turnId,
    startedAt,
    finishedAt,
    ok: true,
    stopReason: result.data.stopReason,
    sessionId: result.data.sessionId,
    totalCostUsd: result.data.totalCostUsd,
    assistantText: result.data.result
  };
  meta.status = "ready";
  meta.updatedAt = finishedAt;
  meta.lastTurn = turn;
  meta.turnCount = (meta.turnCount ?? 0) + 1;
  writeJson(claudeMetaPath(id), meta);
  appendJsonl(meta.events, { ts: finishedAt, method: "control/turn_finished", provider: "claude-code", id, turnId, turn });
  return success({ provider: "claude-code", id, status: "ready", turn, claudeSessionId: meta.claudeSessionId });
}

function claudeObserve({ id, tail }) {
  const meta = readClaudeMeta(id);
  return success({
    provider: "claude-code",
    id,
    status: publicClaudeMeta(meta),
    events: readTailJsonl(meta.events, tail)
  });
}

function claudeStop(id) {
  const meta = readClaudeMeta(id);
  meta.status = "stopped";
  meta.updatedAt = new Date().toISOString();
  writeJson(claudeMetaPath(id), meta);
  appendJsonl(meta.events, { ts: meta.updatedAt, method: "control/stop", provider: "claude-code", id });
  return success(publicClaudeMeta(meta));
}

function claudeUnsupported(action, id) {
  return failure(`Provider claude-code does not support ${action} through TaskMarshal for session ${id}. Claude Code handles permissions inside its own CLI process; use permission-mode planning/accept settings or an interactive Claude Code session when live approval is required.`);
}

async function runClaudePrint({ prompt, dir, approve = "cancel", model, budget, yolo = false, sessionId }) {
  const permissionMode = mapClaudePermissionMode(approve, yolo);
  const args = ["-p", prompt, "--output-format", "json", "--permission-mode", permissionMode];
  if (sessionId) args.push("--resume", sessionId);
  if (model) args.push("--model", model);
  if (budget) args.push("--max-budget-usd", String(budget));
  if (yolo) args.push("--dangerously-skip-permissions");

  const run = await runProcess(CLAUDE_COMMAND, [...CLAUDE_PREFIX_ARGS, ...args], { cwd: dir ? resolve(dir) : ROOT });
  const parsed = parseJson(run.stdout);
  const ok = run.exitCode === 0 && parsed && parsed.is_error !== true;
  return {
    ok,
    exitCode: run.exitCode,
    stdout: run.stdout,
    stderr: run.stderr,
    error: ok ? undefined : run.stderr.trim() || parsed?.result || parsed?.api_error_status || run.stdout.trim() || "claude command failed",
    data: {
      provider: "claude-code",
      result: parsed?.result ?? run.stdout.trim(),
      sessionId: parsed?.session_id ?? null,
      stopReason: parsed?.stop_reason ?? null,
      totalCostUsd: parsed?.total_cost_usd ?? null,
      permissionMode,
      raw: parsed
    }
  };
}

function mapClaudePermissionMode(approve, yolo) {
  if (yolo) return "bypassPermissions";
  if (approve === "once" || approve === "always") return "acceptEdits";
  return "plan";
}

function claudeSessionDir(id) {
  return resolve(CLAUDE_SESSION_DIR, id);
}

function claudeMetaPath(id) {
  return resolve(claudeSessionDir(id), "session.json");
}

function readClaudeMeta(id) {
  const meta = readJsonLenient(claudeMetaPath(id));
  if (!meta) throw new Error(`Unknown Claude Code session: ${id}`);
  return meta;
}

function publicClaudeMeta(meta) {
  return {
    provider: "claude-code",
    id: meta.id,
    status: meta.status,
    alive: false,
    dir: meta.dir,
    approve: meta.approve,
    model: meta.model,
    budget: meta.budget,
    yolo: meta.yolo,
    claudeSessionId: meta.claudeSessionId,
    startedAt: meta.startedAt,
    updatedAt: meta.updatedAt,
    turnCount: meta.turnCount ?? 0,
    lastTurn: meta.lastTurn ?? null,
    events: meta.events,
    warnings: meta.warnings ?? []
  };
}

async function runCtl(args, { cwd } = {}) {
  if (!existsSync(CTL)) throw new Error(`reasonixctl.js not found: ${CTL}`);
  const childCwd = cwd ? resolve(cwd) : ROOT;
  return runProcess(process.execPath, [CTL, ...args], { cwd: childCwd }).then((run) => {
    const parsed = parseJson(run.stdout);
    const result = {
      ok: run.exitCode === 0 && parsed !== null,
      exitCode: run.exitCode,
      stdout: run.stdout,
      stderr: run.stderr,
      data: parsed
    };
    if (run.exitCode !== 0) {
      result.ok = false;
      result.error = run.stderr.trim() || run.stdout.trim() || `reasonixctl exited with code ${run.exitCode}`;
    }
    return result;
  });
}

function runProcess(command, args, { cwd } = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      cwd: cwd || ROOT,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", rejectRun);
    child.on("close", (exitCode) => resolveRun({ exitCode, stdout, stderr }));
  });
}

function parseJson(text) {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function success(data) {
  return { ok: true, exitCode: 0, data };
}

function failure(error) {
  return { ok: false, exitCode: null, error, data: null };
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function readJsonLenient(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
  } catch {
    return null;
  }
}

function appendJsonl(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(value)}\n`, "utf8");
}

function readTailJsonl(path, count) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .slice(-count)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return { malformed: line };
      }
    });
}

function toolResult(result) {
  const structuredContent = sanitizeRunResult(result);
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(structuredContent, null, 2)
      }
    ],
    structuredContent,
    isError: !structuredContent.ok
  };
}

function sanitizeRunResult(result) {
  const out = {
    ok: Boolean(result.ok),
    exitCode: result.exitCode ?? null,
    data: result.data ?? null
  };
  if (!result.ok) out.error = result.error ?? result.stderr ?? "unknown TaskMarshal provider error";
  if (result.stderr?.trim()) out.stderr = result.stderr.trim().slice(-4000);
  if (!result.data && result.stdout?.trim()) out.stdout = result.stdout.trim().slice(-4000);
  return out;
}

function readOnlyAnnotations() {
  return {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false
  };
}

function actionAnnotations({ destructive = false, openWorld = false } = {}) {
  return {
    readOnlyHint: false,
    destructiveHint: destructive,
    idempotentHint: false,
    openWorldHint: openWorld
  };
}

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("taskmarshal-mcp running on stdio");
}

main().catch((err) => {
  console.error(err.stack || err.message || String(err));
  process.exit(1);
});

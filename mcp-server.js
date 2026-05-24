#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";

const VERSION = "0.1.0";
const ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)));
const CTL = resolve(ROOT, "reasonixctl.js");

const Provider = z.enum(["reasonix"]);
const ApproveMode = z.enum(["manual", "cancel", "once", "always", "reject"]);
const AskApproveMode = z.enum(["cancel", "once", "always", "reject"]);

const providers = [
  {
    id: "reasonix",
    displayName: "Reasonix",
    adapter: "reasonixctl",
    command: "reasonix acp",
    status: "implemented",
    strengths: [
      "DeepSeek-native coding worker",
      "persistent ACP sessions",
      "manual permission gate",
      "low-cost long sessions via DeepSeek cache design"
    ],
    tools: {
      oneShot: true,
      persistentSessions: true,
      observeEvents: true,
      manualApproval: true,
      cancel: true
    }
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
    description: "Check a provider installation and configuration. Currently supports provider='reasonix'.",
    inputSchema: {
      provider: Provider.default("reasonix").describe("Worker provider to check.")
    },
    annotations: readOnlyAnnotations()
  }, async ({ provider }) => routeProvider(provider, () => runCtl(["doctor"])));

  server.registerTool("worker_ask", {
    title: "TaskMarshal One-Shot Ask",
    description: "Run a single prompt with a worker provider. Prefer approve='cancel' for read-only analysis.",
    inputSchema: {
      provider: Provider.default("reasonix").describe("Worker provider to use."),
      prompt: z.string().min(1).describe("Prompt to send to the worker."),
      dir: z.string().optional().describe("Working directory. Defaults to the MCP server directory."),
      approve: AskApproveMode.default("cancel").describe("Automatic permission policy for this one-shot turn."),
      model: z.string().optional().describe("Optional provider model override."),
      preset: z.string().optional().describe("Optional provider preset override."),
      budget: z.string().optional().describe("Optional provider budget override."),
      yolo: z.boolean().default(false).describe("Pass provider-specific all-permissions mode. Use only for fully trusted tasks.")
    },
    annotations: actionAnnotations({ openWorld: true })
  }, async ({ provider, prompt, dir, approve, model, preset, budget, yolo }) => routeProvider(provider, () => {
    const args = ["ask", prompt, "--approve", approve];
    if (dir) args.push("--dir", dir);
    if (model) args.push("--model", model);
    if (preset) args.push("--preset", preset);
    if (budget) args.push("--budget", budget);
    if (yolo) args.push("--yolo");
    return runCtl(args, { cwd: dir });
  }));

  server.registerTool("worker_start_session", {
    title: "TaskMarshal Start Worker Session",
    description: "Start a persistent worker session. Use approve='manual' when Codex should gate tool permissions.",
    inputSchema: {
      provider: Provider.default("reasonix").describe("Worker provider to use."),
      id: z.string().regex(/^[A-Za-z0-9_.-]+$/).optional().describe("Optional stable session id."),
      dir: z.string().optional().describe("Working directory for the worker. Defaults to the MCP server directory."),
      approve: ApproveMode.default("manual").describe("Permission policy. 'manual' pauses until worker_approve or worker_deny."),
      model: z.string().optional().describe("Optional provider model override."),
      preset: z.string().optional().describe("Optional provider preset override."),
      budget: z.string().optional().describe("Optional provider budget override."),
      yolo: z.boolean().default(false).describe("Pass provider-specific all-permissions mode. Use only for fully trusted tasks.")
    },
    annotations: actionAnnotations({ openWorld: true })
  }, async ({ provider, id, dir, approve, model, preset, budget, yolo }) => routeProvider(provider, () => {
    const args = ["start", "--approve", approve];
    if (id) args.push("--id", id);
    if (dir) args.push("--dir", dir);
    if (model) args.push("--model", model);
    if (preset) args.push("--preset", preset);
    if (budget) args.push("--budget", budget);
    if (yolo) args.push("--yolo");
    return runCtl(args, { cwd: dir });
  }));

  server.registerTool("worker_list_sessions", {
    title: "TaskMarshal List Worker Sessions",
    description: "List known persistent worker sessions and whether their daemons are alive.",
    inputSchema: {
      provider: Provider.default("reasonix").describe("Worker provider to inspect.")
    },
    annotations: readOnlyAnnotations()
  }, async ({ provider }) => routeProvider(provider, () => runCtl(["list"])));

  server.registerTool("worker_status", {
    title: "TaskMarshal Worker Session Status",
    description: "Get detailed state for a persistent worker session, including pending permission requests.",
    inputSchema: {
      provider: Provider.default("reasonix").describe("Worker provider to inspect."),
      id: z.string().min(1).describe("Worker session id.")
    },
    annotations: readOnlyAnnotations()
  }, async ({ provider, id }) => routeProvider(provider, () => runCtl(["status", id])));

  server.registerTool("worker_send_task", {
    title: "TaskMarshal Send Task",
    description: "Send a task prompt to an existing persistent worker session. Observe separately with worker_observe.",
    inputSchema: {
      provider: Provider.default("reasonix").describe("Worker provider to use."),
      id: z.string().min(1).describe("Worker session id."),
      prompt: z.string().min(1).describe("Task prompt for the worker.")
    },
    annotations: actionAnnotations({ openWorld: true })
  }, async ({ provider, id, prompt }) => routeProvider(provider, () => runCtl(["send", id, prompt])));

  server.registerTool("worker_observe", {
    title: "TaskMarshal Observe Worker",
    description: "Read recent events from a persistent worker session, including assistant chunks and permission prompts.",
    inputSchema: {
      provider: Provider.default("reasonix").describe("Worker provider to inspect."),
      id: z.string().min(1).describe("Worker session id."),
      tail: z.number().int().min(1).max(400).default(80).describe("Number of event records to return.")
    },
    annotations: readOnlyAnnotations()
  }, async ({ provider, id, tail }) => routeProvider(provider, () => runCtl(["observe", id, "--tail", String(tail)])));

  server.registerTool("worker_approve", {
    title: "TaskMarshal Approve Permission",
    description: "Approve the currently pending permission request in a manual worker session.",
    inputSchema: {
      provider: Provider.default("reasonix").describe("Worker provider to control."),
      id: z.string().min(1).describe("Worker session id.")
    },
    annotations: actionAnnotations()
  }, async ({ provider, id }) => routeProvider(provider, () => runCtl(["approve", id])));

  server.registerTool("worker_deny", {
    title: "TaskMarshal Deny Permission",
    description: "Deny the currently pending permission request in a manual worker session.",
    inputSchema: {
      provider: Provider.default("reasonix").describe("Worker provider to control."),
      id: z.string().min(1).describe("Worker session id.")
    },
    annotations: actionAnnotations()
  }, async ({ provider, id }) => routeProvider(provider, () => runCtl(["deny", id])));

  server.registerTool("worker_cancel", {
    title: "TaskMarshal Cancel Turn",
    description: "Cancel the currently running turn in a persistent worker session.",
    inputSchema: {
      provider: Provider.default("reasonix").describe("Worker provider to control."),
      id: z.string().min(1).describe("Worker session id.")
    },
    annotations: actionAnnotations({ destructive: true })
  }, async ({ provider, id }) => routeProvider(provider, () => runCtl(["cancel", id])));

  server.registerTool("worker_stop", {
    title: "TaskMarshal Stop Worker Session",
    description: "Stop a persistent worker session daemon.",
    inputSchema: {
      provider: Provider.default("reasonix").describe("Worker provider to control."),
      id: z.string().min(1).describe("Worker session id.")
    },
    annotations: actionAnnotations({ destructive: true })
  }, async ({ provider, id }) => routeProvider(provider, () => runCtl(["stop", id])));
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
      model: z.string().optional().describe("Optional Reasonix model override."),
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
      model: z.string().optional().describe("Optional Reasonix model override."),
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

async function routeProvider(provider, run) {
  if (provider !== "reasonix") {
    return toolResult(failure(`Unsupported provider: ${provider}`));
  }
  return toolResult(await run());
}

async function runCtl(args, { cwd } = {}) {
  if (!existsSync(CTL)) throw new Error(`reasonixctl.js not found: ${CTL}`);
  const childCwd = cwd ? resolve(cwd) : ROOT;
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [CTL, ...args], {
      cwd: childCwd,
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
    child.on("close", (exitCode) => {
      const parsed = parseJson(stdout);
      const result = {
        ok: exitCode === 0 && parsed !== null,
        exitCode,
        stdout,
        stderr,
        data: parsed
      };
      if (exitCode !== 0) {
        result.ok = false;
        result.error = stderr.trim() || stdout.trim() || `reasonixctl exited with code ${exitCode}`;
      }
      resolveRun(result);
    });
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

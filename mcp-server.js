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
const CTL = resolve(ROOT, "taskmarshalctl.js");
const STATE_DIR = resolve(homedir(), ".taskmarshal");
const CLAUDE_SESSION_DIR = resolve(STATE_DIR, "providers", "claude-code", "sessions");
const CLAUDE_COMMAND = process.platform === "win32" ? "cmd.exe" : "claude";
const CLAUDE_PREFIX_ARGS = process.platform === "win32" ? ["/d", "/s", "/c", "claude"] : [];
const TOOL_PROFILE = normalizeToolProfile(process.env.TASKMARSHAL_TOOL_PROFILE);
const HIDE_LEGACY_REASONIX_TOOLS = truthyEnv(process.env.TASKMARSHAL_HIDE_LEGACY_REASONIX_TOOLS) || TOOL_PROFILE === "minimal";
const COMPACT_TOOL_TEXT = truthyEnv(process.env.TASKMARSHAL_COMPACT_TOOL_TEXT);

const Provider = z.enum(["reasonix", "claude-code"]);
const ApproveMode = z.enum(["manual", "cancel", "once", "always", "reject"]);
const AskApproveMode = z.enum(["cancel", "once", "always", "reject"]);
const ObserveMode = z.enum(["events", "summary", "final", "permission"]);
const ReviewRisk = z.enum(["low", "medium", "high"]);
const RouteRisk = z.enum(["low", "medium", "high"]);
const VerificationStatus = z.enum(["pass", "fail", "skip"]);
const REASONIX_MODEL_DESCRIPTION = "Optional Reasonix model override. Accepts flash/pro aliases or full ids: deepseek-v4-flash, deepseek-v4-pro.";

const providers = [
  {
    id: "reasonix",
    displayName: "Reasonix",
    adapter: "taskmarshalctl",
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
if (!HIDE_LEGACY_REASONIX_TOOLS) registerReasonixCompatTools();

function registerWorkerTools() {
  const enabled = (name) => toolEnabled(name);
  server.registerTool("worker_list_providers", {
    title: "TaskMarshal List Providers",
    description: "List local CLI coding-agent providers available to TaskMarshal.",
    annotations: readOnlyAnnotations()
  }, async () => toolResult(success({ providers })));

  if (enabled("worker_doctor")) server.registerTool("worker_doctor", {
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

  if (enabled("worker_ask")) server.registerTool("worker_ask", {
    title: "TaskMarshal One-Shot Ask",
    description: "Run a short single prompt with a worker provider. Avoid for long repo audits or slow investigations; use worker_start_session, worker_send_task, and worker_observe instead.",
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

  if (enabled("worker_list_sessions")) server.registerTool("worker_list_sessions", {
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

  if (enabled("worker_status")) server.registerTool("worker_status", {
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
      prompt: z.string().min(1).describe("Task prompt for the worker."),
      taskId: z.string().optional().describe("Optional TaskMarshal task id to attach to this worker turn's metrics.")
    },
    annotations: actionAnnotations({ openWorld: true })
  }, async ({ provider, id, prompt, taskId }) => routeProvider(provider, {
    reasonix: () => {
      const args = ["send", id];
      if (taskId) args.push("--task-id", taskId);
      args.push(prompt);
      return runCtl(args);
    },
    "claude-code": () => claudeSendTask({ id, prompt, taskId })
  }));

  server.registerTool("worker_observe", {
    title: "TaskMarshal Observe Worker",
    description: "Read recent events or compact state from a persistent worker session. Use compact modes to save Codex context.",
    inputSchema: {
      provider: Provider.default("reasonix").describe("Worker provider to inspect."),
      id: z.string().min(1).describe("Worker session id."),
      tail: z.number().int().min(1).max(400).default(80).describe("Number of event records to return in events mode."),
      mode: ObserveMode.default("events").describe("Observation mode: events, summary, final, or permission."),
      maxChars: z.number().int().min(500).max(50000).default(12000).describe("Approximate maximum characters for large text fields."),
      since: z.number().int().min(0).default(0).describe("Optional event cursor from a previous observe call.")
    },
    annotations: readOnlyAnnotations()
  }, async ({ provider, id, tail, mode, maxChars, since }) => routeProvider(provider, {
    reasonix: () => runCtl(["observe", id, "--tail", String(tail), "--mode", mode, "--max-chars", String(maxChars), "--since", String(since)]),
    "claude-code": () => claudeObserve({ id, tail, mode, maxChars, since })
  }));

  if (enabled("worker_summarize_session")) server.registerTool("worker_summarize_session", {
    title: "TaskMarshal Summarize Worker Session",
    description: "Return a compact session summary and lightweight metrics without replaying full event logs.",
    inputSchema: {
      provider: Provider.default("reasonix").describe("Worker provider to inspect."),
      id: z.string().min(1).describe("Worker session id."),
      maxChars: z.number().int().min(500).max(50000).default(6000).describe("Approximate maximum characters for large text fields.")
    },
    annotations: readOnlyAnnotations()
  }, async ({ provider, id, maxChars }) => routeProvider(provider, {
    reasonix: () => runCtl(["summarize", id, "--max-chars", String(maxChars)]),
    "claude-code": () => claudeSummarizeSession({ id, maxChars })
  }));

  server.registerTool("worker_metrics_report", {
    title: "TaskMarshal Metrics Report",
    description: "Return a compact cross-session metrics report for routing and token-efficiency decisions.",
    inputSchema: {
      provider: Provider.default("reasonix").describe("Worker provider to inspect."),
      limit: z.number().int().min(1).max(500).default(20).describe("Maximum recent metric records to include."),
      model: z.string().optional().describe("Optional model filter."),
      since: z.string().optional().describe("Optional parseable date or timestamp filter."),
      maxSessions: z.number().int().min(1).max(2000).default(200).describe("Maximum session directories to scan."),
      compact: z.boolean().default(false).describe("Return compact aggregates plus up to three recent records.")
    },
    annotations: readOnlyAnnotations()
  }, async ({ provider, limit, model, since, maxSessions, compact }) => routeProvider(provider, {
    reasonix: () => {
      const args = ["metrics", "--limit", String(limit), "--max-sessions", String(maxSessions)];
      if (model) args.push("--model", model);
      if (since) args.push("--since", since);
      if (compact) args.push("--compact");
      return runCtl(args);
    },
    "claude-code": () => claudeMetricsReport({ limit, model, since, maxSessions, compact })
  }));

  server.registerTool("worker_task_gate", {
    title: "TaskMarshal Task Gate",
    description: "Merged token-firewall task gate: route, create, checkpoint, verify, or finalize.",
    inputSchema: {
      action: z.enum(["route", "create", "checkpoint", "verify", "finalize"]).default("route").describe("Gate action."),
      goal: z.string().default("").describe("Short task goal for route/create."),
      scope: z.string().default("").describe("Comma-separated files or modules."),
      risk: RouteRisk.default("medium").describe("Risk level."),
      files: z.number().int().min(0).max(200).default(0).describe("Approximate file count for route."),
      route: z.enum(["local", "flash", "pro"]).optional().describe("Optional explicit route."),
      steps: z.string().default("").describe("Optional semicolon-separated short steps for create."),
      id: z.string().default("").describe("Task id for checkpoint/verify/finalize."),
      step: z.string().default("").describe("Step id for checkpoint."),
      status: VerificationStatus.optional().describe("Verification status for verify."),
      command: z.string().default("").describe("Verification command for verify."),
      exitCode: z.number().int().optional().describe("Command exit code for verify."),
      session: z.string().default("").describe("Optional worker session id for direct metric patching; requires turnId."),
      turnId: z.string().default("").describe("Worker turn id to mark as verified when session is provided."),
      note: z.string().default("").describe("Short note."),
      batch: z.array(z.object({
        action: z.enum(["route", "create", "checkpoint", "verify", "finalize"]),
        goal: z.string().optional(),
        scope: z.string().optional(),
        risk: RouteRisk.optional(),
        files: z.number().int().min(0).max(200).optional(),
        route: z.enum(["local", "flash", "pro"]).optional(),
        steps: z.string().optional(),
        id: z.string().optional(),
        step: z.string().optional(),
        status: VerificationStatus.optional(),
        command: z.string().optional(),
        exitCode: z.number().int().optional(),
        session: z.string().optional(),
        turnId: z.string().optional(),
        note: z.string().optional()
      })).max(8).optional().describe("Optional ordered batch of gate actions.")
    },
    annotations: readOnlyAnnotations()
  }, async (input) => toolResult(await runTaskGate(input)));

  if (enabled("worker_route_decision")) server.registerTool("worker_route_decision", {
    title: "TaskMarshal Route Decision",
    description: "Return a short deterministic Local/flash/pro routing decision.",
    inputSchema: {
      goal: z.string().min(1).describe("Short task goal."),
      scope: z.string().default("").describe("Comma-separated files or modules."),
      risk: RouteRisk.default("medium").describe("Risk level."),
      files: z.number().int().min(0).max(200).default(0).describe("Approximate file count."),
      route: z.enum(["local", "flash", "pro"]).optional().describe("Optional explicit route.")
    },
    annotations: readOnlyAnnotations()
  }, async ({ goal, scope, risk, files, route }) => {
    const args = ["route", "--goal", goal, "--risk", risk, "--files", String(files)];
    if (scope) args.push("--scope", scope);
    if (route) args.push("--route", route);
    return toolResult(await runCtl(args));
  });

  if (enabled("worker_create_task")) server.registerTool("worker_create_task", {
    title: "TaskMarshal Create Task",
    description: "Create a local token-firewall task ledger and return only a short control packet.",
    inputSchema: {
      goal: z.string().min(1).describe("Short task goal."),
      scope: z.string().default("").describe("Comma-separated files or modules."),
      risk: RouteRisk.default("medium").describe("Risk level."),
      route: z.enum(["local", "flash", "pro"]).optional().describe("Optional explicit route."),
      steps: z.string().default("").describe("Optional semicolon-separated short steps.")
    },
    annotations: readOnlyAnnotations()
  }, async ({ goal, scope, risk, route, steps }) => {
    const args = ["task-create", "--goal", goal, "--risk", risk];
    if (scope) args.push("--scope", scope);
    if (route) args.push("--route", route);
    if (steps) args.push("--steps", steps);
    return toolResult(await runCtl(args));
  });

  if (enabled("worker_record_verification")) server.registerTool("worker_record_verification", {
    title: "TaskMarshal Record Verification",
    description: "Record pass/fail/skip verification for a token-firewall task.",
    inputSchema: {
      id: z.string().min(1).describe("Task id."),
      status: VerificationStatus.describe("Verification status."),
      command: z.string().default("").describe("Verification command or check."),
      exitCode: z.number().int().optional().describe("Command exit code."),
      session: z.string().default("").describe("Optional worker session id for direct metric patching; requires turnId."),
      turnId: z.string().default("").describe("Worker turn id to mark as verified when session is provided."),
      note: z.string().default("").describe("Short verification note.")
    },
    annotations: readOnlyAnnotations()
  }, async ({ id, status, command, exitCode, session, turnId, note }) => {
    const args = ["verify", "--id", id, "--status", status];
    if (command) args.push("--command", command);
    if (exitCode !== undefined) args.push("--exit-code", String(exitCode));
    if (session) args.push("--session", session);
    if (turnId) args.push("--turn-id", turnId);
    if (note) args.push("--note", note);
    return toolResult(await runCtl(args));
  });

  if (enabled("worker_checkpoint_step")) server.registerTool("worker_checkpoint_step", {
    title: "TaskMarshal Checkpoint Step",
    description: "Mark one token-firewall task step done and return a short gate status.",
    inputSchema: {
      id: z.string().min(1).describe("Task id."),
      step: z.string().min(1).describe("Step id, for example s1."),
      note: z.string().default("").describe("Short checkpoint note.")
    },
    annotations: readOnlyAnnotations()
  }, async ({ id, step, note }) => {
    const args = ["checkpoint", "--id", id, "--step", step];
    if (note) args.push("--note", note);
    return toolResult(await runCtl(args));
  });

  if (enabled("worker_finalize_task")) server.registerTool("worker_finalize_task", {
    title: "TaskMarshal Finalize Task",
    description: "Finalize a token-firewall task and return a short taskKey proof when gates pass.",
    inputSchema: {
      id: z.string().min(1).describe("Task id.")
    },
    annotations: readOnlyAnnotations()
  }, async ({ id }) => toolResult(await runCtl(["finalize", "--id", id])));

  if (enabled("worker_plan_pro_review")) server.registerTool("worker_plan_pro_review", {
    title: "TaskMarshal Plan Pro Review",
    description: "Create a bounded DeepSeek v4 pro second-pass review task for high-risk, architecture, tricky debugging, or final verification work.",
    inputSchema: {
      goal: z.string().min(1).describe("Concrete review objective."),
      risk: ReviewRisk.default("high").describe("Review risk level."),
      scope: z.string().default("").describe("Files, modules, or decision surface to review."),
      acceptance: z.string().default("").describe("Acceptance criteria or reviewer questions."),
      verification: z.string().default("").describe("Verification commands or checks to consider."),
      dir: z.string().optional().describe("Working directory for the proposed review session.")
    },
    annotations: readOnlyAnnotations()
  }, async ({ goal, risk, scope, acceptance, verification, dir }) => toolResult(success({
    provider: "reasonix",
    recommendedModel: "pro",
    model: "deepseek-v4-pro",
    reason: proReviewReason(risk),
    startSession: {
      provider: "reasonix",
      approve: "manual",
      model: "pro",
      dir: dir ?? null
    },
    prompt: buildProReviewPrompt({ goal, risk, scope, acceptance, verification })
  })));

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

  if (enabled("worker_cancel")) server.registerTool("worker_cancel", {
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
    description: "Legacy compatibility alias for worker_doctor with provider='reasonix'. Prefer worker_doctor.",
    annotations: readOnlyAnnotations()
  }, async () => toolResult(await runCtl(["doctor"])));

  server.registerTool("reasonix_ask", {
    title: "Reasonix One-Shot Ask",
    description: "Legacy compatibility alias for worker_ask with provider='reasonix'. Prefer worker_ask; use only for short one-shot prompts.",
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
    description: "Legacy compatibility alias for worker_start_session with provider='reasonix'. Prefer worker_start_session.",
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
    description: "Legacy compatibility alias for worker_list_sessions with provider='reasonix'. Prefer worker_list_sessions.",
    annotations: readOnlyAnnotations()
  }, async () => toolResult(await runCtl(["list"])));

  server.registerTool("reasonix_status", {
    title: "Reasonix Session Status",
    description: "Legacy compatibility alias for worker_status with provider='reasonix'. Prefer worker_status.",
    inputSchema: {
      id: z.string().min(1).describe("Reasonix session id.")
    },
    annotations: readOnlyAnnotations()
  }, async ({ id }) => toolResult(await runCtl(["status", id])));

  server.registerTool("reasonix_send_task", {
    title: "Reasonix Send Task",
    description: "Legacy compatibility alias for worker_send_task with provider='reasonix'. Prefer worker_send_task.",
    inputSchema: {
      id: z.string().min(1).describe("Reasonix session id."),
      prompt: z.string().min(1).describe("Task prompt for Reasonix."),
      taskId: z.string().optional().describe("Optional TaskMarshal task id to attach to this worker turn's metrics.")
    },
    annotations: actionAnnotations({ openWorld: true })
  }, async ({ id, prompt, taskId }) => {
    const args = ["send", id];
    if (taskId) args.push("--task-id", taskId);
    args.push(prompt);
    return toolResult(await runCtl(args));
  });

  server.registerTool("reasonix_observe", {
    title: "Reasonix Observe",
    description: "Legacy compatibility alias for worker_observe with provider='reasonix'. Prefer worker_observe.",
    inputSchema: {
      id: z.string().min(1).describe("Reasonix session id."),
      tail: z.number().int().min(1).max(400).default(80).describe("Number of event records to return in events mode."),
      mode: ObserveMode.default("events").describe("Observation mode: events, summary, final, or permission."),
      maxChars: z.number().int().min(500).max(50000).default(12000).describe("Approximate maximum characters for large text fields."),
      since: z.number().int().min(0).default(0).describe("Optional event cursor from a previous observe call.")
    },
    annotations: readOnlyAnnotations()
  }, async ({ id, tail, mode, maxChars, since }) => {
    return toolResult(await runCtl(["observe", id, "--tail", String(tail), "--mode", mode, "--max-chars", String(maxChars), "--since", String(since)]));
  });

  server.registerTool("reasonix_summarize_session", {
    title: "Reasonix Summarize Session",
    description: "Legacy compatibility alias for worker_summarize_session with provider='reasonix'. Prefer worker_summarize_session.",
    inputSchema: {
      id: z.string().min(1).describe("Reasonix session id."),
      maxChars: z.number().int().min(500).max(50000).default(6000).describe("Approximate maximum characters for large text fields.")
    },
    annotations: readOnlyAnnotations()
  }, async ({ id, maxChars }) => {
    return toolResult(await runCtl(["summarize", id, "--max-chars", String(maxChars)]));
  });

  server.registerTool("reasonix_metrics_report", {
    title: "Reasonix Metrics Report",
    description: "Legacy compatibility alias for worker_metrics_report with provider='reasonix'. Prefer worker_metrics_report.",
    inputSchema: {
      limit: z.number().int().min(1).max(500).default(20).describe("Maximum recent metric records to include."),
      model: z.string().optional().describe("Optional model filter."),
      since: z.string().optional().describe("Optional parseable date or timestamp filter."),
      maxSessions: z.number().int().min(1).max(2000).default(200).describe("Maximum session directories to scan."),
      compact: z.boolean().default(false).describe("Return compact aggregates plus up to three recent records.")
    },
    annotations: readOnlyAnnotations()
  }, async ({ limit, model, since, maxSessions, compact }) => {
    const args = ["metrics", "--limit", String(limit), "--max-sessions", String(maxSessions)];
    if (model) args.push("--model", model);
    if (since) args.push("--since", since);
    if (compact) args.push("--compact");
    return toolResult(await runCtl(args));
  });

  server.registerTool("reasonix_approve", {
    title: "Reasonix Approve Permission",
    description: "Legacy compatibility alias for worker_approve with provider='reasonix'. Prefer worker_approve.",
    inputSchema: {
      id: z.string().min(1).describe("Reasonix session id.")
    },
    annotations: actionAnnotations()
  }, async ({ id }) => toolResult(await runCtl(["approve", id])));

  server.registerTool("reasonix_deny", {
    title: "Reasonix Deny Permission",
    description: "Legacy compatibility alias for worker_deny with provider='reasonix'. Prefer worker_deny.",
    inputSchema: {
      id: z.string().min(1).describe("Reasonix session id.")
    },
    annotations: actionAnnotations()
  }, async ({ id }) => toolResult(await runCtl(["deny", id])));

  server.registerTool("reasonix_cancel", {
    title: "Reasonix Cancel Turn",
    description: "Legacy compatibility alias for worker_cancel with provider='reasonix'. Prefer worker_cancel.",
    inputSchema: {
      id: z.string().min(1).describe("Reasonix session id.")
    },
    annotations: actionAnnotations({ destructive: true })
  }, async ({ id }) => toolResult(await runCtl(["cancel", id])));

  server.registerTool("reasonix_stop", {
    title: "Reasonix Stop Session",
    description: "Legacy compatibility alias for worker_stop with provider='reasonix'. Prefer worker_stop.",
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

async function runTaskGate(input) {
  if (Array.isArray(input.batch) && input.batch.length) {
    const results = [];
    for (let index = 0; index < input.batch.length; index += 1) {
      const item = { ...input, ...input.batch[index], batch: undefined };
      const result = await runTaskGate(item);
      results.push({
        index,
        action: item.action,
        ok: Boolean(result.ok),
        data: result.data,
        error: result.error ?? null,
        exitCode: result.exitCode ?? null
      });
      if (!result.ok) {
        return success({
          action: "batch",
          ok: false,
          completed: results.filter((entry) => entry.ok).length,
          total: input.batch.length,
          stoppedAt: index,
          results,
          next: "fix_failed_batch_item"
        });
      }
    }
    return success({
      action: "batch",
      ok: true,
      completed: results.length,
      total: results.length,
      results,
      next: "continue"
    });
  }
  const action = input.action;
  if (action === "route") {
    const missing = missingFields(input, ["goal"]);
    if (missing.length) return failure(`Missing required field(s) for task gate route: ${missing.join(", ")}`);
    const args = ["route", "--goal", input.goal, "--risk", input.risk, "--files", String(input.files)];
    if (input.scope) args.push("--scope", input.scope);
    if (input.route) args.push("--route", input.route);
    return tagTaskGateResult(action, await runCtl(args));
  }
  if (action === "create") {
    const missing = missingFields(input, ["goal"]);
    if (missing.length) return failure(`Missing required field(s) for task gate create: ${missing.join(", ")}`);
    const args = ["task-create", "--goal", input.goal, "--risk", input.risk];
    if (input.scope) args.push("--scope", input.scope);
    if (input.route) args.push("--route", input.route);
    if (input.steps) args.push("--steps", input.steps);
    return tagTaskGateResult(action, await runCtl(args));
  }
  if (action === "checkpoint") {
    const missing = missingFields(input, ["id", "step"]);
    if (missing.length) return failure(`Missing required field(s) for task gate checkpoint: ${missing.join(", ")}`);
    const args = ["checkpoint", "--id", input.id, "--step", input.step];
    if (input.note) args.push("--note", input.note);
    return tagTaskGateResult(action, await runCtl(args));
  }
  if (action === "verify") {
    const missing = missingFields(input, ["id"]);
    if (missing.length) return failure(`Missing required field(s) for task gate verify: ${missing.join(", ")}`);
    const args = ["verify", "--id", input.id, "--status", input.status || "skip"];
    if (input.command) args.push("--command", input.command);
    if (input.exitCode !== undefined) args.push("--exit-code", String(input.exitCode));
    if (input.session) args.push("--session", input.session);
    if (input.turnId) args.push("--turn-id", input.turnId);
    if (input.note) args.push("--note", input.note);
    return tagTaskGateResult(action, await runCtl(args));
  }
  if (action === "finalize") {
    const missing = missingFields(input, ["id"]);
    if (missing.length) return failure(`Missing required field(s) for task gate finalize: ${missing.join(", ")}`);
    return tagTaskGateResult(action, await runCtl(["finalize", "--id", input.id]));
  }
  return failure(`Unsupported task gate action: ${action}`);
}

function missingFields(input, fields) {
  return fields.filter((field) => !String(input[field] || "").trim());
}

function tagTaskGateResult(action, result) {
  if (result.data && typeof result.data === "object" && !Array.isArray(result.data)) {
    return { ...result, data: { action, ...result.data } };
  }
  return result;
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

async function claudeSendTask({ id, prompt, taskId }) {
  const meta = readClaudeMeta(id);
  if (meta.status === "stopped") return failure(`Claude Code session is stopped: ${id}`);
  const turnId = randomUUID();
  const startedAt = new Date().toISOString();
  appendJsonl(meta.events, { ts: startedAt, method: "control/send", provider: "claude-code", id, turnId, prompt, taskId: cleanTaskId(taskId) });
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
    meta.lastTurn = { turnId, taskId: cleanTaskId(taskId), startedAt, finishedAt, ok: false, error: result.error };
    meta.turnCount = (meta.turnCount ?? 0) + 1;
    writeJson(claudeMetaPath(id), meta);
    appendJsonl(meta.events, { ts: finishedAt, method: "control/turn_error", provider: "claude-code", id, turnId, error: result.error });
    return result;
  }

  if (result.data.sessionId) meta.claudeSessionId = result.data.sessionId;
  const turn = {
    turnId,
    taskId: cleanTaskId(taskId),
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

function claudeObserve({ id, tail, mode = "events", maxChars = 12000, since = 0 }) {
  const meta = readClaudeMeta(id);
  const publicMeta = compactClaudeMeta(meta);
  const eventWindow = readJsonlWindow(meta.events, { tail, since });
  const events = eventWindow.events;
  const cursor = {
    since: eventWindow.since,
    cursor: eventWindow.cursor,
    total: eventWindow.total,
    deltaCount: eventWindow.deltaCount
  };
  if (mode === "summary") {
    return success(compactTextFields({
      provider: "claude-code",
      id,
      mode,
      cursor,
      status: publicMeta,
      lastTurn: summarizeClaudeTurn(meta.lastTurn),
      eventCount: events.length,
      warnings: meta.warnings ?? []
    }, maxChars));
  }
  if (mode === "final") {
    return success(compactTextFields({
      provider: "claude-code",
      id,
      mode,
      cursor,
      status: publicMeta,
      final: meta.lastTurn?.assistantText ?? null,
      lastTurn: summarizeClaudeTurn(meta.lastTurn)
    }, maxChars));
  }
  if (mode === "permission") {
    return success({
      provider: "claude-code",
      id,
      mode,
      cursor,
      status: publicMeta,
      pendingPermission: null,
      warnings: [
        "Claude Code does not expose external permission prompts through TaskMarshal."
      ]
    });
  }
  return success(compactTextFields({
    provider: "claude-code",
    id,
    mode,
    cursor,
    status: publicMeta,
    events
  }, maxChars));
}

function claudeSummarizeSession({ id, maxChars = 6000 }) {
  const meta = readClaudeMeta(id);
  const events = readTailJsonl(meta.events, 1000);
  const turns = events
    .filter((event) => event.method === "control/turn_finished" && event.turn)
    .map((event) => event.turn);
  const allTurns = turns.length ? turns : [meta.lastTurn].filter(Boolean);
  const errors = events
    .filter((event) => event.method === "control/turn_error")
    .map((event) => ({ ts: event.ts, error: event.error }))
    .slice(-10);
  const startedAt = meta.startedAt ?? allTurns[0]?.startedAt ?? null;
  const finishedAt = allTurns[allTurns.length - 1]?.finishedAt ?? meta.updatedAt ?? null;
  const elapsedMs = startedAt && finishedAt ? Date.parse(finishedAt) - Date.parse(startedAt) : null;
  const assistantText = allTurns.map((turn) => turn.assistantText || "").filter(Boolean).join("\n\n");
  return success(compactTextFields({
    ok: true,
    provider: "claude-code",
    id,
    generatedAt: new Date().toISOString(),
    status: meta.status,
    dir: meta.dir,
    model: meta.model ?? null,
    budget: meta.budget ?? null,
    claudeSessionId: meta.claudeSessionId ?? null,
    startedAt,
    finishedAt,
    metrics: {
      provider: "claude-code",
      model: meta.model ?? null,
      approveMode: meta.approve ?? null,
      elapsedMs: Number.isFinite(elapsedMs) ? elapsedMs : null,
      turnCount: allTurns.length,
      permissionRequests: null,
      approvals: null,
      denials: null,
      autoPermissions: null,
      errorCount: errors.length,
      promptChars: events
        .filter((event) => event.method === "control/send")
        .reduce((total, event) => total + String(event.prompt || "").length, 0),
      assistantChars: assistantText.length,
      totalCostUsd: allTurns.reduce((total, turn) => total + (Number(turn.totalCostUsd) || 0), 0),
      filesChanged: [],
      verification: "unknown",
      redoCount: 0
    },
    lastTurn: summarizeClaudeTurn(allTurns[allTurns.length - 1]),
    assistantTextPreview: assistantText,
    warnings: meta.warnings ?? [],
    errors
  }, maxChars));
}

function claudeMetricsReport({ limit = 20, model = null, since = null, maxSessions = 200, compact = false }) {
  mkdirSync(CLAUDE_SESSION_DIR, { recursive: true });
  const sinceMs = since ? Date.parse(since) : null;
  const records = readdirSync(CLAUDE_SESSION_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => readJsonLenient(resolve(CLAUDE_SESSION_DIR, entry.name, "session.json")))
    .filter(Boolean)
    .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")))
    .slice(0, maxSessions)
    .flatMap((meta) => claudeMetricRecords(meta))
    .filter((record) => {
      if (model && record.model !== model) return false;
      const tsMs = record.ts ? Date.parse(record.ts) : NaN;
      if (Number.isFinite(sinceMs) && Number.isFinite(tsMs) && tsMs < sinceMs) return false;
      return true;
    })
    .sort((a, b) => String(b.ts || "").localeCompare(String(a.ts || "")));
  const recent = records.slice(0, limit);
  const totals = summarizeMetrics(records);
  const report = {
    generatedAt: new Date().toISOString(),
    source: "claude-code logical session metadata",
    filters: { limit, provider: "claude-code", model, since, maxSessions, compact },
    totals,
    byModel: groupMetrics(records, "model"),
    byProvider: groupMetrics(records, "provider"),
    guidance: buildMetricsGuidance(totals)
  };
  if (compact) {
    report.compact = true;
    report.recentCount = recent.length;
    report.routingHints = buildRoutingHints({ totals, taskVerification: { byStatus: {} } });
    report.recent = recent.slice(0, Math.min(limit, 3)).map(compactMetricRecord);
    return success(report);
  }
  report.recent = recent;
  return success(report);
}

function claudeMetricRecords(meta) {
  const events = readTailJsonl(meta.events, 2000);
  const sends = new Map(
    events
      .filter((event) => event.method === "control/send" && event.turnId)
      .map((event) => [event.turnId, event])
  );
  const turns = events
    .filter((event) => event.method === "control/turn_finished" && event.turn)
    .map((event) => event.turn);
  const errors = events.filter((event) => event.method === "control/turn_error");
  const records = turns.map((turn) => {
    const send = sends.get(turn.turnId);
    const elapsedMs = turn.startedAt && turn.finishedAt ? Date.parse(turn.finishedAt) - Date.parse(turn.startedAt) : null;
    return {
      ts: turn.finishedAt ?? null,
      provider: "claude-code",
      session: meta.id,
      model: meta.model ?? null,
      approveMode: meta.approve ?? null,
      taskId: send?.taskId ?? turn.taskId ?? null,
      ok: true,
      stopReason: turn.stopReason ?? null,
      elapsedMs: Number.isFinite(elapsedMs) ? elapsedMs : null,
      promptChars: String(send?.prompt ?? "").length,
      assistantChars: String(turn.assistantText ?? "").length,
      permissionRequests: 0,
      approvals: 0,
      denials: 0,
      autoPermissions: 0,
      filesChangedCount: 0,
      verification: "unknown",
      redoCount: 0,
      totalCostUsd: Number(turn.totalCostUsd) || 0,
      error: null
    };
  });
  for (const event of errors) {
    const send = sends.get(event.turnId);
    records.push({
      ts: event.ts ?? null,
      provider: "claude-code",
      session: meta.id,
      model: meta.model ?? null,
      approveMode: meta.approve ?? null,
      taskId: send?.taskId ?? null,
      ok: false,
      stopReason: "error",
      elapsedMs: null,
      promptChars: String(send?.prompt ?? "").length,
      assistantChars: 0,
      permissionRequests: 0,
      approvals: 0,
      denials: 0,
      autoPermissions: 0,
      filesChangedCount: 0,
      verification: "unknown",
      redoCount: 0,
      totalCostUsd: 0,
      error: event.error ?? "unknown error"
    });
  }
  if (!records.length && meta.lastTurn) {
    records.push({
      ts: meta.lastTurn.finishedAt ?? meta.updatedAt ?? null,
      provider: "claude-code",
      session: meta.id,
      model: meta.model ?? null,
      approveMode: meta.approve ?? null,
      ok: meta.lastTurn.ok ?? null,
      stopReason: meta.lastTurn.stopReason ?? null,
      elapsedMs: null,
      promptChars: 0,
      assistantChars: String(meta.lastTurn.assistantText ?? "").length,
      permissionRequests: 0,
      approvals: 0,
      denials: 0,
      autoPermissions: 0,
      filesChangedCount: 0,
      verification: "unknown",
      redoCount: 0,
      totalCostUsd: Number(meta.lastTurn.totalCostUsd) || 0,
      error: meta.lastTurn.error ?? null
    });
  }
  return records;
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

function compactClaudeMeta(meta) {
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
    lastTurn: summarizeClaudeTurn(meta.lastTurn),
    warnings: meta.warnings ?? []
  };
}

function summarizeClaudeTurn(turn) {
  if (!turn || typeof turn !== "object") return turn ?? null;
  return {
    turnId: turn.turnId,
    startedAt: turn.startedAt,
    finishedAt: turn.finishedAt,
    ok: turn.ok,
    stopReason: turn.stopReason,
    sessionId: turn.sessionId,
    totalCostUsd: turn.totalCostUsd,
    error: turn.error
  };
}

function proReviewReason(risk) {
  if (risk === "high") return "Use pro for high-risk review, architecture decisions, security-sensitive changes, tricky debugging, or final verification.";
  if (risk === "medium") return "Use pro when a flash result is uncertain or the review can prevent expensive rework.";
  return "Low-risk work usually stays on flash or Local mode; use pro only if the user explicitly wants a stronger second pass.";
}

function buildProReviewPrompt({ goal, risk, scope, acceptance, verification }) {
  return `You are the second-pass reviewer. Codex is the architect and final decision maker.

Goal:
${goal}

Risk:
${risk}

Scope:
${scope || "Review only the files, diffs, or decisions Codex provides. Do not expand scope without saying why."}

Rules:
- Read-only review unless Codex explicitly asks for edits.
- Focus on correctness, architecture risk, missed edge cases, security, data loss, regressions, and missing tests.
- Do not approve the work just because it looks plausible.
- Return findings first, ordered by severity, with file or command references when available.
- Keep the response concise and actionable.

Acceptance criteria:
${acceptance || "Identify blocking issues, non-blocking risks, and whether the work is acceptable after Codex verification."}

Verification to consider:
${verification || "Use the verification evidence Codex provides; suggest focused additional checks only when needed."}
`;
}

async function runCtl(args, { cwd } = {}) {
  if (!existsSync(CTL)) throw new Error(`taskmarshalctl.js not found: ${CTL}`);
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
      result.error = run.stderr.trim() || run.stdout.trim() || `taskmarshalctl exited with code ${run.exitCode}`;
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

function cleanTaskId(value) {
  const id = String(value ?? "").trim();
  return /^[A-Za-z0-9_.-]+$/.test(id) ? id : null;
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
    guidance.push("No metrics found yet. Run persistent worker sessions and summarize them before tuning routing.");
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
  const failCount = taskVerification.byStatus?.fail || 0;
  const passCount = taskVerification.byStatus?.pass || 0;
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

function sumBy(items, key) {
  return items.reduce((total, item) => {
    const value = Number(item?.[key]);
    return Number.isFinite(value) ? total + value : total;
  }, 0);
}

function round(value, digits) {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
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

function toolResult(result) {
  const structuredContent = sanitizeRunResult(result);
  return {
    content: [
      {
        type: "text",
        text: COMPACT_TOOL_TEXT ? compactToolText(structuredContent) : JSON.stringify(structuredContent, null, 2)
      }
    ],
    structuredContent,
    isError: !structuredContent.ok
  };
}

function compactToolText(result) {
  const data = result.data ?? {};
  if (!result.ok) return `error ${result.error || "unknown"}`;
  const parts = ["ok"];
  for (const key of ["action", "route", "taskId", "next", "status", "verification", "done", "taskKey"]) {
    if (data[key] !== undefined && data[key] !== null) parts.push(`${key}=${data[key]}`);
  }
  if (data.reasonCodes?.length) parts.push(`reasons=${data.reasonCodes.join(",")}`);
  return parts.join(" ");
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

function truthyEnv(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
}

function normalizeToolProfile(value) {
  const profile = String(value || "standard").trim().toLowerCase();
  if (profile === "admin") return "full";
  if (["minimal", "standard", "full"].includes(profile)) return profile;
  return "standard";
}

function toolEnabled(name) {
  if (TOOL_PROFILE === "full" || TOOL_PROFILE === "standard") return true;
  const minimal = new Set([
    "worker_doctor",
    "worker_start_session",
    "worker_send_task",
    "worker_observe",
    "worker_metrics_report",
    "worker_task_gate",
    "worker_approve",
    "worker_deny",
    "worker_stop"
  ]);
  return minimal.has(name);
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

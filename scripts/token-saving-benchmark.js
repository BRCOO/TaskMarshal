#!/usr/bin/env node
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const SESSION_ID = "tm-token-benchmark";
const SESSION_DIR = resolve(homedir(), ".reasonixctl", "sessions", SESSION_ID);
const APPROX_CHARS_PER_TOKEN = 4;
const BUDGETS = {
  minimalToolListChars: 10500,
  observeSummaryStructuredChars: 900,
  observeFinalStructuredChars: 800,
  compactMetricsStructuredChars: 3600
};
process.on("exit", cleanupSyntheticReasonixSession);

createSyntheticReasonixSession(SESSION_ID);

const standard = await withMcp({}, async (client) => {
  const tools = await client.listTools();
  return {
    toolCount: tools.tools.length,
    toolList: measure(tools)
  };
});

const minimal = await withMcp({
  TASKMARSHAL_TOOL_PROFILE: "minimal",
  TASKMARSHAL_COMPACT_TOOL_TEXT: "1"
}, async (client) => {
  const tools = await client.listTools();
  return {
    toolCount: tools.tools.length,
    toolList: measure(tools)
  };
});

const observe = await withMcp({
  TASKMARSHAL_TOOL_PROFILE: "minimal",
  TASKMARSHAL_COMPACT_TOOL_TEXT: "1"
}, async (client) => {
  const events = await client.callTool({
    name: "worker_observe",
    arguments: { provider: "reasonix", id: SESSION_ID, mode: "events", tail: 80, maxChars: 50000 }
  });
  const summary = await client.callTool({
    name: "worker_observe",
    arguments: { provider: "reasonix", id: SESSION_ID, mode: "summary", tail: 80, maxChars: 4000 }
  });
  const final = await client.callTool({
    name: "worker_observe",
    arguments: { provider: "reasonix", id: SESSION_ID, mode: "final", tail: 80, maxChars: 2000 }
  });
  return {
    events: measureToolResult(events),
    summary: measureToolResult(summary),
    final: measureToolResult(final)
  };
});

const metrics = await withMcp({
  TASKMARSHAL_TOOL_PROFILE: "minimal",
  TASKMARSHAL_COMPACT_TOOL_TEXT: "1"
}, async (client) => {
  const normal = await client.callTool({
    name: "worker_metrics_report",
    arguments: { provider: "reasonix", limit: 50, maxSessions: 50, compact: false }
  });
  const compact = await client.callTool({
    name: "worker_metrics_report",
    arguments: { provider: "reasonix", limit: 50, maxSessions: 50, compact: true }
  });
  return {
    normal: measureToolResult(normal),
    compact: measureToolResult(compact)
  };
});

cleanupSyntheticReasonixSession();

const comparisons = {
  toolListChars: compareChars(standard.toolList.chars, minimal.toolList.chars),
  toolCount: compareCount(standard.toolCount, minimal.toolCount),
  observeSummaryChars: compareChars(observe.events.structuredChars, observe.summary.structuredChars),
  observeFinalChars: compareChars(observe.events.structuredChars, observe.final.structuredChars),
  metricsCompactChars: compareChars(metrics.normal.structuredChars, metrics.compact.structuredChars)
};

const ok = comparisons.toolListChars.savedChars > 0
  && comparisons.toolCount.saved > 0
  && comparisons.observeSummaryChars.savedChars > 0
  && comparisons.observeFinalChars.savedChars > 0
  && comparisons.metricsCompactChars.savedChars > 0
  && withinBudgets();

console.log(JSON.stringify({
  ok,
  generatedAt: new Date().toISOString(),
  note: `approxTokens uses ${APPROX_CHARS_PER_TOKEN} chars/token; compare chars for exact regression tracking.`,
  budgets: budgetReport(),
  benchmark: {
    tools: {
      standard,
      minimal,
      savings: {
        count: comparisons.toolCount,
        text: comparisons.toolListChars
      }
    },
    observe,
    metrics
  },
  comparisons
}, null, 2));

if (!ok) process.exitCode = 1;

async function withMcp(extraEnv, fn) {
  const client = new Client({ name: "taskmarshal-token-benchmark", version: "0.1.0" }, { capabilities: {} });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["mcp-server.js"],
    cwd: process.cwd(),
    env: { ...process.env, ...extraEnv },
    stderr: "pipe"
  });
  await client.connect(transport);
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

function measureToolResult(result) {
  return {
    text: measure(result.content?.map((entry) => entry.text || "").join("\n") || ""),
    structured: measure(result.structuredContent ?? null),
    total: measure(result),
    textChars: measure(result.content?.map((entry) => entry.text || "").join("\n") || "").chars,
    structuredChars: measure(result.structuredContent ?? null).chars,
    totalChars: measure(result).chars
  };
}

function measure(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return {
    chars: text.length,
    approxTokens: Math.ceil(text.length / APPROX_CHARS_PER_TOKEN)
  };
}

function compareChars(before, after) {
  const savedChars = before - after;
  return {
    before,
    after,
    savedChars,
    savedPct: before > 0 ? round(savedChars / before, 4) : null,
    approxTokensSaved: Math.ceil(savedChars / APPROX_CHARS_PER_TOKEN)
  };
}

function compareCount(before, after) {
  const saved = before - after;
  return {
    before,
    after,
    saved,
    savedPct: before > 0 ? round(saved / before, 4) : null
  };
}

function withinBudgets() {
  return minimal.toolList.chars <= BUDGETS.minimalToolListChars
    && observe.summary.structuredChars <= BUDGETS.observeSummaryStructuredChars
    && observe.final.structuredChars <= BUDGETS.observeFinalStructuredChars
    && metrics.compact.structuredChars <= BUDGETS.compactMetricsStructuredChars;
}

function budgetReport() {
  return {
    minimalToolListChars: budgetItem(minimal.toolList.chars, BUDGETS.minimalToolListChars),
    observeSummaryStructuredChars: budgetItem(observe.summary.structuredChars, BUDGETS.observeSummaryStructuredChars),
    observeFinalStructuredChars: budgetItem(observe.final.structuredChars, BUDGETS.observeFinalStructuredChars),
    compactMetricsStructuredChars: budgetItem(metrics.compact.structuredChars, BUDGETS.compactMetricsStructuredChars)
  };
}

function budgetItem(actual, max) {
  return {
    actual,
    max,
    ok: actual <= max,
    headroomChars: max - actual
  };
}

function round(value, digits) {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function createSyntheticReasonixSession(id) {
  cleanupSyntheticReasonixSession();
  mkdirSync(SESSION_DIR, { recursive: true });
  const now = new Date().toISOString();
  const eventsPath = resolve(SESSION_DIR, "events.jsonl");
  const metricsPath = resolve(SESSION_DIR, "metrics.jsonl");
  const transcriptPath = resolve(SESSION_DIR, "transcript.jsonl");
  const longOutput = [
    "changedFiles:",
    "- src/provider-a.ts: adjusted provider dispatch behavior",
    "- src/provider-b.ts: added compact observation handoff",
    "commands:",
    "- npm run check: pass",
    "- npm run eval: pass",
    "verification:",
    "- Synthetic benchmark output used for token-size regression measurement.",
    "risks:",
    "- None for benchmark fixture.",
    "next:",
    "- Compare compact paths before accepting token-related changes.",
    "",
    "details:",
    "x".repeat(9000)
  ].join("\n");
  const compactOutput = [
    "changedFiles: benchmark fixture only",
    "commands: npm run check pass; npm run eval pass",
    "verification: synthetic pass",
    "risks: none",
    "next: compare compact paths"
  ].join("\n");

  const events = [
    { ts: now, method: "control/start", id, provider: "reasonix" },
    { ts: now, method: "control/send", turnId: "bench-turn-1", text: "benchmark synthetic task" },
    ...chunkText(longOutput, 700).map((text) => ({ ts: now, type: "agent_message_chunk", text })),
    { ts: now, method: "session/request_permission", params: { toolCall: { kind: "read", command: "Get-Content README.md" }, options: [{ kind: "allow_once", optionId: "once" }] } },
    { ts: now, method: "control/permission_auto", mode: "cancel", selected: false },
    {
      ts: now,
      method: "control/turn_finished",
      turnId: "bench-turn-1",
      stopReason: "end_turn",
      turn: {
        turnId: "bench-turn-1",
        startedAt: now,
        finishedAt: now,
        stopReason: "end_turn",
        promptChars: 24,
        assistantText: compactOutput,
        assistantRawChars: longOutput.length,
        outputContract: {
          enabled: true,
          maxChars: 1200,
          fields: ["changedFiles", "commands", "verification", "risks", "next"],
          injected: true,
          rawChars: longOutput.length,
          finalChars: compactOutput.length,
          truncated: true
        }
      }
    }
  ];
  writeFileSync(eventsPath, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");
  writeFileSync(transcriptPath, "", "utf8");
  writeFileSync(resolve(SESSION_DIR, "session.json"), `${JSON.stringify({
    id,
    status: "ready",
    busy: false,
    pid: null,
    port: null,
    token: null,
    dir: process.cwd(),
    approve: "manual",
    model: "deepseek-v4-flash",
    sessionId: "synthetic-token-benchmark",
    transcript: transcriptPath,
    events: eventsPath,
    metrics: metricsPath,
    lastTurn: events.at(-1).turn,
    turnCount: 1,
    errors: [],
    updatedAt: now
  }, null, 2)}\n`, "utf8");

  const metrics = Array.from({ length: 40 }, (_, index) => ({
    ts: new Date(Date.now() - index * 1000).toISOString(),
    provider: "reasonix",
    session: id,
    model: index % 9 === 0 ? "deepseek-v4-pro" : "deepseek-v4-flash",
    turnId: `bench-turn-${index}`,
    taskId: `bench-task-${index}`,
    ok: true,
    stopReason: "end_turn",
    elapsedMs: 1000 + index,
    promptChars: 500 + index,
    workerPromptChars: 650 + index,
    assistantChars: 900 + index,
    assistantRawChars: 7000 + index * 20,
    outputContractApplied: true,
    outputContractTruncated: true,
    outputContractMaxChars: 1200,
    permissionRequests: index % 5 === 0 ? 1 : 0,
    approvals: 0,
    denials: 0,
    autoPermissions: index % 5 === 0 ? 1 : 0,
    filesChanged: ["src/a.ts", "src/b.ts", "tests/a.test.ts"].slice(0, (index % 3) + 1),
    verification: index % 4 === 0 ? "pass" : "unknown",
    redoCount: index % 7 === 0 ? 1 : 0,
    error: null
  }));
  writeFileSync(metricsPath, `${metrics.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");
}

function cleanupSyntheticReasonixSession() {
  if (existsSync(SESSION_DIR)) rmSync(SESSION_DIR, { recursive: true, force: true });
}

function chunkText(text, size) {
  const chunks = [];
  for (let i = 0; i < text.length; i += size) chunks.push(text.slice(i, i + size));
  return chunks;
}

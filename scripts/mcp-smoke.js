#!/usr/bin/env node
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const hideLegacy = process.argv.includes("--hide-legacy");
const profileArg = process.argv.find((arg) => arg.startsWith("--profile="));
const profile = profileArg ? profileArg.split("=")[1] : null;
const ultraMinimalProfile = ["ultra-minimal", "ultra", "tiny", "lean"].includes(String(profile || "").toLowerCase());
const minimalLikeProfile = profile === "minimal" || ultraMinimalProfile;
const compactText = process.argv.includes("--compact-text");
const client = new Client({ name: "taskmarshal-smoke", version: "0.1.0" }, { capabilities: {} });
const env = {
  ...process.env,
  ...(hideLegacy ? { TASKMARSHAL_HIDE_LEGACY_REASONIX_TOOLS: "1" } : {}),
  ...(profile ? { TASKMARSHAL_TOOL_PROFILE: profile } : {}),
  ...(compactText ? { TASKMARSHAL_COMPACT_TOOL_TEXT: "1" } : {})
};
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["mcp-server.js"],
  cwd: process.cwd(),
  env,
  stderr: "pipe"
});

await client.connect(transport);
const tools = await client.listTools();
const providers = ultraMinimalProfile ? null : await client.callTool({ name: "worker_list_providers", arguments: {} });
const metricsReport = ultraMinimalProfile ? null : await client.callTool({
  name: "worker_metrics_report",
  arguments: {
    provider: "reasonix",
    limit: 3
  }
});
const compactMetricsReport = ultraMinimalProfile ? null : await client.callTool({
  name: "worker_metrics_report",
  arguments: {
    provider: "reasonix",
    limit: 8,
    compact: true
  }
});
const routeDecision = await client.callTool({
  name: "worker_task_gate",
  arguments: {
    action: "route",
    goal: "Smoke-test token firewall.",
    scope: "taskmarshalctl.js,mcp-server.js",
    risk: "low",
    files: 2
  }
});
const contextQuery = await client.callTool({
  name: "worker_context_query",
  arguments: {
    goal: "Smoke-test compact context query.",
    scope: "mcp-server.js,taskmarshalctl.js",
    maxChars: 1200
  }
});
const taskCreate = await client.callTool({
  name: "worker_task_gate",
  arguments: {
    action: "create",
    id: "tm-smoke-token-firewall",
    goal: "Smoke-test token firewall.",
    scope: "taskmarshalctl.js,mcp-server.js",
    risk: "low",
    route: "flash",
    steps: "plan;verify"
  }
});
const proReviewPlan = minimalLikeProfile ? null : await client.callTool({
  name: "worker_plan_pro_review",
  arguments: {
    goal: "Smoke-test pro review planning.",
    risk: "high"
  }
});
const hasWorkerSendTask = tools.tools.some((tool) => tool.name === "worker_send_task");
const hasWorkerSummarizeSession = tools.tools.some((tool) => tool.name === "worker_summarize_session");
const hasWorkerMetricsReport = tools.tools.some((tool) => tool.name === "worker_metrics_report");
const hasWorkerContextQuery = tools.tools.some((tool) => tool.name === "worker_context_query");
const hasWorkerTaskGate = tools.tools.some((tool) => tool.name === "worker_task_gate");
const hasWorkerRouteDecision = tools.tools.some((tool) => tool.name === "worker_route_decision");
const hasWorkerCreateTask = tools.tools.some((tool) => tool.name === "worker_create_task");
const hasWorkerCheckpointStep = tools.tools.some((tool) => tool.name === "worker_checkpoint_step");
const hasWorkerRecordVerification = tools.tools.some((tool) => tool.name === "worker_record_verification");
const hasWorkerFinalizeTask = tools.tools.some((tool) => tool.name === "worker_finalize_task");
const hasWorkerPlanProReview = tools.tools.some((tool) => tool.name === "worker_plan_pro_review");
const hasReasonixAlias = tools.tools.some((tool) => tool.name === "reasonix_send_task");
const hasReasonixSummarizeAlias = tools.tools.some((tool) => tool.name === "reasonix_summarize_session");
const hasReasonixMetricsAlias = tools.tools.some((tool) => tool.name === "reasonix_metrics_report");
const providerIds = providers?.structuredContent?.data?.providers?.map((provider) => provider.id) ?? [];
const reasonix = providers?.structuredContent?.data?.providers?.find((provider) => provider.id === "reasonix");
const reasonixModels = reasonix?.models?.map((model) => model.id) ?? [];
const metricsData = metricsReport?.structuredContent?.data;
const hasUsableMetricsReport = ultraMinimalProfile || (Boolean(metricsData?.totals)
  && Array.isArray(metricsData?.recent)
  && Array.isArray(metricsData?.guidance));
const routeData = routeDecision.structuredContent?.data;
const contextData = contextQuery.structuredContent?.data;
const contextBackends = ["codegraph", "local-static"];
const hasUsableRouteDecision = ["local", "flash", "pro"].includes(routeData?.route)
  && Array.isArray(routeData?.reasonCodes)
  && routeData?.metricsEvidence?.source === "compact_metrics";
const hasUsableContextQuery = contextBackends.includes(contextData?.backend)
  && Array.isArray(contextData?.relevantFiles)
  && contextData.relevantFiles.length > 0
  && JSON.stringify(contextData).length <= 1400;
const taskData = taskCreate.structuredContent?.data;
const taskId = taskData?.taskId;
const checkpointOne = taskId ? await client.callTool({
  name: "worker_task_gate",
  arguments: {
    action: "checkpoint",
    id: taskId,
    step: "s1",
    note: "smoke"
  }
}) : null;
const checkpointTwo = taskId ? await client.callTool({
  name: "worker_task_gate",
  arguments: {
    action: "checkpoint",
    id: taskId,
    step: "s2",
    note: "smoke"
  }
}) : null;
const verifyResult = taskId ? await client.callTool({
  name: "worker_task_gate",
  arguments: {
    action: "verify",
    id: taskId,
    status: "pass",
    command: "smoke"
  }
}) : null;
const finalizeResult = taskId ? await client.callTool({
  name: "worker_task_gate",
  arguments: { action: "finalize", id: taskId }
}) : null;
const batchCreate = await client.callTool({
  name: "worker_task_gate",
  arguments: {
    batch: [
      {
        action: "create",
        id: "tm-smoke-batch-task-gate",
        goal: "Smoke-test batch task gate.",
        scope: "taskmarshalctl.js",
        risk: "low",
        route: "flash",
        steps: "plan;verify"
      }
    ]
  }
});
const batchTaskId = batchCreate.structuredContent?.data?.results?.[0]?.data?.taskId;
const batchFinalize = batchTaskId ? await client.callTool({
  name: "worker_task_gate",
  arguments: {
    batch: [
      { action: "checkpoint", id: batchTaskId, step: "s1", note: "batch smoke" },
      { action: "checkpoint", id: batchTaskId, step: "s2", note: "batch smoke" },
      { action: "verify", id: batchTaskId, status: "pass", command: "batch-smoke" },
      { action: "finalize", id: batchTaskId }
    ]
  }
}) : null;
const readonlyCreate = await client.callTool({
  name: "worker_task_gate",
  arguments: {
    action: "create",
    id: "tm-smoke-readonly-close",
    goal: "Smoke-test read-only close helper.",
    scope: "taskmarshalctl.js",
    risk: "low",
    route: "flash",
    steps: "inspect;report"
  }
});
const readonlyTaskId = readonlyCreate.structuredContent?.data?.taskId;
const closeReadonly = readonlyTaskId ? await client.callTool({
  name: "worker_task_gate",
  arguments: {
    action: "close-readonly",
    id: readonlyTaskId,
    status: "pass",
    command: "read-only smoke",
    note: "smoke"
  }
}) : null;
const verifiedCreate = await client.callTool({
  name: "worker_task_gate",
  arguments: {
    action: "create",
    id: "tm-smoke-close-verified",
    goal: "Smoke-test verified close helper.",
    scope: "taskmarshalctl.js",
    risk: "low",
    route: "flash",
    steps: "inspect;verify"
  }
});
const verifiedTaskId = verifiedCreate.structuredContent?.data?.taskId;
if (verifiedTaskId) {
  await client.callTool({
    name: "worker_task_gate",
    arguments: {
      action: "verify",
      id: verifiedTaskId,
      status: "pass",
      command: "verified smoke"
    }
  });
}
const closeVerified = verifiedTaskId ? await client.callTool({
  name: "worker_task_gate",
  arguments: {
    action: "close-verified",
    id: verifiedTaskId,
    note: "smoke"
  }
}) : null;
const taskReport = await client.callTool({
  name: "worker_task_gate",
  arguments: { action: "tasks" }
});
const verifyData = verifyResult?.structuredContent?.data;
const checkpointData = checkpointTwo?.structuredContent?.data;
const finalizeData = finalizeResult?.structuredContent?.data;
const compactMetricsData = compactMetricsReport?.structuredContent?.data;
const batchFinalizeData = batchFinalize?.structuredContent?.data;
const closeReadonlyData = closeReadonly?.structuredContent?.data;
const closeVerifiedData = closeVerified?.structuredContent?.data;
const taskReportData = taskReport?.structuredContent?.data;
const hasUsableTaskGate = Boolean(taskId)
  && taskData?.artifactRoot
  && checkpointData?.completed === 2
  && verifyData?.verification === "pass"
  && finalizeData?.done === true
  && typeof finalizeData?.taskKey === "string";
const hasUsableBatchGate = batchCreate.structuredContent?.data?.action === "batch"
  && batchFinalizeData?.action === "batch"
  && batchFinalizeData?.ok === true
  && batchFinalizeData?.results?.at(-1)?.data?.done === true;
const hasUsableCloseReadonly = closeReadonlyData?.action === "close-readonly"
  && closeReadonlyData?.done === true
  && closeReadonlyData?.completed === closeReadonlyData?.totalSteps
  && typeof closeReadonlyData?.taskKey === "string";
const hasUsableCloseVerified = closeVerifiedData?.action === "close-verified"
  && closeVerifiedData?.done === true
  && closeVerifiedData?.completed === closeVerifiedData?.totalSteps
  && typeof closeVerifiedData?.taskKey === "string";
const hasUsableTaskReport = taskReportData?.action === "tasks"
  && taskReportData?.compact === true
  && Number.isInteger(taskReportData?.totals?.taskCount)
  && Number.isInteger(taskReportData?.totals?.openOrBlockedCount)
  && Array.isArray(taskReportData?.guidance)
  && Array.isArray(taskReportData?.recent)
  && taskReportData.recent.length <= 3;
const hasUsableCompactMetrics = ultraMinimalProfile || (compactMetricsData?.compact === true
  && Array.isArray(compactMetricsData?.routingHints)
  && compactMetricsData?.recent?.length <= 3
  && compactMetricsData?.metricsScan?.perSessionMetricLimit <= 50
  && compactMetricsData?.taskVerification?.recent === undefined);
const proReviewData = proReviewPlan?.structuredContent?.data;
const compactTextOk = !compactText || routeDecision.content?.[0]?.text?.startsWith("ok ");
const observeTool = tools.tools.find((tool) => tool.name === "worker_observe");
const observeDefaultsToSummary = observeTool?.inputSchema?.properties?.mode?.default === "summary";
const hasUsableProReviewPlan = proReviewData?.provider === "reasonix"
  && proReviewData?.model === "deepseek-v4-pro"
  && proReviewData?.startSession?.model === "pro"
  && typeof proReviewData?.prompt === "string"
  && proReviewData.prompt.includes("second-pass reviewer");
const expectsLegacyHidden = hideLegacy || minimalLikeProfile;

const ok = hasWorkerSendTask
    && (minimalLikeProfile || hasWorkerSummarizeSession)
    && (ultraMinimalProfile ? !hasWorkerMetricsReport : hasWorkerMetricsReport)
    && hasWorkerContextQuery
    && hasUsableMetricsReport
    && hasUsableContextQuery
    && hasUsableCompactMetrics
    && hasWorkerTaskGate
    && hasUsableRouteDecision
    && (minimalLikeProfile || hasWorkerRouteDecision)
    && (minimalLikeProfile || hasWorkerCreateTask)
    && (minimalLikeProfile || hasWorkerCheckpointStep)
    && (minimalLikeProfile || hasWorkerRecordVerification)
    && (minimalLikeProfile || hasWorkerFinalizeTask)
    && hasUsableTaskGate
    && hasUsableBatchGate
    && hasUsableCloseReadonly
    && hasUsableCloseVerified
    && hasUsableTaskReport
    && (minimalLikeProfile || hasWorkerPlanProReview)
    && (minimalLikeProfile || hasUsableProReviewPlan)
    && compactTextOk
    && observeDefaultsToSummary
    && (!expectsLegacyHidden || !hasReasonixAlias)
    && (!expectsLegacyHidden || !hasReasonixSummarizeAlias)
    && (!expectsLegacyHidden || !hasReasonixMetricsAlias)
    && (expectsLegacyHidden || hasReasonixAlias)
    && (expectsLegacyHidden || hasReasonixSummarizeAlias)
    && (expectsLegacyHidden || hasReasonixMetricsAlias)
    && (ultraMinimalProfile || providerIds.includes("reasonix"))
    && (ultraMinimalProfile || providerIds.includes("claude-code"))
    && (ultraMinimalProfile || reasonixModels.includes("deepseek-v4-flash"))
    && (ultraMinimalProfile || reasonixModels.includes("deepseek-v4-pro"));

console.log(JSON.stringify({
  ok,
  toolCount: tools.tools.length,
  hideLegacy,
  expectsLegacyHidden,
  profile,
  ultraMinimalProfile,
  compactText,
  compactTextOk,
  observeDefaultsToSummary,
  hasWorkerSendTask,
  hasWorkerSummarizeSession,
  hasWorkerMetricsReport,
  hasWorkerContextQuery,
  contextBackend: contextData?.backend ?? null,
  hasUsableMetricsReport,
  hasUsableContextQuery,
  hasUsableCompactMetrics,
  hasWorkerTaskGate,
  hasWorkerRouteDecision,
  hasUsableRouteDecision,
  hasWorkerCreateTask,
  hasWorkerCheckpointStep,
  hasWorkerRecordVerification,
  hasWorkerFinalizeTask,
  hasUsableTaskGate,
  hasUsableBatchGate,
  hasUsableCloseReadonly,
  hasUsableCloseVerified,
  hasUsableTaskReport,
  hasWorkerPlanProReview,
  hasUsableProReviewPlan,
  hasReasonixAlias,
  hasReasonixSummarizeAlias,
  hasReasonixMetricsAlias,
  providers: providerIds,
  reasonixModels
}, null, 2));

await client.close();
if (!ok) process.exitCode = 1;

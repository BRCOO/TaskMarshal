#!/usr/bin/env node
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const hideLegacy = process.argv.includes("--hide-legacy");
const client = new Client({ name: "taskmarshal-smoke", version: "0.1.0" }, { capabilities: {} });
const env = hideLegacy
  ? { ...process.env, TASKMARSHAL_HIDE_LEGACY_REASONIX_TOOLS: "1" }
  : process.env;
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["mcp-server.js"],
  cwd: process.cwd(),
  env,
  stderr: "pipe"
});

await client.connect(transport);
const tools = await client.listTools();
const providers = await client.callTool({ name: "worker_list_providers", arguments: {} });
const metricsReport = await client.callTool({
  name: "worker_metrics_report",
  arguments: {
    provider: "reasonix",
    limit: 3
  }
});
const routeDecision = await client.callTool({
  name: "worker_route_decision",
  arguments: {
    goal: "Smoke-test token firewall.",
    scope: "taskmarshalctl.js,mcp-server.js",
    risk: "low",
    files: 2
  }
});
const taskCreate = await client.callTool({
  name: "worker_create_task",
  arguments: {
    goal: "Smoke-test token firewall.",
    scope: "taskmarshalctl.js,mcp-server.js",
    risk: "low",
    route: "flash",
    steps: "plan;verify"
  }
});
const proReviewPlan = await client.callTool({
  name: "worker_plan_pro_review",
  arguments: {
    goal: "Smoke-test pro review planning.",
    risk: "high"
  }
});
const hasWorkerSendTask = tools.tools.some((tool) => tool.name === "worker_send_task");
const hasWorkerSummarizeSession = tools.tools.some((tool) => tool.name === "worker_summarize_session");
const hasWorkerMetricsReport = tools.tools.some((tool) => tool.name === "worker_metrics_report");
const hasWorkerRouteDecision = tools.tools.some((tool) => tool.name === "worker_route_decision");
const hasWorkerCreateTask = tools.tools.some((tool) => tool.name === "worker_create_task");
const hasWorkerCheckpointStep = tools.tools.some((tool) => tool.name === "worker_checkpoint_step");
const hasWorkerRecordVerification = tools.tools.some((tool) => tool.name === "worker_record_verification");
const hasWorkerFinalizeTask = tools.tools.some((tool) => tool.name === "worker_finalize_task");
const hasWorkerPlanProReview = tools.tools.some((tool) => tool.name === "worker_plan_pro_review");
const hasReasonixAlias = tools.tools.some((tool) => tool.name === "reasonix_send_task");
const hasReasonixSummarizeAlias = tools.tools.some((tool) => tool.name === "reasonix_summarize_session");
const hasReasonixMetricsAlias = tools.tools.some((tool) => tool.name === "reasonix_metrics_report");
const providerIds = providers.structuredContent?.data?.providers?.map((provider) => provider.id) ?? [];
const reasonix = providers.structuredContent?.data?.providers?.find((provider) => provider.id === "reasonix");
const reasonixModels = reasonix?.models?.map((model) => model.id) ?? [];
const metricsData = metricsReport.structuredContent?.data;
const hasUsableMetricsReport = Boolean(metricsData?.totals)
  && Array.isArray(metricsData?.recent)
  && Array.isArray(metricsData?.guidance);
const routeData = routeDecision.structuredContent?.data;
const hasUsableRouteDecision = ["local", "flash", "pro"].includes(routeData?.route)
  && Array.isArray(routeData?.reasonCodes);
const taskData = taskCreate.structuredContent?.data;
const taskId = taskData?.taskId;
const checkpointOne = taskId ? await client.callTool({
  name: "worker_checkpoint_step",
  arguments: {
    id: taskId,
    step: "s1",
    note: "smoke"
  }
}) : null;
const checkpointTwo = taskId ? await client.callTool({
  name: "worker_checkpoint_step",
  arguments: {
    id: taskId,
    step: "s2",
    note: "smoke"
  }
}) : null;
const verifyResult = taskId ? await client.callTool({
  name: "worker_record_verification",
  arguments: {
    id: taskId,
    status: "pass",
    command: "smoke"
  }
}) : null;
const finalizeResult = taskId ? await client.callTool({
  name: "worker_finalize_task",
  arguments: { id: taskId }
}) : null;
const verifyData = verifyResult?.structuredContent?.data;
const checkpointData = checkpointTwo?.structuredContent?.data;
const finalizeData = finalizeResult?.structuredContent?.data;
const hasUsableTaskGate = Boolean(taskId)
  && taskData?.artifactRoot
  && checkpointData?.completed === 2
  && verifyData?.verification === "pass"
  && finalizeData?.done === true
  && typeof finalizeData?.taskKey === "string";
const proReviewData = proReviewPlan.structuredContent?.data;
const hasUsableProReviewPlan = proReviewData?.provider === "reasonix"
  && proReviewData?.model === "deepseek-v4-pro"
  && proReviewData?.startSession?.model === "pro"
  && typeof proReviewData?.prompt === "string"
  && proReviewData.prompt.includes("second-pass reviewer");

const ok = hasWorkerSendTask
    && hasWorkerSummarizeSession
    && hasWorkerMetricsReport
    && hasUsableMetricsReport
    && hasWorkerRouteDecision
    && hasUsableRouteDecision
    && hasWorkerCreateTask
    && hasWorkerCheckpointStep
    && hasWorkerRecordVerification
    && hasWorkerFinalizeTask
    && hasUsableTaskGate
    && hasWorkerPlanProReview
    && hasUsableProReviewPlan
    && (!hideLegacy || !hasReasonixAlias)
    && (!hideLegacy || !hasReasonixSummarizeAlias)
    && (!hideLegacy || !hasReasonixMetricsAlias)
    && (hideLegacy || hasReasonixAlias)
    && (hideLegacy || hasReasonixSummarizeAlias)
    && (hideLegacy || hasReasonixMetricsAlias)
    && providerIds.includes("reasonix")
    && providerIds.includes("claude-code")
    && reasonixModels.includes("deepseek-v4-flash")
    && reasonixModels.includes("deepseek-v4-pro");

console.log(JSON.stringify({
  ok,
  toolCount: tools.tools.length,
  hideLegacy,
  hasWorkerSendTask,
  hasWorkerSummarizeSession,
  hasWorkerMetricsReport,
  hasUsableMetricsReport,
  hasWorkerRouteDecision,
  hasUsableRouteDecision,
  hasWorkerCreateTask,
  hasWorkerCheckpointStep,
  hasWorkerRecordVerification,
  hasWorkerFinalizeTask,
  hasUsableTaskGate,
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

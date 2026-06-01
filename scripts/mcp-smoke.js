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
const proReviewPlan = await client.callTool({
  name: "worker_plan_pro_review",
  arguments: {
    goal: "Smoke-test pro review planning.",
    risk: "high"
  }
});
const hasWorkerSendTask = tools.tools.some((tool) => tool.name === "worker_send_task");
const hasWorkerSummarizeSession = tools.tools.some((tool) => tool.name === "worker_summarize_session");
const hasWorkerPlanProReview = tools.tools.some((tool) => tool.name === "worker_plan_pro_review");
const hasReasonixAlias = tools.tools.some((tool) => tool.name === "reasonix_send_task");
const hasReasonixSummarizeAlias = tools.tools.some((tool) => tool.name === "reasonix_summarize_session");
const providerIds = providers.structuredContent?.data?.providers?.map((provider) => provider.id) ?? [];
const reasonix = providers.structuredContent?.data?.providers?.find((provider) => provider.id === "reasonix");
const reasonixModels = reasonix?.models?.map((model) => model.id) ?? [];
const proReviewData = proReviewPlan.structuredContent?.data;
const hasUsableProReviewPlan = proReviewData?.provider === "reasonix"
  && proReviewData?.model === "deepseek-v4-pro"
  && proReviewData?.startSession?.model === "pro"
  && typeof proReviewData?.prompt === "string"
  && proReviewData.prompt.includes("second-pass reviewer");

const ok = hasWorkerSendTask
    && hasWorkerSummarizeSession
    && hasWorkerPlanProReview
    && hasUsableProReviewPlan
    && (!hideLegacy || !hasReasonixAlias)
    && (!hideLegacy || !hasReasonixSummarizeAlias)
    && (hideLegacy || hasReasonixAlias)
    && (hideLegacy || hasReasonixSummarizeAlias)
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
  hasWorkerPlanProReview,
  hasUsableProReviewPlan,
  hasReasonixAlias,
  hasReasonixSummarizeAlias,
  providers: providerIds,
  reasonixModels
}, null, 2));

await client.close();
if (!ok) process.exitCode = 1;

#!/usr/bin/env node
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const client = new Client({ name: "taskmarshal-smoke", version: "0.1.0" }, { capabilities: {} });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["mcp-server.js"],
  cwd: process.cwd(),
  stderr: "pipe"
});

await client.connect(transport);
const tools = await client.listTools();
const providers = await client.callTool({ name: "worker_list_providers", arguments: {} });
const hasWorkerSendTask = tools.tools.some((tool) => tool.name === "worker_send_task");
const hasWorkerSummarizeSession = tools.tools.some((tool) => tool.name === "worker_summarize_session");
const hasReasonixAlias = tools.tools.some((tool) => tool.name === "reasonix_send_task");
const hasReasonixSummarizeAlias = tools.tools.some((tool) => tool.name === "reasonix_summarize_session");
const providerIds = providers.structuredContent?.data?.providers?.map((provider) => provider.id) ?? [];
const reasonix = providers.structuredContent?.data?.providers?.find((provider) => provider.id === "reasonix");
const reasonixModels = reasonix?.models?.map((model) => model.id) ?? [];

console.log(JSON.stringify({
  ok: hasWorkerSendTask
    && hasWorkerSummarizeSession
    && hasReasonixAlias
    && hasReasonixSummarizeAlias
    && providerIds.includes("reasonix")
    && providerIds.includes("claude-code")
    && reasonixModels.includes("deepseek-v4-flash")
    && reasonixModels.includes("deepseek-v4-pro"),
  toolCount: tools.tools.length,
  hasWorkerSendTask,
  hasWorkerSummarizeSession,
  hasReasonixAlias,
  hasReasonixSummarizeAlias,
  providers: providerIds,
  reasonixModels
}, null, 2));

await client.close();

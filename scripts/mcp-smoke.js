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
const hasReasonixAlias = tools.tools.some((tool) => tool.name === "reasonix_send_task");
const providerIds = providers.structuredContent?.data?.providers?.map((provider) => provider.id) ?? [];

console.log(JSON.stringify({
  ok: hasWorkerSendTask && hasReasonixAlias && providerIds.includes("reasonix"),
  toolCount: tools.tools.length,
  hasWorkerSendTask,
  hasReasonixAlias,
  providers: providerIds
}, null, 2));

await client.close();

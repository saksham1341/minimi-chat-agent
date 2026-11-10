/**
 * The MCP interface: the application's search, served to any MCP client. The agent runtime is one
 * client, and sends its run's id with each call so results are numbered and kept for that run. Any
 * other client (Claude Code, say) gets the same search, numbered for the call alone. Thin by the
 * same rule as HTTP: validate, call the service, answer.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import { McpServer } from "@modelcontextprotocol/server";
import type { RunRegistry } from "../services/runs.ts";
import { CitedSearch, SEARCH_TOOL, type SearchService } from "../services/web-search.ts";

export async function handleMcp(search: SearchService, runs: RunRegistry, req: IncomingMessage, res: ServerResponse) {
  const run = runs.get(String(req.headers["x-run-id"] ?? ""));
  const server = new McpServer({ name: "web-search", version: "1.0.0" });
  server.registerTool(SEARCH_TOOL.name, { description: SEARCH_TOOL.description, inputSchema: SEARCH_TOOL.input }, async (input, ctx) => {
    // The client's cancel (the person pressed stop) reaches the provider call.
    const answer = await (run ?? new CitedSearch(search)).answer(input, ctx.mcpReq.signal);
    return { content: [{ type: "text" as const, text: answer.text }], ...(answer.failed ? { isError: true } : {}) };
  });
  const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res);
}

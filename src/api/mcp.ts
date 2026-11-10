/**
 * The MCP interface: the search service, served to any MCP client. The agent runtime is one
 * such client. Thin by the same rule as HTTP: validate, call the service, answer.
 *
 * Stateless: a server and transport per request, which is all a single tool with no session
 * state needs, and it means nothing here outlives a call.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import { McpServer } from "@modelcontextprotocol/server";
import { SEARCH_TOOL, type SearchPayload, type SearchService } from "../services/web-search.ts";

export async function handleMcp(search: SearchService, req: IncomingMessage, res: ServerResponse) {
  const server = new McpServer({ name: "web-search", version: "1.0.0" });
  server.registerTool(
    SEARCH_TOOL.name,
    { description: SEARCH_TOOL.description, inputSchema: SEARCH_TOOL.input },
    async (input) => {
      try {
        const payload: SearchPayload = { results: await search.search(input) };
        return { content: [{ type: "text" as const, text: JSON.stringify(payload) }] };
      } catch (error) {
        // A failed search is still an answer: the model asked and is owed one.
        return { content: [{ type: "text" as const, text: `Search failed: ${(error as Error).message}` }], isError: true };
      }
    },
  );
  const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res);
}

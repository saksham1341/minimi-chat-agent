/**
 * The MCP interface: the application's search, served to any MCP client: this application's own
 * agent runtime, Claude Code, anything. Stateless and the same for every caller. Each result comes
 * back twice: as text for the model to read, and as structured data for a client that keeps
 * track of sources (the chat service does).
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { formatResults, SEARCH_TOOL, type SearchService } from "../services/web-search.ts";

const RESULTS = z.object({
  cached: z.boolean(),
  results: z.array(z.object({ id: z.string(), title: z.string(), url: z.string(), domain: z.string(), published: z.string().optional(), text: z.string() })),
});

export async function handleMcp(search: SearchService, req: IncomingMessage, res: ServerResponse) {
  const server = new McpServer({ name: "web-search", version: "1.0.0" });
  server.registerTool(SEARCH_TOOL.name, { description: SEARCH_TOOL.description, inputSchema: SEARCH_TOOL.input, outputSchema: RESULTS }, async (input, ctx) => {
    try {
      // The client's cancel (the person pressed stop) reaches the provider call.
      const found = await search.search(input, ctx.mcpReq.signal);
      return { content: [{ type: "text" as const, text: formatResults(found.results, input.since) }], structuredContent: found };
    } catch (error) {
      // A failed search is still an answer: the model asked and is owed one.
      return { content: [{ type: "text" as const, text: `Search failed: ${(error as Error).message}` }], isError: true };
    }
  });
  const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res);
}

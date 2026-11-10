/**
 * The runtime's tools, reached over MCP. Ported from Keel's `keel/agents/mcp_tools.py`.
 *
 * The runtime knows no tool by name. It asks an MCP server what it offers and runs what the model
 * asks for, so the agent's capabilities are whatever service is on the other end: the app's own
 * web search today, mounted at /mcp in the same process, or any other MCP server tomorrow, by
 * changing one URL. In-process the hop costs a few milliseconds against seconds of model and
 * search time, which is what makes a real boundary affordable here.
 */
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { ToolCall, ToolResult } from "./conversation.ts";
import type { ToolSpec, ToolSurface } from "./ports.ts";

export class McpToolSurface implements ToolSurface {
  private client?: Promise<Client>;
  private tools?: ToolSpec[];

  constructor(
    private readonly endpoint: URL,
    private readonly timeoutMs = 30_000,
  ) {}

  async offered(): Promise<ToolSpec[]> {
    if (!this.tools) {
      const { tools } = await (await this.connect()).listTools();
      this.tools = tools.map((tool) => ({
        name: tool.name,
        description: tool.description ?? "",
        inputSchema: tool.inputSchema as Record<string, unknown>,
      }));
    }
    return this.tools;
  }

  async run(call: ToolCall, signal?: AbortSignal): Promise<ToolResult> {
    const client = await this.connect();
    const result = await client.callTool({ name: call.name, arguments: call.arguments }, { signal, timeout: this.timeoutMs });
    const text = (result.content as { type: string; text?: string }[])
      .filter((block) => block.type === "text")
      .map((block) => block.text ?? "")
      .join("\n");
    return { callId: call.id, name: call.name, content: text, failed: result.isError === true };
  }

  /** One connection, opened on first use and reopened if it failed. */
  private connect(): Promise<Client> {
    this.client ??= (async () => {
      const client = new Client({ name: "agent-runtime", version: "1.0.0" });
      await client.connect(new StreamableHTTPClientTransport(this.endpoint));
      return client;
    })().catch((error) => {
      this.client = undefined;
      throw new Error(`The tool server at ${this.endpoint} did not answer: ${(error as Error).message}`);
    });
    return this.client;
  }
}

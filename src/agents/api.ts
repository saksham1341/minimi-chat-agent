/**
 * The runtime as its own deployment: the same `AgentRuntime`, reached over HTTP. Two routes, one
 * optional bearer token (`AGENT_SERVICE_TOKEN`), and nothing else: it stores nothing.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AgentRuntime, RunRequest } from "./runtime.ts";

export function runtimeServer(runtime: AgentRuntime, token?: string) {
  return createServer(async (req, res) => {
    if (token && req.headers.authorization !== `Bearer ${token}`) return reply(res, 401, { error: "unauthorized" });
    try {
      if (req.url === "/models" && req.method === "GET") return reply(res, 200, runtime.models());
      if (req.url === "/runs" && req.method === "POST") {
        const request = JSON.parse(await body(req)) as RunRequest;
        const controller = new AbortController();
        let finished = false;
        res.on("close", () => !finished && controller.abort());
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        for await (const event of runtime.run(request, controller.signal)) res.write(`data: ${JSON.stringify(event)}\n\n`);
        finished = true;
        return res.end();
      }
      reply(res, 404, { error: "not found" });
    } catch (error) {
      if (!res.headersSent) reply(res, 500, { error: (error as Error).message });
      else {
        res.write(`data: ${JSON.stringify({ type: "error", message: (error as Error).message })}\n\n`);
        res.end();
      }
    }
  });
}

function reply(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(value));
}

function body(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

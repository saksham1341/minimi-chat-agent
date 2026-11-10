/**
 * The runtime as its own deployment: the same `AgentRuntime`, reached over HTTP. Three routes, one
 * optional bearer token (`AGENT_SERVICE_TOKEN`), and nothing else: it stores nothing.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AgentRuntime, RunRequest } from "./runtime.ts";

export function runtimeServer(runtime: AgentRuntime, token?: string) {
  return createServer(async (req, res) => {
    if (token && req.headers.authorization !== `Bearer ${token}`) return reply(res, 401, { error: "unauthorized" });
    try {
      if (req.url === "/models" && req.method === "GET") return reply(res, 200, runtime.models());
      const input = req.url?.match(/^\/runs\/([\w-]+)\/input$/);
      if (input && req.method === "POST") {
        const { text } = JSON.parse(await body(req)) as { text?: string };
        if (!text?.trim()) return reply(res, 400, { error: "say something" });
        const waiting = runtime.say(input[1], text.trim());
        // A finished run cannot take a message; pretending otherwise would swallow it.
        return waiting ? reply(res, 202, waiting) : reply(res, 409, { error: "that run is not in progress" });
      }
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

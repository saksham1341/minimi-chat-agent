/**
 * The HTTP interface. Thin by rule: parse the request, call a service, write the response. A
 * second interface (a CLI, an MCP server) would call the same services at the same width.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { gzipSync } from "node:zlib";
import type { App } from "../assembly.ts";
import { handleMcp } from "./mcp.ts";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml",
  ".png": "image/png", ".ico": "image/x-icon", ".woff2": "font/woff2", ".json": "application/json",
};

export function serve(app: App, staticDir: string) {
  return createServer(async (req, res) => {
    // One line per request, for knowing what a remote browser actually fetched and how it went.
    const started = Date.now();
    res.on("finish", () => {
      const bytes = res.getHeader("content-length") ?? "stream";
      console.log(`${req.socket.remoteAddress?.replace("::ffff:", "")} ${req.method} ${req.url} ${res.statusCode} ${bytes} ${Date.now() - started}ms`);
    });
    res.on("close", () => {
      if (!res.writableFinished) console.log(`${req.socket.remoteAddress?.replace("::ffff:", "")} ${req.method} ${req.url} closed before finishing after ${Date.now() - started}ms`);
    });
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const path = url.pathname;
      if (path === "/api/meta" && req.method === "GET") return json(res, await meta(app));
      if (path === "/api/conversations" && req.method === "GET") return json(res, app.store.conversations(100));
      const one = path.match(/^\/api\/conversations\/([\w-]+)$/);
      if (one && req.method === "GET") {
        const conversation = app.store.conversation(one[1]);
        if (!conversation) return json(res, { error: "not found" }, 404);
        return json(res, { conversation, turns: app.store.turns(conversation.id) });
      }
      if (path === "/api/chat" && req.method === "POST") return chat(app, req, res);
      if (path === "/api/recall" && req.method === "GET") {
        // The type-ahead preview: memory only. No model, no search, nothing stored.
        const q = url.searchParams;
        const message = (q.get("message") ?? "").slice(0, 2000);
        const zone = validZone(q.get("timeZone") ?? undefined) ?? app.settings.timeZone;
        return json(res, message.trim().length < 8 ? [] : app.recall.preview(message, q.get("conversationId") ?? "", app.clock.now(), zone));
      }
      if (path === "/mcp") {
        // The tool server is for the runtime, which by default is this same process.
        const from = req.socket.remoteAddress?.replace("::ffff:", "");
        if (!app.settings.mcpAllowRemote && !isLoopback(from) && from !== app.settings.host) return json(res, { error: "forbidden" }, 403);
        return handleMcp(app.search, app.runs, req, res);
      }
      if (path.startsWith("/api/")) return json(res, { error: "not found" }, 404);
      return file(req, res, staticDir, path);
    } catch (error) {
      if (!res.headersSent) json(res, { error: (error as Error).message }, 500);
      else res.end();
    }
  });
}

async function meta(app: App) {
  const { models, defaultModel } = await app.catalog.list();
  return {
    models,
    defaultModel,
    search: { provider: app.search.providerName, available: app.search.available },
    now: app.clock.now().toISOString(),
    timeZone: app.settings.timeZone,
  };
}

async function chat(app: App, req: IncomingMessage, res: ServerResponse) {
  // JSON only: a form post from some other web page cannot spend the keys or write to memory.
  if (!String(req.headers["content-type"] ?? "").startsWith("application/json")) return json(res, { error: "expected application/json" }, 415);
  const body = JSON.parse((await readBody(req)) || "{}") as { conversationId?: string; message?: string; modelId?: string; timeZone?: string };
  const controller = new AbortController();
  let finished = false;
  res.on("close", () => {
    if (!finished) controller.abort();
  });

  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", connection: "keep-alive" });
  res.flushHeaders();
  const timeZone = validZone(body.timeZone) ?? app.settings.timeZone;
  for await (const event of app.chat.turn({
    conversationId: body.conversationId,
    message: String(body.message ?? ""),
    modelId: body.modelId,
    timeZone,
    signal: controller.signal,
  })) {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  }
  finished = true;
  res.end();
}

function isLoopback(address?: string) {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function validZone(zone?: string) {
  if (!zone) return undefined;
  try {
    new Intl.DateTimeFormat("en", { timeZone: zone });
    return zone;
  } catch {
    return undefined;
  }
}

/** Compressed once per file version (path + modification time), so a rebuild is picked up. */
const gzipped = new Map<string, Buffer>();

async function file(req: IncomingMessage, res: ServerResponse, root: string, path: string) {
  const safe = normalize(path).replace(/^(\.\.[/\\])+/, "");
  let target = join(root, safe);
  const found = await stat(target).catch(() => null);
  if (!found || found.isDirectory()) target = join(root, "index.html");
  const content = await readFile(target).catch(() => null);
  if (!content) {
    res.writeHead(503, { "content-type": "text/plain" });
    return res.end("The web app is not built. Run `npm start` (it builds first).");
  }
  const type = TYPES[extname(target)] ?? "application/octet-stream";
  // Hashed build assets never change under the same name; the page itself must always be fresh.
  const cache = target.includes(`${join(root, "assets")}`) ? "public, max-age=31536000, immutable" : "no-cache";
  const compressible = /^(text|application\/json|image\/svg)/.test(type);
  if (compressible && /\bgzip\b/.test(String(req.headers["accept-encoding"] ?? ""))) {
    const key = `${target}:${(await stat(target)).mtimeMs}`;
    let body = gzipped.get(key);
    if (!body) gzipped.set(key, (body = gzipSync(content)));
    res.writeHead(200, { "content-type": type, "content-encoding": "gzip", "content-length": body.length, "cache-control": cache, vary: "accept-encoding" });
    return res.end(body);
  }
  res.writeHead(200, { "content-type": type, "content-length": content.length, "cache-control": cache });
  res.end(content);
}

function json(res: ServerResponse, body: unknown, status = 200) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage, limit = 64_000): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > limit) reject(new Error("Request too large"));
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

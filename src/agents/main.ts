/** `npm run agents`: the runtime as its own process. The application finds it at AGENT_RUNTIME_URL. */
import { existsSync } from "node:fs";
import { runtimeServer } from "./api.ts";
import { runtimeFromEnv } from "./config.ts";

if (existsSync(".env")) process.loadEnvFile(".env");

const port = Number(process.env.AGENT_PORT ?? 3001);
const host = process.env.AGENT_HOST ?? "127.0.0.1";
const runtime = runtimeFromEnv(process.env, process.env.AGENT_MCP_ENDPOINT ?? "http://127.0.0.1:3000/mcp");
runtimeServer(runtime, process.env.AGENT_SERVICE_TOKEN).listen(port, host, () => {
  const { models } = runtime.models();
  console.log(`\n  Agent runtime on http://${host}:${port}`);
  console.log(`  models   ${models.map((m) => m.label).join(", ") || "none"}`);
  console.log(`  tools    ${process.env.AGENT_MCP_ENDPOINT ?? "http://127.0.0.1:3000/mcp"}\n`);
});

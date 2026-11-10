import { existsSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { assemble, settingsFromEnv } from "./assembly.ts";
import { serve } from "./api/http.ts";

if (existsSync(".env")) process.loadEnvFile(".env");

const app = assemble(settingsFromEnv());
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const server = serve(app, join(root, "web/dist"));

server.listen(app.settings.port, app.settings.host, () => {
  const models = app.catalog.list();
  console.log(`\n  Chat agent on http://localhost:${app.settings.port}`);
  if (app.settings.host === "0.0.0.0") {
    for (const [name, addresses] of Object.entries(networkInterfaces())) {
      for (const a of addresses ?? []) {
        // Docker bridges and loopback are not places a person browses from.
        if (a.family === "IPv4" && !a.internal && !name.startsWith("br-") && !name.startsWith("docker") && !name.startsWith("veth")) {
          console.log(`               http://${a.address}:${app.settings.port}  (${name})`);
        }
      }
    }
  }
  console.log("");
  console.log(`  models   ${models.length ? models.map((m) => m.label).join(", ") : "none — set ANTHROPIC_API_KEY or AWS Bedrock credentials in .env"}`);
  console.log(`  search   ${app.search.available ? `${app.search.providerName}, served over MCP at /mcp` : "off — set EXA_API_KEY or TAVILY_API_KEY in .env"}`);
  console.log(`  clock    ${app.clock.now().toISOString()}${app.settings.now ? " (AGENT_NOW)" : ""}, ${app.settings.timeZone}`);
  console.log(`  memory   ${app.settings.dataFile}\n`);
});

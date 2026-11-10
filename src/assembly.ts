/**
 * The composition root: the one place that reads the environment, chooses adapters and builds
 * services. Every other module receives what it needs; none reaches for a key or a global.
 *
 * Two halves, as in Keel. The application (memory, search, citations, the interfaces) is built
 * here. The agent runtime (the loop, the models and every model credential) is either built here
 * too and called in-process (`APP_AGENTS=embedded`, the default), or reached over HTTP as its own
 * deployment (`APP_AGENTS=remote`, `npm run agents`). The application never holds a model key.
 */
import { runtimeFromEnv } from "./agents/config.ts";
import { RuntimeClaimExtractor } from "./adapters/claims/runtime.ts";
import { ShiftedClock, SystemClock } from "./adapters/clock.ts";
import { EmbeddedRuntime } from "./adapters/runtime/embedded.ts";
import { RemoteRuntime } from "./adapters/runtime/remote.ts";
import { AbsentSearch } from "./adapters/search/absent.ts";
import { ExaSearch } from "./adapters/search/exa.ts";
import { TavilySearch } from "./adapters/search/tavily.ts";
import { SqliteMemory } from "./adapters/store/sqlite.ts";
import type { AgentRuntimePort } from "./ports/runtime.ts";
import type { SearchProvider } from "./ports/search.ts";
import { ModelCatalog } from "./services/catalog.ts";
import { ChatService } from "./services/chat.ts";
import { LedgerService } from "./services/ledger.ts";
import { RecallService } from "./services/recall.ts";
import { SearchService } from "./services/web-search.ts";

export interface Settings {
  host: string;
  port: number;
  dataFile: string;
  timeZone: string;
  exaKey?: string;
  tavilyKey?: string;
  searchProvider?: string;
  now?: string;
  /** Where agents run: in this process, or their own deployment at `agentRuntimeUrl`. */
  agents: "embedded" | "remote";
  agentRuntimeUrl?: string;
  agentServiceToken?: string;
  /** Serve /mcp to other machines too, for a runtime deployed elsewhere. Default: loopback only. */
  mcpAllowRemote: boolean;
}

export function settingsFromEnv(env = process.env): Settings {
  const blank = (v?: string) => (v && v.trim() ? v.trim() : undefined);
  return {
    // Loopback by default: there is no sign-in, so anyone who can reach the port can read the
    // conversations and spend the keys. HOST=0.0.0.0 opens it to a LAN or tailnet on purpose.
    host: blank(env.HOST) ?? "127.0.0.1",
    port: Number(env.PORT ?? 3000),
    dataFile: env.DATA_FILE ?? "data/memory.db",
    timeZone: blank(env.TIME_ZONE) ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    exaKey: blank(env.EXA_API_KEY),
    tavilyKey: blank(env.TAVILY_API_KEY),
    searchProvider: blank(env.SEARCH_PROVIDER)?.toLowerCase(),
    now: blank(env.AGENT_NOW),
    agents: blank(env.APP_AGENTS) === "remote" ? "remote" : "embedded",
    agentRuntimeUrl: blank(env.AGENT_RUNTIME_URL),
    agentServiceToken: blank(env.AGENT_SERVICE_TOKEN),
    mcpAllowRemote: env.MCP_ALLOW_REMOTE === "true",
  };
}

export function assemble(settings: Settings, log: (message: string) => void = console.log, env = process.env) {
  const search = new SearchService(chooseSearch(settings));
  const store = new SqliteMemory(settings.dataFile);
  const clock = settings.now ? new ShiftedClock(new Date(settings.now)) : new SystemClock();

  // The runtime reaches this application's tools over MCP, at /mcp on this server.
  const self = settings.host === "0.0.0.0" || settings.host === "::" ? "127.0.0.1" : settings.host;
  const mcp = `http://${self.includes(":") ? `[${self}]` : self}:${settings.port}/mcp`;
  const runtime: AgentRuntimePort =
    settings.agents === "remote"
      ? new RemoteRuntime(settings.agentRuntimeUrl ?? "http://127.0.0.1:3001", settings.agentServiceToken)
      : new EmbeddedRuntime(runtimeFromEnv(env, mcp));

  const catalog = new ModelCatalog(runtime);
  const recall = new RecallService(store);
  const extractor = new RuntimeClaimExtractor(runtime, () => catalog.light());
  const ledger = new LedgerService(store, extractor);
  const chat = new ChatService({ store, clock, models: catalog, runtime, search, recall, ledger, log });

  return { settings, catalog, search, store, clock, chat, recall };
}

export type App = ReturnType<typeof assemble>;

function chooseSearch(s: Settings): SearchProvider {
  const exa = s.exaKey ? new ExaSearch(s.exaKey) : undefined;
  const tavily = s.tavilyKey ? new TavilySearch(s.tavilyKey) : undefined;
  if (s.searchProvider === "tavily" && tavily) return tavily;
  if (s.searchProvider === "exa" && exa) return exa;
  return exa ?? tavily ?? new AbsentSearch();
}

/**
 * The composition root: the one place that reads the environment, chooses adapters and builds
 * services. Every other module receives what it needs; none reaches for a key or a global.
 *
 * Which models and which search provider exist is decided here, from which keys are set, and the
 * UI's model picker is simply what this produced.
 */
import { anthropicModels } from "./agents/models/anthropic.ts";
import { bedrockClient, bedrockModels, SONNET_4_5 } from "./agents/models/bedrock.ts";
import type { ChatModel } from "./agents/ports.ts";
import { AbsentClaimExtractor, AnthropicClaimExtractor } from "./adapters/claims/anthropic.ts";
import { BedrockClaimExtractor } from "./adapters/claims/bedrock.ts";
import type { ClaimExtractor } from "./ports/claims.ts";
import { ShiftedClock, SystemClock } from "./adapters/clock.ts";
import { AbsentSearch } from "./adapters/search/absent.ts";
import { ExaSearch } from "./adapters/search/exa.ts";
import { TavilySearch } from "./adapters/search/tavily.ts";
import { SqliteMemory } from "./adapters/store/sqlite.ts";
import type { SearchProvider } from "./ports/search.ts";
import { ModelCatalog } from "./services/catalog.ts";
import { ChatService } from "./services/chat.ts";
import { LedgerService } from "./services/ledger.ts";
import { RecallService } from "./services/recall.ts";

type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface Settings {
  host: string;
  port: number;
  dataFile: string;
  timeZone: string;
  anthropicKey?: string;
  aws?: { region: string; accessKey?: string; secretKey?: string; sessionToken?: string; models: string[] };
  exaKey?: string;
  tavilyKey?: string;
  searchProvider?: string;
  defaultModel?: string;
  effort: Effort;
  now?: string;
}

export function settingsFromEnv(env = process.env): Settings {
  const blank = (v?: string) => (v && v.trim() ? v.trim() : undefined);
  return {
    // All interfaces by default, so the app is reachable over a LAN or a tailnet, not only localhost.
    host: blank(env.HOST) ?? "0.0.0.0",
    port: Number(env.PORT ?? 3000),
    dataFile: env.DATA_FILE ?? "data/memory.db",
    timeZone: blank(env.TIME_ZONE) ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    anthropicKey: blank(env.ANTHROPIC_API_KEY),
    // Bedrock is on when a region is set and credentials exist (keys here, or a profile/role the
    // AWS SDK finds itself, which BEDROCK_MODELS alone signals).
    aws:
      blank(env.AWS_REGION) && (blank(env.AWS_ACCESS_KEY_ID) || blank(env.BEDROCK_MODELS))
        ? {
            region: blank(env.AWS_REGION)!,
            accessKey: blank(env.AWS_ACCESS_KEY_ID),
            secretKey: blank(env.AWS_SECRET_ACCESS_KEY),
            sessionToken: blank(env.AWS_SESSION_TOKEN),
            models: (blank(env.BEDROCK_MODELS) ?? SONNET_4_5).split(",").map((m) => m.trim()).filter(Boolean),
          }
        : undefined,
    exaKey: blank(env.EXA_API_KEY),
    tavilyKey: blank(env.TAVILY_API_KEY),
    searchProvider: blank(env.SEARCH_PROVIDER)?.toLowerCase(),
    defaultModel: blank(env.DEFAULT_MODEL),
    effort: (blank(env.EFFORT) as Effort) ?? "low",
    now: blank(env.AGENT_NOW),
  };
}

export function assemble(settings: Settings, log: (message: string) => void = console.log) {
  const models: ChatModel[] = [];
  let extractor: ClaimExtractor = new AbsentClaimExtractor();
  if (settings.aws) {
    const client = bedrockClient(settings.aws);
    models.push(...bedrockModels(client, settings.aws.models, settings.effort));
    extractor = new BedrockClaimExtractor(client, settings.aws.models[0]);
  }
  if (settings.anthropicKey) {
    models.push(...anthropicModels(settings.anthropicKey, settings.effort));
    extractor = new AnthropicClaimExtractor(settings.anthropicKey);
  }
  const catalog = new ModelCatalog(models, settings.defaultModel);

  const search = chooseSearch(settings);
  const store = new SqliteMemory(settings.dataFile);
  const clock = settings.now ? new ShiftedClock(new Date(settings.now)) : new SystemClock();
  const recall = new RecallService(store);
  const ledger = new LedgerService(store, extractor);
  const chat = new ChatService({ store, clock, models: catalog, search, recall, ledger, log });

  return { settings, catalog, search, store, clock, chat };
}

export type App = ReturnType<typeof assemble>;

function chooseSearch(s: Settings): SearchProvider {
  const exa = s.exaKey ? new ExaSearch(s.exaKey) : undefined;
  const tavily = s.tavilyKey ? new TavilySearch(s.tavilyKey) : undefined;
  if (s.searchProvider === "tavily" && tavily) return tavily;
  if (s.searchProvider === "exa" && exa) return exa;
  return exa ?? tavily ?? new AbsentSearch();
}

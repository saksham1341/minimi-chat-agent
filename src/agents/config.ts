/**
 * The runtime's own settings. It holds every model credential; the application holds none.
 */
import { anthropicModels } from "./models/anthropic.ts";
import { bedrockClient, bedrockModels, SONNET_4_5 } from "./models/bedrock.ts";
import type { ChatModel } from "./ports.ts";
import { AgentRuntime } from "./runtime.ts";

type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export function runtimeFromEnv(env: NodeJS.ProcessEnv, toolServer?: string): AgentRuntime {
  const blank = (v?: string) => (v && v.trim() ? v.trim() : undefined);
  const effort = (blank(env.EFFORT) as Effort) ?? "low";
  const models: ChatModel[] = [];
  const region = blank(env.AWS_REGION);
  if (region && (blank(env.AWS_ACCESS_KEY_ID) || blank(env.BEDROCK_MODELS))) {
    const client = bedrockClient({
      region,
      accessKey: blank(env.AWS_ACCESS_KEY_ID),
      secretKey: blank(env.AWS_SECRET_ACCESS_KEY),
      sessionToken: blank(env.AWS_SESSION_TOKEN),
    });
    const ids = (blank(env.BEDROCK_MODELS) ?? SONNET_4_5).split(",").map((m) => m.trim()).filter(Boolean);
    models.push(...bedrockModels(client, ids, effort));
  }
  const anthropic = blank(env.ANTHROPIC_API_KEY);
  if (anthropic) models.push(...anthropicModels(anthropic, effort));
  const endpoint = blank(env.AGENT_MCP_ENDPOINT) ?? toolServer;
  return new AgentRuntime(models, endpoint ? new URL(endpoint) : undefined, blank(env.DEFAULT_MODEL));
}

/**
 * Claude through Amazon Bedrock, for the `ChatModel` port. Ported from Keel's
 * `keel/agents/bedrock_model.py`.
 *
 * The same API as the direct one, reached through a different door and paid on a different bill,
 * so the wire format is shared (`claude-wire.ts`) and this file holds only what the door changes:
 *
 *   the client     `@anthropic-ai/bedrock-sdk` is pinned to 0.36.0, which sends the API version
 *                  Bedrock accepts for models older than Claude 4.7. Its 1.x sends a newer
 *                  version Bedrock refuses for those models
 *   model names    a `global.` id is a cross-region inference profile: capacity is found wherever
 *                  there is some, which keeps a busy region from failing a turn
 *   thinking       Sonnet 4.5 predates adaptive thinking and effort; it takes a token budget, and
 *                  thinking between tool calls is a beta header. Sending it adaptive is a 400.
 *                  At effort `low` (the default) it is off, for speed; see BUDGETS
 *   streaming      no eager tool-input streaming on this version, so a card arrives whole
 *
 * Credentials are taken from the environment the way the AWS SDK always resolves them, unless
 * keys are passed explicitly.
 */
import { AnthropicBedrock } from "@anthropic-ai/bedrock-sdk";
import type { Said } from "../conversation.ts";
import type { ChatModel, ModelDelta, ModelInfo, ModelRequest } from "../ports.ts";
import { readTurn, toolsToWire, toWire, withJsonRetry } from "./claude-wire.ts";

export const PROVIDER = "bedrock";
export const SONNET_4_5 = "global.anthropic.claude-sonnet-4-5-20250929-v1:0";
export const HAIKU_4_5 = "global.anthropic.claude-haiku-4-5-20251001-v1:0";

/**
 * How much thinking each effort buys, in tokens: words at the port, numbers here. `low` buys none:
 * measured on this model, even the minimum budget took first-token time from about 1.8 s to
 * 2.5-5.4 s, and for chat that is the difference people notice.
 */
const BUDGETS = { low: 0, medium: 4000, high: 10000 } as const;

export interface BedrockOptions {
  region: string;
  accessKey?: string;
  secretKey?: string;
  sessionToken?: string;
}

export function bedrockClient(o: BedrockOptions): AnthropicBedrock {
  if (o.accessKey && o.secretKey) {
    return new AnthropicBedrock({ awsRegion: o.region, awsAccessKey: o.accessKey, awsSecretKey: o.secretKey, awsSessionToken: o.sessionToken ?? null });
  }
  return new AnthropicBedrock({ awsRegion: o.region });
}

export class BedrockModel implements ChatModel {
  readonly info: ModelInfo;

  constructor(
    private readonly client: AnthropicBedrock,
    private readonly model: string,
    private readonly effort: keyof typeof BUDGETS,
    label: string,
    hint: string,
  ) {
    this.info = { id: `${PROVIDER}:${model}`, provider: PROVIDER, label, hint };
  }

  respond(request: ModelRequest, onDelta?: (delta: ModelDelta) => void): Promise<Said> {
    return withJsonRetry(
      () => this.once(request, onDelta),
      (e) => typeof e === "object" && e !== null && "status" in e,
      request.signal,
    );
  }

  private once(request: ModelRequest, onDelta?: (delta: ModelDelta) => void): Promise<Said> {
    const budget = BUDGETS[this.effort];
    const stream = this.client.beta.messages.stream(
      {
        model: this.model,
        max_tokens: 16000,
        system: [{ type: "text", text: request.instruction, cache_control: { type: "ephemeral" } }],
        messages: toWire(request.history, PROVIDER, { cacheLast: true }) as never,
        tools: toolsToWire(request.tools, false) as never,
        ...(budget ? { thinking: { type: "enabled" as const, budget_tokens: budget }, betas: ["interleaved-thinking-2025-05-14"] } : {}),
      },
      { signal: request.signal },
    );
    return readTurn(stream as never, PROVIDER, onDelta);
  }
}

const KNOWN: Record<string, { label: string; hint: string }> = {
  [SONNET_4_5]: { label: "Claude Sonnet 4.5 (Bedrock)", hint: "Through AWS Bedrock. Strong all-rounder." },
  [HAIKU_4_5]: { label: "Claude Haiku 4.5 (Bedrock)", hint: "Through AWS Bedrock. Fastest; simple lookups." },
};

/** The Bedrock models offered when AWS credentials and a region are configured. */
export function bedrockModels(client: AnthropicBedrock, ids: string[], effort: string): BedrockModel[] {
  const level = (effort in BUDGETS ? effort : effort === "xhigh" || effort === "max" ? "high" : "low") as keyof typeof BUDGETS;
  return ids.map((id) => {
    const known = KNOWN[id] ?? { label: `${id.replace(/^(global|us|eu|apac)\./, "").replace(/^anthropic\./, "")} (Bedrock)`, hint: "Through AWS Bedrock." };
    return new BedrockModel(client, id, level, known.label, known.hint);
  });
}

/**
 * Claude through the Anthropic API, for the `ChatModel` port: current models, adaptive thinking
 * with an effort, server-side refusal fallbacks, and tool input streamed as it is written.
 */
import Anthropic from "@anthropic-ai/sdk";
import type { Said } from "../../agents/conversation.ts";
import type { ChatModel, ModelDelta, ModelInfo, ModelRequest } from "../../agents/ports.ts";
import { readTurn, toolsToWire, toWire, withJsonRetry } from "./claude-wire.ts";

type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export const PROVIDER = "anthropic";

export interface AnthropicModelOptions {
  client: Anthropic;
  model: string;
  label: string;
  hint: string;
  effort: Effort;
  /** Re-run a declined request on a fallback model inside the same call (Opus/Sonnet 5.5). */
  fallbacks: boolean;
  maxTokens?: number;
}

export class AnthropicModel implements ChatModel {
  readonly info: ModelInfo;

  constructor(private readonly options: AnthropicModelOptions) {
    this.info = { id: `${PROVIDER}:${options.model}`, provider: PROVIDER, label: options.label, hint: options.hint };
  }

  respond(request: ModelRequest, onDelta?: (delta: ModelDelta) => void): Promise<Said> {
    return withJsonRetry(() => this.once(request, onDelta), (e) => e instanceof Anthropic.APIError, request.signal);
  }

  private once(request: ModelRequest, onDelta?: (delta: ModelDelta) => void): Promise<Said> {
    const { client, model, effort, fallbacks, maxTokens } = this.options;
    const stream = client.beta.messages.stream(
      {
        model,
        max_tokens: maxTokens ?? 32000,
        // The instruction never changes, so it is cached once and read back at a tenth of the
        // price. The clock and recalled memory ride in the user turn, not here.
        system: [{ type: "text", text: request.instruction, cache_control: { type: "ephemeral" } }],
        // Caches the conversation prefix up to the newest block; each request extends it.
        cache_control: { type: "ephemeral" },
        messages: toWire(request.history, PROVIDER) as unknown as Anthropic.Beta.Messages.BetaMessageParam[],
        tools: toolsToWire(request.tools, true) as unknown as Anthropic.Beta.Messages.BetaTool[],
        thinking: { type: "adaptive" },
        output_config: { effort },
        ...(fallbacks ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
      },
      { signal: request.signal },
    );
    return readTurn(stream, PROVIDER, onDelta);
  }
}

/** The Claude models offered when ANTHROPIC_API_KEY is set. */
export function anthropicModels(apiKey: string, effort: Effort): AnthropicModel[] {
  const client = new Anthropic({ apiKey });
  return [
    new AnthropicModel({ client, model: "claude-opus-5-5", label: "Claude Opus 5.5", hint: "Most careful. Best for comparisons and re-checks.", effort, fallbacks: true }),
    new AnthropicModel({ client, model: "claude-sonnet-5-5", label: "Claude Sonnet 5.5", hint: "Fast and sharp. Good default for chat.", effort, fallbacks: true }),
    new AnthropicModel({ client, model: "claude-haiku-5-5", label: "Claude Haiku 5.5", hint: "Fastest and cheapest. Simple lookups.", effort, fallbacks: false }),
  ];
}

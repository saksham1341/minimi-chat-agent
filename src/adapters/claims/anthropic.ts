/**
 * Claim extraction on Claude Haiku 5.5, after the answer has been sent, so it costs the person no
 * time. Structured output makes the reply a schema-checked list rather than prose to parse.
 */
import Anthropic from "@anthropic-ai/sdk";
import type { ClaimDraft, Source } from "../../domain/memory.ts";
import type { ClaimExtractor } from "../../ports/claims.ts";
import { CLAIMS_SCHEMA, CLAIMS_SYSTEM, toDrafts } from "./shared.ts";

export class AnthropicClaimExtractor implements ClaimExtractor {
  readonly available = true;
  private readonly client: Anthropic;

  constructor(apiKey: string, private readonly model = "claude-haiku-5-5") {
    this.client = new Anthropic({ apiKey });
  }

  async extract({ question, answer, sources }: { question: string; answer: string; sources: Source[] }): Promise<ClaimDraft[]> {
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 4000,
      output_config: { effort: "low", format: { type: "json_schema", schema: CLAIMS_SCHEMA } },
      system: CLAIMS_SYSTEM,
      messages: [{ role: "user", content: `Question:\n${question}\n\nAnswer:\n${answer}` }],
    });
    const text = response.content.find((b) => b.type === "text");
    if (!text || text.type !== "text") return [];
    return toDrafts(JSON.parse(text.text), sources);
  }
}

export class AbsentClaimExtractor implements ClaimExtractor {
  readonly available = false;
  async extract(): Promise<ClaimDraft[]> {
    return [];
  }
}

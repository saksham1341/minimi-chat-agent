/**
 * Claim extraction through Bedrock. On the API version Bedrock serves older models, a forced tool
 * call is the schema-checked way to get a list back (no thinking, so forcing is allowed).
 */
import type { AnthropicBedrock } from "@anthropic-ai/bedrock-sdk";
import type { ClaimDraft, Source } from "../../domain/memory.ts";
import type { ClaimExtractor } from "../../ports/claims.ts";
import { CLAIMS_SCHEMA, CLAIMS_SYSTEM, toDrafts } from "./shared.ts";

export class BedrockClaimExtractor implements ClaimExtractor {
  readonly available = true;
  constructor(private readonly client: AnthropicBedrock, private readonly model: string) {}

  async extract({ question, answer, sources }: { question: string; answer: string; sources: Source[] }): Promise<ClaimDraft[]> {
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 4000,
      system: CLAIMS_SYSTEM,
      tools: [{ name: "record_claims", description: "Record the checkable facts.", input_schema: CLAIMS_SCHEMA as never }],
      tool_choice: { type: "tool", name: "record_claims" },
      messages: [{ role: "user", content: `Question:\n${question}\n\nAnswer:\n${answer}` }],
    });
    const call = response.content.find((b) => b.type === "tool_use");
    return call && call.type === "tool_use" ? toDrafts(call.input, sources) : [];
  }
}

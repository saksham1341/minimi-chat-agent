/**
 * Claim extraction, run by the agent runtime (which holds every model credential) as a turn with no
 * tools and one answer shape. A schema-checked list rather than prose to parse.
 */
import { randomUUID } from "node:crypto";
import { asked } from "../../agents/conversation.ts";
import type { ClaimDraft, Source } from "../../domain/memory.ts";
import type { ClaimExtractor } from "../../ports/claims.ts";
import type { AgentRuntimePort } from "../../ports/runtime.ts";
import { CLAIMS_SCHEMA, CLAIMS_SYSTEM, toDrafts } from "./shared.ts";

export class RuntimeClaimExtractor implements ClaimExtractor {
  readonly available = true;

  constructor(private readonly runtime: AgentRuntimePort, private readonly model?: () => Promise<string | undefined>) {}

  async extract({ question, answer, sources }: { question: string; answer: string; sources: Source[] }): Promise<ClaimDraft[]> {
    const events = this.runtime.run({
      runId: randomUUID(),
      model: await this.model?.(),
      instruction: `${CLAIMS_SYSTEM} Answer by calling answer_claims once.`,
      history: [],
      ask: asked(`Question:\n${question}\n\nAnswer:\n${answer}`),
      endings: [{ name: "claims", description: "Record the checkable facts the answer stated.", schema: CLAIMS_SCHEMA }],
      tools: false,
      maxRounds: 1,
    });
    for await (const event of events) if (event.type === "done" && event.answer) return toDrafts(event.answer, sources);
    return [];
  }
}

export class AbsentClaimExtractor implements ClaimExtractor {
  readonly available = false;
  async extract(): Promise<ClaimDraft[]> {
    return [];
  }
}

import type { ClaimDraft, Source } from "../domain/memory.ts";

/** Reads an answer and lists the checkable facts it stated. A judgement, so it sits behind a port. */
export interface ClaimExtractor {
  readonly available: boolean;
  extract(input: { question: string; answer: string; sources: Source[] }): Promise<ClaimDraft[]>;
}

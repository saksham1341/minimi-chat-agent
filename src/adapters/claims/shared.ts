import type { ClaimDraft, Source } from "../../domain/memory.ts";

export const CLAIMS_SYSTEM =
  "List the checkable facts an assistant's answer stated: prices, plan limits, release dates, versions, " +
  "launches, who owns what, numbers. One per item, specific enough to re-check later. Skip opinions, advice " +
  "and anything vague. An empty list is a fine answer.";

export const CLAIMS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["claims"],
  properties: {
    claims: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["subject", "value", "source", "quote"],
        properties: {
          subject: { type: "string", description: "Who or what, specific: 'Neon, Launch plan', 'HubSpot Sales Hub Pro'." },
          value: { type: "string", description: "What was stated about it, with numbers and units as given." },
          source: { type: "string", description: "The source id it was cited from (S1, S2...), or '' if none." },
          quote: { type: "string", description: "The quoted words in that citation ([S2 \"...\"]), exactly, or '' if it had none." },
        },
      },
    },
  },
};

export function toDrafts(input: unknown, sources: Source[]): ClaimDraft[] {
  const claims = (input as { claims?: { subject: string; value: string; source: string; quote?: string }[] })?.claims ?? [];
  const byId = new Map(sources.map((s) => [s.id, s.url]));
  return claims
    .filter((c) => c.subject && c.value)
    .map((c) => ({ subject: c.subject, value: c.value, sourceUrl: byId.get(c.source), ...(c.quote ? { quote: c.quote } : {}) }));
}

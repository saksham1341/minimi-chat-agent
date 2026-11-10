/**
 * The index card: what an exchange was about, written by the answering model in the same response
 * as its answer (structured output, no second call), and used by software to find the exchange
 * again. The model does what it is good at, recognising what was discussed and every way a person
 * might later refer to it ("Postgres hosting" is also "db hosts", "managed database", "neon").
 * Software does the matching against it, deterministically and in milliseconds.
 */
import { z } from "zod";
import type { ClaimDraft, ExchangeCard, Source } from "./memory.ts";
import { matchForm } from "./text.ts";

const aliases = z
  .array(z.string())
  .describe(
    "Other ways a person might say it later, especially without its name: the generic category ('database', 'db', " +
      "'CRM', 'hosting', 'sales software'), casual shorthand ('db hosts', 'postgres'), abbreviations and the plain-language version.",
  );

export const IndexCard = z.object({
  kind: z
    .enum(["new", "recheck", "followup", "chat"])
    .describe("new: a fresh question. recheck: whether an earlier answer still holds, or what changed since. followup: continues this conversation's question. chat: small talk."),
  summary: z.string().describe("What was asked and answered, in at most 20 words."),
  entities: z
    .array(z.object({ name: z.string(), aliases }))
    .describe("Every vendor, product, plan, technology or organisation the exchange was about."),
  topics: z.array(z.object({ phrase: z.string(), aliases })).describe("What it was about, as short phrases ('Postgres hosting')."),
  facts: z
    .array(
      z.object({
        subject: z.string().describe("Who or what, specific: 'Neon, Launch plan'."),
        value: z.string().describe("What you stated, with numbers and units as given."),
        source: z.string().describe("The source id you cited for it (S3f2a1), or ''."),
        quote: z.string().describe("The quoted words of that citation, exactly, or ''."),
      }),
    )
    .describe("The checkable facts your answer stated (prices, limits, dates, versions, launches). Empty for opinions or small talk."),
});
export type IndexCard = z.infer<typeof IndexCard>;

/**
 * The card a structured answer carries: the same, without facts. A comparison's or report's facts
 * are its own cells and items; asking the model to write them twice only costs the person time.
 */
export const ShapeIndex = IndexCard.omit({ facts: true });

export function toCard(written: IndexCard | z.infer<typeof ShapeIndex>, sources: Source[]): ExchangeCard {
  const urls = new Map(sources.map((s) => [s.id, s.url]));
  const words = [...written.entities.flatMap((e) => [e.name, ...e.aliases]), ...written.topics.flatMap((t) => [t.phrase, ...t.aliases])];
  const facts: ClaimDraft[] = ("facts" in written ? written.facts : [])
    .filter((f) => f.subject && f.value)
    .map((f) => ({ subject: f.subject, value: f.value, sourceUrl: urls.get(f.source), ...(f.quote ? { quote: f.quote } : {}) }));
  return { kind: written.kind, summary: written.summary, terms: [...new Set(words.map(matchForm).filter(Boolean))], facts };
}

/**
 * The card software can write on its own, when the model did not: the sites the answer drew on
 * and the names in its card. Fewer ways in than the model's, never none.
 */
export function fallbackCard(sources: Source[], names: string[]): ExchangeCard {
  const sites = sources.map((s) => s.domain.split(".").slice(-2)[0]).filter(Boolean);
  return { kind: "new", summary: "", terms: [...new Set([...sites, ...names].map(matchForm).filter(Boolean))], facts: [] };
}

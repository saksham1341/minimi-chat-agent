/**
 * The shapes an answer can take besides plain text.
 *
 * Each is offered to the model as a tool whose arguments are the answer. One zod schema per
 * shape is both what the model is shown (as JSON Schema) and what checks what comes back, since
 * streamed tool input is not validated by the provider. The UI draws each one as its own card.
 *
 * Three shapes, because the questions this agent is for come in three kinds that prose serves
 * badly: several options side by side; what is different now from what was said before; and a
 * question back to the person when guessing would waste their time.
 */
import { z } from "zod";
import type { OutputShape } from "../agents/loop.ts";
import type { Source } from "./memory.ts";
import { IndexCard, ShapeIndex } from "./card.ts";
import { isVendorSite } from "./vendor.ts";

const sourceIds = z
  .array(
    z.union([
      z.object({ id: z.string().describe("A search result id, e.g. S3f2a1."), quote: z.string().describe("The exact words from that result this rests on.") }),
      z.string(),
    ]),
  )
  .describe('The search results that back this, each with the exact words it rests on: [{"id": "S3f2a1", "quote": "…"}]. Empty only if it comes from memory.');

/** A card's source entry, either form. */
export type SourceRef = string | { id: string; quote: string; verified?: boolean };
export const refId = (ref: SourceRef) => (typeof ref === "string" ? ref : ref.id);

export const Comparison = z.object({
  headline: z
    .string()
    .describe("The conclusion in one sentence, as you would say it to the person. Shown above the card. Never narrate what you did."),
  title: z.string().describe("What is being compared, e.g. 'CRM tools for a 20-person sales team'."),
  columns: z.array(z.string()).min(1).max(5).describe("The attributes compared, e.g. ['Price / seat / mo', 'Free tier', 'Notable']."),
  rows: z
    .array(
      z.object({
        name: z.string(),
        url: z.string().optional().describe("The option's own site, if known."),
        cells: z.array(z.string()).describe("One terse value per column, in column order: a few words or a number, not a sentence. 'n/a' or 'not public' when unknown."),
        sources: sourceIds,
      }),
    )
    .min(2),
  takeaway: z.string().describe("Two or three sentences of markdown: which fits whom, and why, with citations."),
  index: ShapeIndex.describe("This exchange's index card, written last. Not shown to the person: it is how you will find this exchange again."),
});

export const Changes = z.object({
  headline: z
    .string()
    .describe("The conclusion in one sentence, as you would say it to the person. Shown above the card. Never narrate what you did."),
  title: z.string(),
  since: z.string().describe("The baseline: the date the earlier answer was given, YYYY-MM-DD."),
  items: z
    .array(
      z.object({
        subject: z.string().describe("The thing checked, e.g. 'Neon, Launch plan price'."),
        status: z
          .enum(["changed", "unchanged", "corrected", "new", "unverified"])
          .describe(
            "'changed' only with evidence that it differs now from what was said at the baseline: the vendor's own current page, " +
              "or a source published on or after `since`. A source published before `since` cannot show a change. Sources " +
              "disagreeing, or annual vs monthly billing, is not a change: say 'unchanged' with a note, or 'unverified'. " +
              "'corrected' when what you said then was already wrong or imprecise at the time (for example you gave the " +
              "monthly price as if it were the only one): own it, and put the accurate value in `now`.",
          ),
        before: z.string().optional().describe("What was said or true at the baseline."),
        now: z.string().optional().describe("What is true now."),
        note: z.string().optional().describe("At most 12 words: when it changed, or why it could not be verified. Omit when nothing changed."),
        sources: sourceIds,
      }),
    )
    .min(1),
  summary: z.string().describe("One or two sentences of markdown: the bottom line, with citations."),
  index: ShapeIndex.describe("This exchange's index card, written last. Not shown to the person: it is how you will find this exchange again."),
});

export const Choices = z.object({
  question: z.string().describe("The question, short."),
  options: z
    .array(z.object({ label: z.string(), reply: z.string().describe("What gets sent as the person's message if they pick it.") }))
    .min(2)
    .max(5),
});

type Check = (value: never) => string | null;

function shape(name: string, schema: z.ZodType, description: string, check?: Check): OutputShape {
  const json = z.toJSONSchema(schema) as Record<string, unknown>;
  delete json.$schema;
  return {
    name,
    description,
    schema: json,
    parse(input) {
      const result = schema.safeParse(input);
      if (!result.success) {
        return { ok: false, error: result.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ") };
      }
      const problem = check?.(result.data as never);
      return problem ? { ok: false, error: problem } : { ok: true, value: result.data };
    },
  };
}

/**
 * The rule a "changed" verdict has to meet, checked here because it is checkable: the harness
 * holds every source's published date. A change since the baseline needs a cited source that is
 * either undated (a live page: pricing pages change in place) or dated on or after the baseline.
 * A page from before the baseline can only show what was already true then.
 */
/**
 * Does `source` show what is true now about `subject`? Dated on or after the baseline, or undated
 * and either read live for this answer or on the vendor's own site (hubspot.com for HubSpot). An
 * undated page anywhere else is a roundup of unknown age.
 */
export function showsNow(subject: string, source: Source, since: string): boolean {
  return source.published ? source.published >= since : !!source.live || isVendorSite(subject, source.domain);
}

export function evidenceProblem(changes: Pick<z.infer<typeof Changes>, "since" | "items">, sources: Source[]): string | null {
  const describe = (s: Source) =>
    `${s.id} (${s.domain}, ${s.published ? `published ${s.published}` : "undated, not read live, not the vendor's own site"})`;
  const problems: string[] = [];
  for (const item of changes.items) {
    if (item.status !== "changed" && item.status !== "corrected") continue;
    if (!item.sources.length) {
      problems.push(`"${item.subject}" is marked ${item.status} but cites no source`);
      continue;
    }
    const cited = item.sources.map((ref) => sources.find((s) => s.id === refId(ref))).filter((s): s is Source => !!s);
    if (cited.length && !cited.some((s) => showsNow(item.subject, s, changes.since))) {
      problems.push(`"${item.subject}" is marked ${item.status}, but none of its sources shows what is true now: ${cited.map(describe).join(", ")}`);
    }
  }
  return problems.length
    ? `${problems.join("; ")}. Overturning what was said needs the vendor's own current page or a source published on or after ${changes.since}. Re-check, or mark it unchanged or unverified, then call answer_changes again.`
    : null;
}

/** Every source entry in a card, wherever it sits. */
export function collectRefs(answer: unknown): SourceRef[] {
  const a = answer as { rows?: { sources?: SourceRef[] }[]; items?: { sources?: SourceRef[] }[] } | undefined;
  return [...(a?.rows ?? []), ...(a?.items ?? [])].flatMap((x) => x.sources ?? []);
}

/** The answer shapes for one turn: its numbered results and their snapshots feed the checks. */
export function answerShapes(sources: () => Source[] = () => []): OutputShape[] {
  // Quotes in a card are never a reason to send it back: rewriting a card costs the person 15-30
  // seconds, and a missed quote is shown flagged anyway. A wrong verdict is different; the evidence
  // rule below does send it back.
  return [
    shape(
      "comparison",
      Comparison,
      "Answer with a comparison table, ending the turn. Use when the person is weighing three or more options on the " +
        "same attributes (tools, plans, providers). Search every option in one round (the searches run in parallel), " +
        "then answer; every cell should be backed by a source.",
    ),
    shape(
      "changes",
      Changes,
      "Answer with a what-changed report against an earlier answer, ending the turn. Use when the person asks whether " +
        "something you told them before is still true, or what changed since a date. Cover every option from the earlier " +
        "answer, one item per option with all its facts (not one item per attribute); leave `note` empty when nothing changed; " +
        "mark 'unverified' honestly when the search could not confirm it either way.",
      ((value: z.infer<typeof Changes>) => evidenceProblem(value, sources())) as Check,
    ),
    shape(
      "index",
      IndexCard,
      "After a prose answer, in the same message, call this once with the exchange's index card. It is not shown to " +
        "the person: it is how you will find this exchange again in a later conversation. Not used after the answer " +
        "shapes, which carry their card in their own `index` field.",
    ),
    shape(
      "choices",
      Choices,
      "Ask the person one short question with tappable answers, ending the turn. Use only when you cannot give a useful " +
        "answer without it (for example they refer to an earlier conversation you have no record of and the details " +
        "matter). Never use it to ask permission to search.",
    ),
  ];
}

export const ANSWER_SHAPES = answerShapes();

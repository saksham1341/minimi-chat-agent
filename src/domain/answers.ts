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
import { describeProblems, quoteProblems, type QuoteProblem } from "./quotes.ts";

const sourceIds = z
  .array(
    z.union([
      z.object({ id: z.string().describe("A search result id, e.g. S2."), quote: z.string().describe("The exact words from that result this rests on.") }),
      z.string(),
    ]),
  )
  .describe('The search results that back this, each with the exact words it rests on: [{"id": "S2", "quote": "…"}]. Empty only if it comes from memory.');

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
  takeaway: z.string().describe("Two or three sentences of markdown: which fits whom, and why. Cite as [S#]."),
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
  summary: z.string().describe("One or two sentences of markdown: the bottom line. Cite as [S#]."),
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
export function evidenceProblem(changes: z.infer<typeof Changes>, sources: Source[]): string | null {
  // Evidence of what is true now: dated on or after the baseline, or an undated page that was read
  // live or found on its own site. An undated page from anywhere else is a roundup of unknown age.
  const shows = (s: Source) => (s.published ? s.published >= changes.since : !!(s.live || s.firstParty));
  const describe = (s: Source) =>
    `${s.id} (${s.domain}, ${s.published ? `published ${s.published}` : "undated, not read live or on its own site"})`;
  const problems: string[] = [];
  for (const item of changes.items) {
    if (item.status !== "changed" && item.status !== "corrected") continue;
    if (!item.sources.length) {
      problems.push(`"${item.subject}" is marked ${item.status} but cites no source`);
      continue;
    }
    const cited = item.sources.map((ref) => sources.find((s) => s.id === refId(ref))).filter((s): s is Source => !!s);
    if (cited.length && !cited.some(shows)) {
      problems.push(`"${item.subject}" is marked ${item.status}, but none of its sources shows what is true now: ${cited.map(describe).join(", ")}`);
    }
  }
  return problems.length
    ? `${problems.join("; ")}. Overturning what was said needs the vendor's own current page (search it with \`domains\` and \`fresh: true\`) or a source published on or after ${changes.since}. Re-check, or mark it unchanged or unverified, then call answer_changes again.`
    : null;
}

/** Quotes in a card's source entries that are not in their snapshots. */
export function cardQuoteProblems(answer: unknown, snapshots: ReadonlyMap<string, string>): QuoteProblem[] {
  const refs = collectRefs(answer).filter((r): r is Exclude<SourceRef, string> => typeof r !== "string");
  return quoteProblems(refs.map((r) => ({ id: r.id, quote: r.quote })), snapshots);
}

/** Every source entry in a card, wherever it sits. */
export function collectRefs(answer: unknown): SourceRef[] {
  const a = answer as { rows?: { sources?: SourceRef[] }[]; items?: { sources?: SourceRef[] }[] } | undefined;
  return [...(a?.rows ?? []), ...(a?.items ?? [])].flatMap((x) => x.sources ?? []);
}

/** The answer shapes for one turn: its numbered results and their snapshots feed the checks. */
export function answerShapes(sources: () => Source[] = () => [], snapshots?: () => ReadonlyMap<string, string>): OutputShape[] {
  // A failing quote in a card goes back once, like prose; after that the card is shown with the
  // quote marked unverified rather than bounced until the round budget runs out.
  let quoteBounces = 0;
  const quotesHold = (answer: unknown) => {
    if (!snapshots || quoteBounces >= 1) return null;
    // Same proportion as prose: a couple of misses are shown flagged; more means a sloppy card.
    const problems = cardQuoteProblems(answer, snapshots());
    if (problems.length <= 2) return null;
    quoteBounces++;
    return describeProblems(problems).replace("give the whole answer again", "call the answer shape again");
  };
  return [
    shape(
      "comparison",
      Comparison,
      "Answer with a comparison table, ending the turn. Use when the person is weighing three or more options on the " +
        "same attributes (tools, plans, providers). Do the searches first; every cell should be backed by a source.",
      ((value: z.infer<typeof Comparison>) => quotesHold(value)) as Check,
    ),
    shape(
      "changes",
      Changes,
      "Answer with a what-changed report against an earlier answer, ending the turn. Use when the person asks whether " +
        "something you told them before is still true, or what changed since a date. Cover every option from the earlier " +
        "answer, one item per option with all its facts (not one item per attribute); leave `note` empty when nothing changed; " +
        "mark 'unverified' honestly when the search could not confirm it either way.",
      ((value: z.infer<typeof Changes>) => evidenceProblem(value, sources()) ?? quotesHold(value)) as Check,
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

/**
 * What the agent remembers, gathered before the model sees the message.
 *
 * Memory is the harness's job here, not a tool. The brief says not to give the agent more than
 * web search, but that is not the only reason: a recall tool costs a model round trip (a second
 * or more) before the agent even knows whether there is anything to recall, and resolving
 * "last Tuesday" is arithmetic, not judgement. So the harness does the mechanical part on every
 * turn, in milliseconds (resolve the dates, read those days, match the topic) and hands the
 * model the result. The judgement, what the person meant and whether it is still true, stays
 * with the model.
 */
import { dateIn, describeNow, isoDay, resolveTimeRefs, type TimeRef } from "../domain/time.ts";
import type { Activity, Claim, TurnRecord } from "../domain/memory.ts";
import type { MemoryStore } from "../ports/memory.ts";

/** Words that point at an earlier conversation even without a date. */
const LOOKS_BACK =
  /\bremind me\b|\bwhat did (?:i|we|you)\b|\bwe were\b|\bwere we\b|\bthe other day\b|\bagain\b|\b(?:i|we)\s+(?:was|were)\s+(?:looking|asking|talking|comparing)\b|\b(?:i|we)\s+(?:asked|said|discussed|talked|shortlisted|looked|compared|decided|mentioned|chose|picked)\b|\byou\s+(?:said|told|recommended|suggested|answered|mentioned|found)\b|\b(?:earlier|last time|previous(?:ly)?|remember|since then|still (?:correct|true|accurate|right|valid)|changed since|before)\b/i;

const STOP = new Set(
  "the a an and or but if then than that this these those what which who whom whose when where why how is are was were be been being do does did have has had i you we they he she it my your our their me us them to of in on at by for with from about into over after before since again still any some all most more less very just also can could would should will shall may might must not no yes there here its it's i'm you're we're last week month day today yesterday monday tuesday wednesday thursday friday saturday sunday january february march april may june july august september october november december asked ask said told tell answer answered correct right true changed change shipped anything something".split(
    " ",
  ),
);

export interface Recollection {
  /** The text block placed before the person's message. */
  context: string;
  /** What to show on screen ("Looked back at Tue 3 Nov: 2 exchanges"). */
  activity: Activity[];
  /** The person is looking back at earlier answers that stated facts: a re-check. */
  recheck: boolean;
  /** Those facts, with where each came from, for planning the re-check. */
  claims: Claim[];
}

export class RecallService {
  constructor(private readonly store: MemoryStore) {}

  recall(message: string, conversationId: string, now: Date, tz: string): Recollection {
    const refs = resolveTimeRefs(message, now, tz);
    const looksBack = refs.length > 0 || LOOKS_BACK.test(message);
    const lines = [`Now: ${describeNow(now, tz)} (${tz}).`];
    const activity: Activity[] = [];

    // The topic search runs on every message: it costs milliseconds, and a regex deciding whether a
    // message "looks back" will miss phrasings. When the message does not look back, only strong
    // matches are kept, so an ordinary question is not padded with loosely related history.
    const terms = topicTerms(message);
    if (!looksBack) {
      const strong = terms.length
        ? this.store.searchTurns(terms, 3, conversationId).filter((t) => overlap(t, terms) >= Math.min(2, terms.length))
        : [];
      if (!strong.length) return { context: wrap(lines), activity, recheck: false, claims: [] };
    }

    const chosen = new Map<string, TurnRecord>();
    const keep = (turns: TurnRecord[]) => turns.forEach((t) => chosen.set(t.id, t));

    if (refs.length) {
      lines.push("", "Time references in this message:");
      for (const ref of refs) {
        lines.push(`- "${ref.phrase}" → ${ref.label}${ref.alternative ? ` (or ${ref.alternative.label}, if they meant the week before)` : ""}`);
        const primary = this.store.turnsBetween(ref.from, ref.to, 12);
        const other = ref.alternative ? this.store.turnsBetween(ref.alternative.from, ref.alternative.to, 12) : [];
        keep(primary);
        keep(other);
        activity.push(dayActivity(ref, primary.length, other.length, tz));
      }
    }

    // A named day that found something is the answer to "which conversation": topic matches on top
    // of it would add later, look-alike exchanges and the model may anchor on the wrong one.
    const datedHit = refs.length > 0 && chosen.size > 0;
    if (terms.length && !datedHit) {
      const matched = this.store
        .searchTurns(terms, 6, conversationId)
        .filter((t) => !chosen.has(t.id) && (looksBack || overlap(t, terms) >= Math.min(2, terms.length)));
      keep(matched);
      if (matched.length) activity.push({ kind: "recall", label: `Matched ${matched.length} earlier exchange${matched.length === 1 ? "" : "s"} by topic`, detail: terms.join(", ") });
    }

    const turns = [...chosen.values()].sort((a, b) => a.at.localeCompare(b.at)).slice(-12);
    const claims = groupBy(this.store.claimsFor(turns.map((t) => t.id)), (c) => c.turnId);

    if (turns.length) {
      activity.push({
        kind: "memory",
        exchanges: turns.map((t) => ({ at: t.at, question: t.question })),
        claims: turns.flatMap((t) => (claims.get(t.id) ?? []).map((c) => ({ subject: c.subject, value: c.value, at: c.observedAt }))),
      });
      lines.push("", "Earlier exchanges found in memory (oldest first):");
      for (const turn of turns) lines.push("", ...describeTurn(turn, conversationId, claims.get(turn.id) ?? [], tz));
    } else {
      lines.push("", "Memory: no earlier exchanges match this message. Do not invent one; say so and ask for what you need.");
    }

    const recent = this.store.conversations(12).filter((c) => c.id !== conversationId);
    if (recent.length) {
      lines.push("", "Recent conversations (for orientation):");
      for (const c of recent) lines.push(`- ${shortDate(c.createdAt, tz)}: ${c.title}`);
    }

    const stated = [...claims.values()].flat();
    return { context: wrap(lines), activity, recheck: looksBack && stated.length > 0, claims: stated };
  }
}

function dayActivity(ref: TimeRef, found: number, alternative: number, tz: string): Activity {
  const days = [ref, ...(ref.alternative ? [ref.alternative] : [])].map((span) => isoDay(dateIn(span.from, tz)));
  const count = (n: number) => (n ? `${n} exchange${n === 1 ? "" : "s"}` : "nothing");
  return {
    kind: "recall",
    label: `Looked back at ${ref.label}: ${count(found)}`,
    detail: ref.alternative ? `also ${ref.alternative.label}: ${count(alternative)}` : `"${ref.phrase}"`,
    days,
  };
}

function describeTurn(turn: TurnRecord, currentConversation: string, claims: Claim[], tz: string): string[] {
  const where = turn.conversationId === currentConversation ? " (earlier in this conversation)" : "";
  const out = [
    `[${longDate(turn.at, tz)}${where}]`,
    `Person asked: ${clip(turn.question, 400)}`,
    // Generous: a structured answer rendered as text is long, and clipping it drops whole options.
    `You answered: ${clip(turn.answerText, 4000)}`,
  ];
  if (claims.length) {
    out.push("Facts you stated then (re-check these if asked whether the answer still holds):");
    for (const c of claims.slice(0, 60)) {
      const where = c.sourceUrl ? ` (source: ${c.sourceUrl}${c.quote ? `, which said then: "${c.quote}"` : ""})` : "";
      out.push(`  - ${c.subject}: ${c.value}${where}`);
    }
  }
  return out;
}

/** How many of the message's topic words an earlier exchange contains. */
function overlap(turn: TurnRecord, terms: string[]): number {
  const text = `${turn.question} ${turn.answerText}`.toLowerCase();
  return terms.filter((t) => text.includes(t.length > 3 ? t.replace(/(?:es|s)$/, "") : t)).length;
}

export function topicTerms(message: string): string[] {
  const words = message.toLowerCase().match(/[a-z0-9][a-z0-9+.#-]*[a-z0-9+#]|[a-z0-9]/g) ?? [];
  return [...new Set(words.filter((w) => w.length >= 3 && !STOP.has(w) && !/^\d{1,2}(st|nd|rd|th)?$/.test(w)))].slice(0, 8);
}

const wrap = (lines: string[]) => `<context written-by="system">\n${lines.join("\n")}\n</context>`;
const clip = (text: string, n: number) => (text.length > n ? `${text.slice(0, n).trimEnd()}…` : text);

function longDate(iso: string, tz: string) {
  return new Date(iso).toLocaleString("en-GB", { timeZone: tz, weekday: "short", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}
function shortDate(iso: string, tz: string) {
  return new Date(iso).toLocaleDateString("en-GB", { timeZone: tz, weekday: "short", day: "numeric", month: "short" });
}

function groupBy<T>(items: T[], key: (t: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const item of items) out.set(key(item), [...(out.get(key(item)) ?? []), item]);
  return out;
}

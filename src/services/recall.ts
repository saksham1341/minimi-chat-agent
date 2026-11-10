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
  /\b(?:i|we)\s+(?:asked|said|discussed|talked|shortlisted|looked|compared|decided|mentioned|chose|picked)\b|\byou\s+(?:said|told|recommended|suggested|answered|mentioned|found)\b|\b(?:earlier|last time|previous(?:ly)?|remember|since then|still (?:correct|true|accurate|right|valid)|changed since|before)\b/i;

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
}

export class RecallService {
  constructor(private readonly store: MemoryStore) {}

  recall(message: string, conversationId: string, now: Date, tz: string): Recollection {
    const refs = resolveTimeRefs(message, now, tz);
    const looksBack = refs.length > 0 || LOOKS_BACK.test(message);
    const lines = [`Now: ${describeNow(now, tz)} (${tz}).`];
    const activity: Activity[] = [];

    if (!looksBack) return { context: wrap(lines), activity };

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

    const terms = topicTerms(message);
    if (terms.length) {
      const matched = this.store.searchTurns(terms, 6, conversationId).filter((t) => !chosen.has(t.id));
      keep(matched);
      if (matched.length) activity.push({ kind: "recall", label: `Matched ${matched.length} earlier exchange${matched.length === 1 ? "" : "s"} by topic`, detail: terms.join(", ") });
    }

    const turns = [...chosen.values()].sort((a, b) => a.at.localeCompare(b.at)).slice(-12);
    const claims = groupBy(this.store.claimsFor(turns.map((t) => t.id)), (c) => c.turnId);

    if (turns.length) {
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

    return { context: wrap(lines), activity };
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
    `You answered: ${clip(turn.answerText, 900)}`,
  ];
  if (claims.length) {
    out.push("Facts you stated then (re-check these if asked whether the answer still holds):");
    for (const c of claims.slice(0, 15)) out.push(`  - ${c.subject}: ${c.value}${c.sourceUrl ? ` (source: ${c.sourceUrl})` : ""}`);
  }
  return out;
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

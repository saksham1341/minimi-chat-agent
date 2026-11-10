/**
 * What the agent remembers, gathered before the model sees the message.
 *
 * Memory is the harness's job here, not a tool: a recall tool costs a model round trip before the
 * agent even knows whether there is anything to recall, and resolving "last Tuesday" is
 * arithmetic. So the harness does the mechanical part on every turn, in milliseconds, and hands the
 * model what it found. Nothing here guesses whether the person "means" to look back: there is no
 * trigger phrase list. Dates are resolved (a calculation, not a guess), and history is matched by
 * the words the message shares with it, weighted by how rare those words are, so a match on
 * "Pipedrive" counts and a match on "now" or "thing" cannot. Whether any of it matters to the
 * question is the model's judgement.
 */
import { dateIn, describeNow, isoDay, resolveTimeRefs, type TimeRef } from "../domain/time.ts";
import type { Activity, Claim, TurnRecord } from "../domain/memory.ts";
import type { MemoryStore } from "../ports/memory.ts";

/** Grammar, not topic. Rarity does the rest of the filtering. */
const STOP = new Set(
  "the a an and or but if then than that this these those what which who whom whose when where why how is are was were be been being do does did have has had i you we they he she it my your our their me us them to of in on at by for with from about into over after before since again still any some all most more less very just also can could would should will shall may might must not no yes there here its it's i'm you're we're now need needs per one back end thing things stuff get got make made want wanted know think way lot ask asked asking said say told tell answer answered".split(
    " ",
  ),
);

/** A word counts as a topic signal if at most this share of past exchanges contain it. */
const RARE_SHARE = 0.2;

export interface Recollection {
  /** The text block placed before the person's message. */
  context: string;
  /** What to show on screen ("Looked back at Tue 3 Nov: 2 exchanges"). */
  activity: Activity[];
  /** Facts stated in the recalled exchanges, with where each came from. */
  claims: Claim[];
  /**
   * The facts worth reading ahead for: from the named day's exchanges that share a topic word with
   * the message, or all of that day's if the message names no topic ("still correct?").
   */
  readAhead: Claim[];
  /** How the memory was found: by a named day, by shared rare words, or not at all. */
  found: "dated" | "topic" | "none";
  /**
   * Found by a named day: the person is pointing at a particular earlier conversation, which is
   * worth reading ahead for. Memory found by shared words goes to the model as context only.
   */
  strong: boolean;
}

export class RecallService {
  constructor(private readonly store: MemoryStore) {}

  recall(message: string, conversationId: string, now: Date, tz: string): Recollection {
    const refs = resolveTimeRefs(message, now, tz);
    const lines = [`Now: ${describeNow(now, tz)} (${tz}).`];
    const activity: Activity[] = [];
    const chosen = new Map<string, TurnRecord>();
    const keep = (turns: TurnRecord[]) => turns.forEach((t) => chosen.set(t.id, t));
    // Memory never reaches past the agent's own clock.
    const until = (to: Date) => (to.getTime() < now.getTime() ? to : now);

    if (refs.length) {
      lines.push("", "Time references in this message:");
      for (const ref of refs) {
        lines.push(`- "${ref.phrase}" → ${ref.label}${ref.alternative ? ` (or ${ref.alternative.label}, if they meant the week before)` : ""}`);
        const primary = this.store.turnsBetween(ref.from, until(ref.to), 12);
        const other = ref.alternative ? this.store.turnsBetween(ref.alternative.from, until(ref.alternative.to), 12) : [];
        keep(primary);
        keep(other);
        activity.push(dayActivity(ref, primary.length, other.length, tz));
      }
    }

    // A named day that found something is the answer to "which conversation": look-alike
    // exchanges from other days on top of it could make the model anchor on the wrong one.
    const dated = chosen.size > 0;
    let topical = 0;
    if (!dated) {
      const rare = this.rareTerms(topicTerms(message), now);
      if (rare.length) {
        const need = Math.min(2, rare.length);
        const matched = this.store.searchTurns(rare, 6, conversationId, now).filter((t) => overlap(t, rare) >= need);
        keep(matched);
        topical = matched.length;
        if (matched.length) activity.push({ kind: "recall", label: `Matched ${matched.length} earlier exchange${matched.length === 1 ? "" : "s"} by topic`, detail: rare.join(", ") });
      }
    }

    if (!chosen.size && !refs.length) return { context: wrap(lines), activity, claims: [], readAhead: [], found: "none", strong: false };

    const turns = [...chosen.values()].sort((a, b) => a.at.localeCompare(b.at)).slice(-12);
    const claims = groupBy(this.store.claimsFor(turns.map((t) => t.id)), (c) => c.turnId);

    // A named day with nothing on it is said plainly, whatever else turned up.
    if (refs.length && !dated) {
      lines.push("", "Memory: no earlier exchanges on those days. Do not invent one; say so plainly.");
    }

    if (turns.length) {
      activity.push({
        kind: "memory",
        exchanges: turns.map((t) => ({ at: t.at, question: t.question })),
        claims: turns.flatMap((t) => (claims.get(t.id) ?? []).map((c) => ({ subject: c.subject, value: c.value, at: c.observedAt }))),
      });
      lines.push(
        "",
        dated
          ? "Earlier exchanges from those days (oldest first):"
          : refs.length
            ? "Exchanges from other days that share the message's topic; they may be what the person means, or not (oldest first):"
            : "Earlier exchanges that share the message's topic (oldest first). Use them only if the message is about them:",
      );
      for (const turn of turns) lines.push("", ...describeTurn(turn, conversationId, claims.get(turn.id) ?? [], tz));
    } else if (refs.length) {
      lines.push("Ask for what you need to answer.");
    }

    const recent = this.store.conversations(12).filter((c) => c.id !== conversationId && c.createdAt <= now.toISOString());
    if (recent.length && refs.length) {
      lines.push("", "Recent conversations (for orientation):");
      for (const c of recent) lines.push(`- ${shortDate(c.createdAt, tz)}: ${c.title}`);
    }

    const words = topicTerms(message);
    const onTopic = dated ? turns.filter((t) => !words.length || overlap(t, words) > 0) : [];
    return {
      context: wrap(lines),
      activity,
      claims: [...claims.values()].flat(),
      readAhead: onTopic.flatMap((t) => claims.get(t.id) ?? []),
      found: dated ? "dated" : topical ? "topic" : "none",
      strong: dated,
    };
  }

  /** The message's words that are rare in past exchanges: the ones a match on means something. */
  private rareTerms(terms: string[], now: Date): string[] {
    const total = this.store.turnCount(now);
    if (!total) return [];
    // In a short history every word looks rare; until there is enough of it, only a word seen once
    // (a product name, usually) counts.
    const ceiling = total < 30 ? 1 : Math.floor(total * RARE_SHARE);
    return terms.filter((t) => {
      const df = this.store.documentFrequency(t, now);
      return df > 0 && df <= ceiling;
    });
  }
}

function dayActivity(ref: TimeRef, found: number, alternative: number, tz: string): Activity {
  const count = (n: number) => (n ? `${n} exchange${n === 1 ? "" : "s"}` : "nothing");
  const days = [ref, ...(ref.alternative ? [ref.alternative] : [])].map((span) => isoDay(dateIn(span.from, tz)));
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

/** How many of the given words an earlier exchange contains (on a crude stem). */
function overlap(turn: TurnRecord, terms: string[]): number {
  const text = `${turn.question} ${turn.answerText}`.toLowerCase();
  return terms.filter((t) => text.includes(t.length > 3 ? t.replace(/(?:es|s)$/, "") : t)).length;
}

export function topicTerms(message: string): string[] {
  const words = message.toLowerCase().match(/[a-z0-9][a-z0-9+.#-]*[a-z0-9+#]|[a-z0-9]/g) ?? [];
  return [...new Set(words.filter((w) => w.length >= 3 && !STOP.has(w) && !/^\d{1,2}(st|nd|rd|th)?$/.test(w)))].slice(0, 10);
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

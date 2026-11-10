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
import { addDays, dateIn, dayLabel, daysBetween, dayWords, describeNow, isoDay, startOfDay, weekday, type DayWords, type Ymd } from "../domain/time.ts";
import type { Activity, Claim, TurnRecord } from "../domain/memory.ts";
import type { MemoryStore } from "../ports/memory.ts";

/** Grammar, not topic. Rarity does the rest of the filtering. */
const STOP = new Set(
  "the a an and or but if then than that this these those what which who whom whose when where why how is are was were be been being do does did have has had i you we they he she it my your our their me us them to of in on at by for with from about into over after before since again still any some all most more less very just also can could would should will shall may might must not no yes there here its it's i'm you're we're now need needs per one back end thing things stuff get got make made want wanted know think way lot ask asked asking said say told tell answer answered".split(
    " ",
  ),
);

/** A word counts as a topic signal if at most this share of past exchanges contain it (with enough history). */
const RARE_SHARE = 0.2;

export interface MemoryPreview {
  day: string; // YYYY-MM-DD
  label: string; // "Mon, 9 Nov 2026"
  /** Matched by the day's own words ("on Monday"), not only by topic. */
  byDay: boolean;
  questions: string[];
}

export interface Recollection {
  /** The text block placed before the person's message. */
  context: string;
  /** What to show on screen ("Found 1 exchange from Tue 3 Nov"). */
  activity: Activity[];
  /** Facts stated in the recalled exchanges, with where each came from. */
  claims: Claim[];
  /**
   * The facts worth reading ahead for: from exchanges the message points at by their day, that
   * also share its topic (or all of them, if the message names no topic: "still correct?").
   */
  readAhead: Claim[];
  /** How the memory was found: by its day's words, by shared rare words, or not at all. */
  found: "dated" | "topic" | "none";
}

/** How far back day words are matched; older exchanges are found by topic only. */
const WINDOW_DAYS = 120;
const CALENDAR_WEEKS = 3;

interface Scored {
  turn: TurnRecord;
  date: number;
  topic: number;
  score: number;
}

export class RecallService {
  constructor(private readonly store: MemoryStore) {}

  /**
   * What the message matches, for showing as the person types: the same matching the real turn
   * uses, so the preview is what the agent will see. Costs a few milliseconds and nothing else.
   */
  preview(message: string, conversationId: string, now: Date, tz: string): MemoryPreview[] {
    const { kept } = this.match(message, conversationId, now, tz);
    const byDay = groupBy(kept, (k) => isoDay(dateIn(new Date(k.turn.at), tz)));
    return [...byDay.entries()].map(([day, group]) => ({
      day,
      label: dayLabel(ymdOf(day)),
      byDay: group.some((k) => k.date >= 1),
      questions: [...new Set(group.map((k) => k.turn.question))].slice(0, 3),
    }));
  }

  recall(message: string, conversationId: string, now: Date, tz: string): Recollection {
    const today = dateIn(now, tz);
    const topics = topicTerms(message);
    const lines = [`Now: ${describeNow(now, tz)} (${tz}).`];
    const activity: Activity[] = [];
    const { kept, recent } = this.match(message, conversationId, now, tz);
    const dated = kept.filter((k) => k.date >= 1);

    // The calendar, so the model reads which day is meant instead of working it out.
    lines.push("", ...calendar(today, tz, recent));
    return this.describe(conversationId, tz, topics, lines, activity, kept, dated);
  }

  private match(message: string, conversationId: string, now: Date, tz: string): { kept: Scored[]; recent: TurnRecord[] } {
    const today = dateIn(now, tz);
    const words = new Set(tokens(message));
    const rare = this.rareTerms(topicTerms(message), now);

    // Candidates: everything recent (to match on day words), plus older exchanges on the topic.
    const recent = this.store.turnsBetween(startOfDay(addDays(today, -WINDOW_DAYS), tz), now, 500);
    const older = rare.length ? this.store.searchTurns(rare, 8, conversationId, now) : [];
    const candidates = new Map([...recent, ...older].map((t) => [t.id, t]));

    // One shared word is enough only when it is distinctive as written (a name or acronym the
    // person capitalised mid-sentence: "CRMs", "Neon"); otherwise two shared rare words are needed.
    const names = rare.filter((t) => writtenAsName(message, t));
    const scored: Scored[] = [];
    for (const turn of candidates.values()) {
      const day = dateIn(new Date(turn.at), tz);
      const date = dayMatch(dayWords(day, today), words);
      // Exchanges earlier in this conversation are already in the transcript; only a day named
      // in the message brings them back here.
      const topic = turn.conversationId === conversationId ? 0 : overlap(turn, rare);
      const strongTopic = topic >= 2 || (topic === 1 && overlap(turn, names) === 1);
      if (date < 1 && !strongTopic) continue;
      const age = daysBetween(day, today);
      scored.push({ turn, date, topic, score: date + 0.8 * topic + 0.1 * Math.max(0, 1 - age / WINDOW_DAYS) });
    }
    scored.sort((a, b) => b.score - a.score);
    return { kept: scored.slice(0, 10), recent };
  }

  private describe(
    conversationId: string,
    tz: string,
    topics: string[],
    lines: string[],
    activity: Activity[],
    kept: Scored[],
    dated: Scored[],
  ): Recollection {

    if (kept.length) {
      const byDay = groupBy(kept, (k) => isoDay(dateIn(new Date(k.turn.at), tz)));
      for (const [day, group] of byDay) {
        const n = group.length;
        const datedHere = group.some((k) => k.date >= 1);
        activity.push({
          kind: "recall",
          label: `${datedHere ? "Looked back at" : "Matched by topic:"} ${dayLabel(ymdOf(day))}: ${n} exchange${n === 1 ? "" : "s"}`,
          ...(datedHere ? { days: [day] } : {}),
        });
      }
    }

    if (!kept.length) return { context: wrap(lines), activity, claims: [], readAhead: [], found: "none" };

    const turns = kept.map((k) => k.turn).sort((a, b) => a.at.localeCompare(b.at));
    const claims = groupBy(this.store.claimsFor(turns.map((t) => t.id)), (c) => c.turnId);
    activity.push({
      kind: "memory",
      exchanges: turns.map((t) => ({ at: t.at, question: t.question })),
      claims: turns.flatMap((t) => (claims.get(t.id) ?? []).map((c) => ({ subject: c.subject, value: c.value, at: c.observedAt }))),
    });
    lines.push("", "Earlier exchanges that match the message, by its day or its topic (oldest first). Use them only if the message is about them:");
    for (const turn of turns) lines.push("", ...describeTurn(turn, conversationId, claims.get(turn.id) ?? [], tz));

    const onTopic = dated.filter((k) => !topics.length || overlap(k.turn, topics) > 0);
    return {
      context: wrap(lines),
      activity,
      claims: [...claims.values()].flat(),
      readAhead: onTopic.flatMap((k) => claims.get(k.turn.id) ?? []),
      found: dated.length ? "dated" : "topic",
    };
  }

  /** The message's words that are rare in past exchanges: the ones a match on means something. */
  private rareTerms(terms: string[], now: Date): string[] {
    const total = this.store.turnCount(now);
    if (!total) return [];
    // In a short history every word looks rare; until there is enough of it, only a word seen
    // once (a product name, usually) counts.
    const ceiling = total < 30 ? 1 : Math.floor(total * RARE_SHARE);
    return terms.filter((t) => {
      const df = this.store.documentFrequency(t, now);
      return df > 0 && df <= ceiling;
    });
  }
}

/**
 * How strongly the message names this day, by the words it shares with it. A weekday, a month
 * with its day number, or a relative phrase that holds for it ("yesterday", "last week") each
 * count fully; a month alone a little; a bare number nothing ("5 tools" is not the 5th).
 */
function dayMatch(day: DayWords, words: Set<string>): number {
  const has = (w: string) => words.has(w) || words.has(w.slice(0, 3));
  let score = 0;
  if (has(day.weekday)) score += 1;
  const month = has(day.month);
  if (month && words.has(day.day)) score += 1.2;
  else if (month) score += 0.3;
  if (day.relative.length && day.relative.every((w) => words.has(w))) score += 1;
  return score;
}

/** The last few weeks as the person would see them on a wall calendar, with what was asked when. */
function calendar(today: Ymd, tz: string, turns: TurnRecord[]): string[] {
  const titles = groupBy(turns, (t) => isoDay(dateIn(new Date(t.at), tz)));
  const monday = addDays(today, -((weekday(today) + 6) % 7));
  const out = [`Calendar (today is ${dayLabel(today)}):`];
  for (let w = CALENDAR_WEEKS - 1; w >= 0; w--) {
    const start = addDays(monday, -7 * w);
    const cells: string[] = [];
    for (let d = 0; d < 7; d++) {
      const day = addDays(start, d);
      if (daysBetween(day, today) < 0) break;
      const here = titles.get(isoDay(day)) ?? [];
      const asked = [...new Set(here.map((t) => clip(t.question, 50)))].slice(0, 3);
      cells.push(`${dayLabel(day).split(" ").slice(0, 3).join(" ")}${asked.length ? ` (${asked.map((q) => `"${q}"`).join("; ")})` : ""}`);
    }
    out.push(`- ${cells.join(" · ")}`);
  }
  return out;
}

const ymdOf = (iso: string): Ymd => {
  const [y, m, d] = iso.split("-").map(Number);
  return { y, m, d };
};

/** Did the person write this word with a capital somewhere other than at the start of a sentence? */
function writtenAsName(message: string, term: string): boolean {
  return [...message.matchAll(/[A-Za-z0-9][\w.'-]*/g)].some(
    (m) => m[0].toLowerCase().startsWith(term) && /[A-Z]/.test(m[0]) && !/(?:^|[.!?]\s+)$/.test(message.slice(0, m.index)),
  );
}

/** Words as written, kept whole ("monday.com" is one word, not Monday); ordinals as numbers. */
function tokens(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+(?:[.'-][a-z0-9]+)*/g) ?? []).map((t) => t.replace(/^(\d+)(?:st|nd|rd|th)$/, "$1"));
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

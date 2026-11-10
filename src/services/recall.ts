/**
 * Which earlier exchange a message means, worked out in software before the model is called, from
 * metadata a model wrote.
 *
 *   days     every past day's names are generated from the calendar (`domain/calendar.ts`) and
 *            looked for in the message: nothing parses the message
 *   topics   every exchange carries the terms its answering model wrote for it (entities, topics
 *            and the ways people say them: "db hosts" for Postgres hosting). The message's own
 *            word sequences are matched against those terms. A term most exchanges carry says
 *            little and does not count
 *   verdict  each candidate gets a confidence (high: its day and its topic; medium: one of them
 *            precisely; low: less), and the context says which is most likely and which merely
 *            possible. The calendar shows how much was said on each day, never what, so a title
 *            cannot be mistaken for a memory
 *   baseline the facts an exchange originally stated, with their quotes, are its "before"; what
 *            later re-checks observed is listed apart, with dates, and is never the baseline
 *
 * Whether any of it matters to the question is still the model's judgement.
 */
import { namedDays } from "../domain/calendar.ts";
import type { Activity, Claim, TurnRecord } from "../domain/memory.ts";
import { phrases } from "../domain/text.ts";
import { addDays, dateIn, dayLabel, daysBetween, describeNow, isoDay, startOfDay, weekday, type Ymd } from "../domain/time.ts";
import type { MemoryStore } from "../ports/memory.ts";

/** How far back a day can be named; older exchanges are found by topic. */
const WINDOW_DAYS = 60;
const CALENDAR_WEEKS = 3;
/** How many matched exchanges a re-check measures against. */
const MAX_BASELINE = 2;
/** A term carried by more than this share of exchanges is too common to point at one. */
const COMMON_SHARE = 0.3;

export type Confidence = "high" | "medium" | "low";

export interface MemoryPreview {
  day: string; // YYYY-MM-DD
  label: string; // "Mon, 9 Nov 2026"
  /** Matched by the day's own name ("on Monday"), not only by topic. */
  byDay: boolean;
  confidence: Confidence;
  questions: string[];
}

export interface Recollection {
  /** The text block placed before the person's message. */
  context: string;
  /** What to show on screen. */
  activity: Activity[];
  /** The original facts of the exchanges the message most likely means: what a re-check measures against. */
  baseline: Claim[];
  confidence: Confidence | "none";
}

interface Candidate {
  turn: TurnRecord;
  day: Ymd;
  /** How precisely the message names this exchange's day (0 if it does not). */
  dayStrength: number;
  dayPhrase?: string;
  /** The exchange's own terms the message used. */
  terms: string[];
  confidence: Confidence;
}

export class RecallService {
  constructor(private readonly store: MemoryStore) {}

  /** What a draft will recall, for showing as the person types. The same matching; a few ms. */
  preview(message: string, conversationId: string, now: Date, tz: string): MemoryPreview[] {
    const { candidates } = this.resolve(message, conversationId, now, tz);
    return [...group(candidates, (c) => isoDay(c.day)).entries()].map(([day, members]) => ({
      day,
      label: dayLabel(members[0].day),
      byDay: members.some((c) => c.dayStrength > 0),
      confidence: best(members.map((c) => c.confidence)),
      questions: [...new Set(members.map((c) => c.turn.question))].slice(0, 3),
    }));
  }

  recall(message: string, conversationId: string, now: Date, tz: string): Recollection {
    const today = dateIn(now, tz);
    const { candidates, named, recent } = this.resolve(message, conversationId, now, tz);
    const lines = [`Now: ${describeNow(now, tz)} (${tz}).`, "", ...calendar(today, tz, recent)];
    const activity: Activity[] = [];

    for (const n of named.filter((n) => n.strength >= 0.8)) {
      if (!candidates.some((c) => isoDay(c.day) === isoDay(n.day))) {
        lines.push("", `Nothing was asked on ${dayLabel(n.day)} (the message's "${n.phrase}"). If that is the day they mean, say so plainly; do not invent it.`);
      }
    }
    if (!candidates.length) {
      if (named.length) activity.push({ kind: "recall", label: `Looked back: nothing on ${named.slice(0, 2).map((n) => dayLabel(n.day)).join(" or ")}` });
      return { context: wrap(lines), activity, baseline: [], confidence: "none" };
    }

    const turns = candidates.map((c) => c.turn);
    const claims = group(this.store.claimsFor(turns.map((t) => t.id)), (c) => c.turnId);
    const cards = this.store.cardsFor(turns.map((t) => t.id));
    const top = best(candidates.map((c) => c.confidence));
    const likely = candidates.filter((c) => c.confidence === top);
    const possible = candidates.filter((c) => c.confidence !== top);

    lines.push("", `Most likely meant (${top} confidence):`);
    for (const c of likely) lines.push("", ...describe(c, claims.get(c.turn.id) ?? [], cards.get(c.turn.id), now, tz));
    if (possible.length) {
      lines.push("", "Also possible, less likely:");
      for (const c of possible) lines.push("", ...describe(c, claims.get(c.turn.id) ?? [], cards.get(c.turn.id), now, tz));
    }

    // Later observations, kept apart from the baseline and dated.
    const since = likely.map((c) => c.turn.at).sort()[0];
    const later = this.store.claimsFor(this.store.turnsBetween(new Date(since), now, 50).map((t) => t.id)).filter((c) => c.origin === "observed");
    if (later.length) {
      lines.push("", "Checked again since (later observations, not what you originally said):");
      for (const c of later.slice(0, 20)) lines.push(`  - ${shortDate(c.observedAt, tz)}: ${c.subject}: ${c.value}`);
    }

    for (const [day, members] of group(candidates, (c) => isoDay(c.day))) {
      const dated = members.some((c) => c.dayStrength > 0);
      activity.push({
        kind: "recall",
        label: `${dated ? "Looked back at" : "Matched by topic:"} ${dayLabel(members[0].day)}: ${members.length} exchange${members.length === 1 ? "" : "s"}, ${best(members.map((c) => c.confidence))} confidence`,
        ...(dated ? { days: [day] } : {}),
      });
    }
    // What a re-check measures against: the best one or two matches, not every exchange of a busy day.
    const baseline = likely.slice(0, MAX_BASELINE).flatMap((c) => (claims.get(c.turn.id) ?? []).filter((x) => x.origin === "stated"));
    activity.push({
      kind: "memory",
      exchanges: turns.map((t) => ({ at: t.at, question: t.question })),
      claims: baseline.map((x) => ({ subject: x.subject, value: x.value, at: x.observedAt })),
    });
    return { context: wrap(lines), activity, baseline, confidence: top };
  }

  private resolve(message: string, conversationId: string, now: Date, tz: string) {
    const today = dateIn(now, tz);
    const said = phrases(message, 6);
    const named = namedDays(said, today, WINDOW_DAYS);
    const recent = this.store.turnsBetween(startOfDay(addDays(today, -WINDOW_DAYS), tz), now, 500);

    // Topic: the message's word sequences that are some exchange's terms, and specific enough.
    const total = Math.max(1, this.store.turnCount(now));
    const frequency = this.store.termFrequency([...said], now);
    const specific = [...frequency.entries()].filter(([, n]) => n <= Math.max(2, total * COMMON_SHARE)).map(([term]) => term);
    const byTerm = this.store.turnsWithTerms(specific, now, 200);

    const byDay = new Map(named.map((n) => [isoDay(n.day), n]));
    const ids = new Set<string>(byTerm.keys());
    for (const t of recent) if (byDay.has(isoDay(dateIn(new Date(t.at), tz)))) ids.add(t.id);

    const candidates: Candidate[] = [];
    for (const turn of this.store.turnsByIds([...ids])) {
      if (turn.conversationId === conversationId) continue; // already in the transcript
      const day = dateIn(new Date(turn.at), tz);
      const n = byDay.get(isoDay(day));
      const terms = byTerm.get(turn.id) ?? [];
      // A phrase of several words ("db hosts") says more than one word ("neon").
      const weight = terms.reduce((sum, t) => sum + (t.includes(" ") ? 1.5 : 1), 0);
      const confidence: Confidence =
        n && n.strength >= 0.8 && weight > 0 ? "high" : (n && n.strength >= 0.9) || weight >= 1.5 || (n && weight > 0) ? "medium" : "low";
      candidates.push({ turn, day, dayStrength: n?.strength ?? 0, dayPhrase: n?.phrase, terms, confidence });
    }
    // Within a named day, the topic decides: when some of that day's exchanges match it, the others
    // were merely asked the same day. When none does and the day was busy, which one is meant is a guess.
    for (const [, members] of group(candidates.filter((c) => c.dayStrength > 0), (c) => isoDay(c.day))) {
      const onTopic = members.some((c) => c.terms.length > 0);
      for (const c of members) {
        if (onTopic && !c.terms.length) candidates.splice(candidates.indexOf(c), 1);
        else if (!onTopic && members.length > 2) c.confidence = "low";
      }
    }
    const rank = { high: 3, medium: 2, low: 1 };
    candidates.sort((a, b) => rank[b.confidence] - rank[a.confidence] || b.terms.length - a.terms.length || b.turn.at.localeCompare(a.turn.at));
    return { candidates: candidates.slice(0, 10), named, recent };
  }
}

function describe(c: Candidate, claims: Claim[], card: { kind: string; summary: string } | undefined, now: Date, tz: string): string[] {
  const why = [c.dayPhrase && `"${c.dayPhrase}" names that day`, c.terms.length && `it was about ${c.terms.map((t) => `"${t}"`).join(", ")}`]
    .filter(Boolean)
    .join("; ");
  const out = [
    `[${longDate(c.turn.at, tz)}, ${ago(c.turn.at, now)}] matched because ${why || "of its day"}.`,
    ...(card?.summary ? [`In short: ${card.summary}`] : []),
    `Person asked: ${clip(c.turn.question, 400)}`,
    `You answered: ${clip(c.turn.answerText, 4000)}`,
  ];
  const stated = claims.filter((x) => x.origin === "stated");
  if (stated.length) {
    out.push("Facts you stated then (the baseline for any re-check):");
    for (const x of stated.slice(0, 60)) {
      const where = x.sourceUrl ? ` (source: ${x.sourceUrl}${x.quote ? `, which said then: "${x.quote}"` : ""})` : "";
      out.push(`  - ${x.subject}: ${x.value}${where}`);
    }
  }
  return out;
}

/** The last few weeks as a wall calendar: how much was asked on each day, not what. */
function calendar(today: Ymd, tz: string, turns: TurnRecord[]): string[] {
  const counts = new Map<string, number>();
  for (const t of turns) {
    const day = isoDay(dateIn(new Date(t.at), tz));
    counts.set(day, (counts.get(day) ?? 0) + 1);
  }
  const monday = addDays(today, -((weekday(today) + 6) % 7));
  const out = [`Calendar (today is ${dayLabel(today)}; how many exchanges each day had, not what they were):`];
  for (let w = CALENDAR_WEEKS - 1; w >= 0; w--) {
    const cells: string[] = [];
    for (let d = 0; d < 7; d++) {
      const day = addDays(monday, d - 7 * w);
      if (daysBetween(day, today) < 0) break;
      const n = counts.get(isoDay(day)) ?? 0;
      cells.push(`${dayLabel(day).split(" ").slice(0, 3).join(" ")}${n ? ` (${n})` : ""}`);
    }
    out.push(`- ${cells.join(" · ")}`);
  }
  return out;
}

const best = (levels: Confidence[]): Confidence => (levels.includes("high") ? "high" : levels.includes("medium") ? "medium" : "low");
const wrap = (lines: string[]) => `<context written-by="system">\n${lines.join("\n")}\n</context>`;
const clip = (text: string, n: number) => (text.length > n ? `${text.slice(0, n).trimEnd()}…` : text);

function longDate(iso: string, tz: string) {
  return new Date(iso).toLocaleString("en-GB", { timeZone: tz, weekday: "short", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}
/** "4 minutes ago", "3 hours ago", "6 days ago": so nobody has to estimate it. */
export function ago(iso: string, now: Date): string {
  const minutes = Math.max(0, Math.round((now.getTime() - new Date(iso).getTime()) / 60_000));
  const [n, unit] = minutes < 60 ? [minutes, "minute"] : minutes < 48 * 60 ? [Math.round(minutes / 60), "hour"] : [Math.round(minutes / 1440), "day"];
  return n === 0 ? "just now" : `${n} ${unit}${n === 1 ? "" : "s"} ago`;
}
function shortDate(iso: string, tz: string) {
  return new Date(iso).toLocaleDateString("en-GB", { timeZone: tz, weekday: "short", day: "numeric", month: "short" });
}

function group<T>(items: T[], key: (t: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const item of items) out.set(key(item), [...(out.get(key(item)) ?? []), item]);
  return out;
}

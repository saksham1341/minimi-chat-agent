/**
 * The calendar, in the person's time zone.
 *
 * No parsing of time phrases happens here or anywhere else: there is no grammar for "last Monday".
 * Instead every day is described in the words people use for it (its weekday, month and day
 * number, and how it stands relative to today), and earlier exchanges are found by matching those
 * words against the message like any other text (`services/recall.ts`). Which Monday the person
 * means, when it is ambiguous, is the model's reading of the calendar it is shown.
 */

export interface Ymd {
  y: number;
  m: number; // 1-12
  d: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(tz: string) {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric",
    });
    formatters.set(tz, f);
  }
  return f;
}

function wallClock(date: Date, tz: string) {
  const parts = Object.fromEntries(formatter(tz).formatToParts(date).map((p) => [p.type, p.value]));
  return { y: +parts.year, m: +parts.month, d: +parts.day, h: +parts.hour, mi: +parts.minute, s: +parts.second };
}

/** The calendar date it is in `tz` at `date`. */
export function dateIn(date: Date, tz: string): Ymd {
  const { y, m, d } = wallClock(date, tz);
  return { y, m, d };
}

function offsetMs(date: Date, tz: string): number {
  const w = wallClock(date, tz);
  return Date.UTC(w.y, w.m - 1, w.d, w.h, w.mi, w.s) - Math.floor(date.getTime() / 1000) * 1000;
}

/** The instant a calendar day starts in `tz` (handles DST by re-checking the offset). */
export function startOfDay(day: Ymd, tz: string): Date {
  const guess = Date.UTC(day.y, day.m - 1, day.d);
  let t = guess - offsetMs(new Date(guess), tz);
  const again = guess - offsetMs(new Date(t), tz);
  if (again !== t) t = again;
  return new Date(t);
}

export function addDays(day: Ymd, n: number): Ymd {
  const t = new Date(Date.UTC(day.y, day.m - 1, day.d + n));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

export function weekday(day: Ymd): number {
  return new Date(Date.UTC(day.y, day.m - 1, day.d)).getUTCDay();
}

export function dayLabel(day: Ymd): string {
  return new Date(Date.UTC(day.y, day.m - 1, day.d)).toLocaleDateString("en-GB", {
    timeZone: "UTC", weekday: "short", day: "numeric", month: "short", year: "numeric",
  });
}

export function isoDay(day: Ymd): string {
  return `${day.y}-${String(day.m).padStart(2, "0")}-${String(day.d).padStart(2, "0")}`;
}

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

/** Whole days from `a` to `b` (positive when `b` is later). */
export function daysBetween(a: Ymd, b: Ymd): number {
  return Math.round((Date.UTC(b.y, b.m - 1, b.d) - Date.UTC(a.y, a.m - 1, a.d)) / 86_400_000);
}

export interface DayWords {
  weekday: string; // "monday"
  month: string; // "november"
  day: string; // "3"
  /** How the day stands to today, in the words people use: "today", "yesterday", "this week", "last week". */
  relative: string[];
}

/** The words a day goes by, seen from `today`. */
export function dayWords(day: Ymd, today: Ymd): DayWords {
  const ago = daysBetween(day, today);
  const sinceMonday = (weekday(today) + 6) % 7;
  const relative =
    ago === 0 ? ["today"] : ago === 1 ? ["yesterday"] : ago <= sinceMonday ? ["this", "week"] : ago <= sinceMonday + 7 ? ["last", "week"] : [];
  return { weekday: WEEKDAYS[weekday(day)], month: MONTHS[day.m - 1], day: String(day.d), relative };
}

/** "Tuesday 10 November 2026, 14:03" in `tz`, for telling the model what time it is. */
export function describeNow(now: Date, tz: string): string {
  return now.toLocaleString("en-GB", {
    timeZone: tz, weekday: "long", day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit",
  });
}

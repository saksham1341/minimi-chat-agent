/**
 * Turning "on Monday", "3 November" and "last Tuesday" into instants, in the person's time zone.
 *
 * This is code, not a model call, on purpose. It is the part of a memory question that has
 * exactly one right answer given a clock and a zone, it runs in microseconds on every turn, and
 * when it is wrong a test can say so. What the model is left to judge is what the person meant
 * by it once the dates are on the table.
 *
 * Everything is biased to the past: these phrases point at earlier conversations. Where a phrase
 * has two common readings ("last Monday" said on a Wednesday) both are returned, the nearer one
 * first, and the model is told it is ambiguous.
 */

export interface Ymd {
  y: number;
  m: number; // 1-12
  d: number;
}

export interface Span {
  label: string;
  from: Date;
  to: Date; // exclusive
}

export interface TimeRef extends Span {
  phrase: string;
  /** The other common reading, when there is one. */
  alternative?: Span;
}

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};
const MONTH = "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
const NUMBERS: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };

// ---- calendar arithmetic in a zone -------------------------------------------------------------

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

const before = (a: Ymd, b: Ymd) => Date.UTC(a.y, a.m - 1, a.d) < Date.UTC(b.y, b.m - 1, b.d);

export function dayLabel(day: Ymd): string {
  return new Date(Date.UTC(day.y, day.m - 1, day.d)).toLocaleDateString("en-GB", {
    timeZone: "UTC", weekday: "short", day: "numeric", month: "short", year: "numeric",
  });
}

export function isoDay(day: Ymd): string {
  return `${day.y}-${String(day.m).padStart(2, "0")}-${String(day.d).padStart(2, "0")}`;
}

function days(first: Ymd, count: number, tz: string, label?: string): Span {
  const last = addDays(first, count - 1);
  return {
    label: label ?? (count === 1 ? dayLabel(first) : `${dayLabel(first)} – ${dayLabel(last)}`),
    from: startOfDay(first, tz),
    to: startOfDay(addDays(first, count), tz),
  };
}

/** Monday of the week `day` is in. */
const mondayOf = (day: Ymd) => addDays(day, -((weekday(day) + 6) % 7));

// ---- the resolver ------------------------------------------------------------------------------

export function resolveTimeRefs(text: string, now: Date, tz: string): TimeRef[] {
  const today = dateIn(now, tz);
  const found: { at: number; ref: TimeRef }[] = [];
  let rest = text.toLowerCase();

  const take = (pattern: RegExp, build: (m: RegExpExecArray) => (Span & { alternative?: Span }) | null) => {
    for (const m of rest.matchAll(new RegExp(pattern.source, "g")) as IterableIterator<RegExpExecArray>) {
      const span = build(m);
      if (!span) continue;
      found.push({ at: m.index, ref: { phrase: text.slice(m.index, m.index + m[0].length), ...span } });
      // Blank the match so a shorter pattern cannot claim part of it.
      rest = rest.slice(0, m.index) + " ".repeat(m[0].length) + rest.slice(m.index + m[0].length);
    }
  };

  // "may" is a month only when written as one: "I may 3 options" is not 3 May.
  const isMonth = (m: RegExpExecArray, word: string) => !/^may$/i.test(word) || text.slice(m.index, m.index + m[0].length).includes("May");
  const pastDate = (d: number, month: number, year?: number): Ymd | null => {
    if (d < 1 || d > 31) return null;
    let day: Ymd = { y: year ?? today.y, m: month, d };
    if (!year && before(today, day)) day = { ...day, y: today.y - 1 };
    const check = addDays(day, 0);
    return check.m === month ? day : null;
  };

  take(/\b(\d{4})-(\d{2})-(\d{2})\b/, (m) => days({ y: +m[1], m: +m[2], d: +m[3] }, 1, tz));
  take(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?(?:\\s+of)?\\s+${MONTH}\\b(?:,?\\s+(\\d{4}))?`), (m) => {
    if (!isMonth(m, m[2])) return null;
    const day = pastDate(+m[1], MONTHS[m[2].slice(0, 3)], m[3] ? +m[3] : undefined);
    return day && days(day, 1, tz);
  });
  take(new RegExp(`\\b${MONTH}\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?:,?\\s+(\\d{4}))?`), (m) => {
    if (!isMonth(m, m[1])) return null;
    const day = pastDate(+m[2], MONTHS[m[1].slice(0, 3)], m[3] ? +m[3] : undefined);
    return day && days(day, 1, tz);
  });

  take(/\b(?:the\s+)?day before yesterday\b/, () => days(addDays(today, -2), 1, tz));
  take(/\byesterday\b/, () => days(addDays(today, -1), 1, tz));
  take(/\b(?:earlier today|this (?:morning|afternoon|evening)|tonight)\b/, () => days(today, 1, tz));
  // Bare "today" points back only when it is about the conversation ("what did I ask you today"),
  // not when it means now ("is your answer still correct today?").
  const TALK = "(?:ask|asked|say|said|tell|told|talk|talked|discuss|discussed|chat|chatted|spoke)";
  if (new RegExp(`\\b${TALK}\\b[^.?!]*\\btoday\\b|\\btoday\\b[^.?!]*\\b${TALK}\\b`, "i").test(text)) {
    take(/\btoday\b/, () => days(today, 1, tz));
  }
  take(/\b(?:over|on|during)\s+the\s+weekend\b|\b(?:last|this|past)\s+weekend\b/, () => {
    // The most recent Saturday (today, if it is one) and the Sunday after it.
    const saturday = addDays(today, -((weekday(today) + 1) % 7));
    return days(saturday, 2, tz, "the weekend");
  });
  take(/\bthe\s+other\s+day\b/, () => days(addDays(today, -6), 5, tz, "the other day"));

  take(/\b(?:a\s+)?(?:few|couple(?:\s+of)?)\s+days\s+ago\b/, () => days(addDays(today, -6), 5, tz, "a few days ago"));
  take(/\b(\d+|an?|one|two|three|four|five|six|seven|eight|nine|ten)\s+(day|week|month)s?\s+ago\b/, (m) => {
    const n = NUMBERS[m[1]] ?? +m[1];
    if (m[2] === "day") return days(addDays(today, -n), 1, tz);
    if (m[2] === "week") return days(addDays(today, -7 * n - 3), 7, tz);
    return days(addDays(today, -30 * n - 7), 15, tz);
  });

  take(/\b(?:last|previous|past)\s+week\b/, () => days(addDays(mondayOf(today), -7), 7, tz));
  take(/\b(?:earlier\s+)?this\s+week\b/, () => {
    const monday = mondayOf(today);
    const count = (weekday(today) + 6) % 7 + 1;
    return days(monday, count, tz);
  });
  take(/\b(?:last|previous)\s+month\b/, () => {
    const first = today.m === 1 ? { y: today.y - 1, m: 12, d: 1 } : { y: today.y, m: today.m - 1, d: 1 };
    const length = new Date(Date.UTC(first.y, first.m, 0)).getUTCDate();
    return days(first, length, tz);
  });
  take(/\bthis\s+month\b/, () => days({ ...today, d: 1 }, today.d, tz));

  // Not "Monday.com" or "Friday-ish": a weekday followed by a dot-word or a hyphen is a name.
  take(/\b(last|this|on|past|previous|next)?\s*(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b(?![.\-]\w)/, (m) => {
    const qualifier = m[1];
    if (qualifier === "next") return null;
    const target = WEEKDAYS.indexOf(m[2]);
    const back = (weekday(today) - target + 7) % 7;
    if (back === 0) {
      // The named day is today. "This Tuesday" said on a Tuesday is today; otherwise a week ago,
      // with today as the other reading.
      if (qualifier === "this") return days(today, 1, tz);
      if (qualifier === "last" || qualifier === "previous") return days(addDays(today, -7), 1, tz);
      return { ...days(addDays(today, -7), 1, tz), alternative: days(today, 1, tz) };
    }
    const nearest = addDays(today, -back);
    const sameWeek = !before(nearest, mondayOf(today));
    if ((qualifier === "last" || qualifier === "previous") && sameWeek) {
      // "Last Monday" on a Wednesday: two days ago for many people, nine for others.
      return { ...days(nearest, 1, tz), alternative: days(addDays(nearest, -7), 1, tz) };
    }
    return days(nearest, 1, tz);
  });

  return found.sort((a, b) => a.at - b.at).map((f) => f.ref);
}

/** "Tuesday 10 November 2026, 14:03" in `tz`, for telling the model what time it is. */
export function describeNow(now: Date, tz: string): string {
  return now.toLocaleString("en-GB", {
    timeZone: tz, weekday: "long", day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit",
  });
}

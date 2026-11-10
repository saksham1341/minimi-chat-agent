/**
 * Every way of naming a past day, generated from the day itself.
 *
 * Nothing here reads the person's message. For each day we write out the phrases people use for
 * it, as seen from today ("yesterday", "on monday", "last tuesday", "3 november", "a week or so
 * back"), each with how precisely it names that day. Recall then looks for those exact phrases in
 * the message. New phrasings are new lines here, never rules about the message's grammar.
 *
 * Strength: 1 names exactly this day; ~0.9 a weekday form; 0.5-0.7 a window the day falls in.
 */
import { addDays, daysBetween, weekday, type Ymd } from "./time.ts";
import { matchForm } from "./text.ts";

export interface DayPhrase {
  phrase: string; // in matching form
  strength: number;
}

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const SHORT_MONTHS = ["jan", "feb", "mar", "apr", "", "jun", "jul", "aug", "sep", "oct", "nov", "dec"]; // "may" is only ever "may"
const NUMBER_WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen"];
const ordinal = (n: number) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] ?? "th"}`;

export function dayPhrases(day: Ymd, today: Ymd): DayPhrase[] {
  const ago = daysBetween(day, today);
  const out: DayPhrase[] = [];
  const add = (strength: number, ...phrases: string[]) => phrases.forEach((p) => out.push({ phrase: matchForm(p), strength }));
  if (ago < 0) return out;

  // Relative to today.
  if (ago === 0) add(1, "earlier today", "this morning", "this afternoon", "this evening", "today i asked", "asked you today", "asked today");
  if (ago === 1) add(1, "yesterday", "last night");
  if (ago === 2) add(1, "day before yesterday");
  if (ago >= 2 && ago <= 13) add(0.9, `${ago} days ago`, `${NUMBER_WORDS[ago]} days ago`);
  if (ago >= 2 && ago <= 5) add(0.5, "a few days ago", "a couple of days ago", "couple days ago", "the other day");
  if (ago >= 5 && ago <= 9) add(0.6, "a week ago", "a week back", "a week or so ago", "a week or so back", "about a week ago", "around a week ago");
  if (ago >= 12 && ago <= 16) add(0.6, "two weeks ago", "2 weeks ago", "a couple of weeks ago", "couple weeks ago", "a fortnight ago");

  // The weekday. Said on the same weekday, "Tuesday" means last week's.
  const name = WEEKDAYS[weekday(day)];
  const sinceMonday = (weekday(today) + 6) % 7;
  if (ago >= 1 && ago <= 6) {
    add(0.9, `on ${name}`, name);
    add(0.8, `last ${name}`);
    if (ago <= sinceMonday) add(0.9, `this ${name}`, `${name} this week`);
  }
  if (ago === 7) add(0.9, `on ${name}`, name);
  if (ago >= 7 && ago <= 13) add(0.9, `last ${name}`, `${name} last week`, `last week ${name}`);

  // Weeks and weekends.
  if (ago >= 1 && ago <= sinceMonday) add(0.6, "earlier this week", "this week");
  if (ago > sinceMonday && ago <= sinceMonday + 7) add(0.6, "last week");
  if ((weekday(day) === 6 || weekday(day) === 0) && ago <= 8) add(0.8, "the weekend", "over the weekend", "last weekend", "this weekend");

  // The date itself.
  const month = MONTHS[day.m - 1];
  for (const m of [month, SHORT_MONTHS[day.m - 1]].filter(Boolean)) {
    for (const d of [String(day.d), ordinal(day.d)]) add(1, `${d} ${m}`, `${m} ${d}`, `${d} of ${m}`);
  }
  if (ago < 28) add(0.7, `the ${ordinal(day.d)}`);
  if (ago >= 1 && addDays(today, -ago).m === today.m) add(0.3, "earlier this month");
  return out;
}

/** The days of the last `window` days the message names, by the strongest phrase that names each. */
export function namedDays(messagePhrases: Set<string>, today: Ymd, window: number): { day: Ymd; strength: number; phrase: string }[] {
  const named: { day: Ymd; strength: number; phrase: string }[] = [];
  for (let ago = 0; ago <= window; ago++) {
    const day = addDays(today, -ago);
    let best: DayPhrase | undefined;
    for (const p of dayPhrases(day, today)) if (messagePhrases.has(p.phrase) && (!best || p.strength > best.strength)) best = p;
    if (best) named.push({ day, strength: best.strength, phrase: best.phrase });
  }
  return named;
}

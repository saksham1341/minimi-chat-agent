/** What the agent remembers, as plain data. No I/O here; the store port reads and writes it. */

export interface Conversation {
  id: string;
  title: string;
  createdAt: string; // ISO instant
  updatedAt: string;
}

/** A page an answer may cite: a stable id the model cites by, and a number people see. */
export interface Source {
  id: string;
  /** Its number in the conversation, in the order pages were first found. Absent on older records. */
  n?: number;
  url: string;
  title: string;
  domain: string;
  published?: string;
  /** The opening of the passage the search returned, for the citation preview. */
  snippet?: string;
  /** Read live for this answer (`fresh`), not from the search provider's cache. */
  live?: boolean;
}

/** One thing the agent did on the way to an answer, shown to the person as it happens. */
export type Activity =
  | { kind: "recall"; label: string; detail?: string; /** Local days looked at, YYYY-MM-DD. */ days?: string[] }
  | {
      kind: "search"; id: string; query: string; since?: string; domains?: string[]; fresh?: boolean; results?: number; failed?: string; hits?: string[];
      /** Started by the harness before the model asked (a read-ahead). */
      ahead?: boolean;
      /** Answered from a read-ahead, so it came back at once. */
      reused?: boolean;
      /** Still being written by the model: the query so far. */
      drafting?: boolean;
    }
  /** What recall put in front of the model, for the canvas: the exchanges and the facts stated then. */
  | { kind: "memory"; exchanges: { at: string; question: string }[]; claims: { subject: string; value: string; at: string }[] };

/** One question and its answer, as the person saw it. What recall searches. */
export interface TurnRecord {
  id: string;
  conversationId: string;
  at: string; // ISO instant the question was asked
  question: string;
  /** Plain-text rendering of the answer, whatever its shape: what full-text recall matches. */
  answerText: string;
  /** The prose the model wrote, without the rendered shape. What the screen shows above a card. */
  lead: string;
  shape: string; // reply | comparison | changes | choices
  answer?: unknown; // the shape's structured payload
  sources: Source[];
  activity: Activity[];
  model: string;
}

/**
 * A fact the agent stated, with where it came from and when. The ledger is what makes
 * "is your answer still correct?" a list of things to re-check rather than a reread of prose.
 */
export interface Claim {
  id: string;
  turnId: string;
  conversationId: string;
  subject: string; // "Neon, Launch plan"
  value: string; // "$19/month, 10 GB storage"
  sourceUrl?: string;
  /** The source's exact words the fact rested on, as they read that day: the snapshot to compare against later. */
  quote?: string;
  /**
   * Stated in an original answer, or observed while re-checking one. A re-check's "before" is only
   * ever the stated facts, so checking twice never makes the first check the new baseline.
   */
  origin: "stated" | "observed";
  observedAt: string; // ISO instant the answer was given
}

export type ClaimDraft = Pick<Claim, "subject" | "value" | "sourceUrl" | "quote">;

export type ExchangeKind = "new" | "recheck" | "followup" | "chat";

/**
 * What an exchange was about, written by a model after the answer and used by software to find it
 * again: its kind, a one-line summary, the terms a person might use for it (entities and topics
 * with their aliases, in matching form) and the facts it stated.
 */
export interface ExchangeCard {
  kind: ExchangeKind;
  summary: string;
  terms: string[];
  facts: ClaimDraft[];
}

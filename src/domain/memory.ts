/** What the agent remembers, as plain data. No I/O here; the store port reads and writes it. */

export interface Conversation {
  id: string;
  title: string;
  createdAt: string; // ISO instant
  updatedAt: string;
}

/** A search result the answer may cite, numbered per turn: S1, S2, ... */
export interface Source {
  id: string;
  url: string;
  title: string;
  domain: string;
  published?: string;
  /** The opening of the passage the search returned, for the citation preview. */
  snippet?: string;
  /** Read live for this answer (`fresh`), not from the search provider's cache. */
  live?: boolean;
  /** Found by a search limited to its own site (`domains`): the vendor's page, not a roundup. */
  firstParty?: boolean;
}

/** One thing the agent did on the way to an answer, shown to the person as it happens. */
export type Activity =
  | { kind: "recall"; label: string; detail?: string; /** Local days looked at, YYYY-MM-DD. */ days?: string[] }
  | { kind: "search"; id: string; query: string; since?: string; domains?: string[]; fresh?: boolean; results?: number; failed?: string; hits?: string[] }
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
  observedAt: string; // ISO instant the answer was given
}

export type ClaimDraft = Pick<Claim, "subject" | "value" | "sourceUrl">;

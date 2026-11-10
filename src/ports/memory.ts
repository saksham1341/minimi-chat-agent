import type { Entry } from "../agents/conversation.ts";
import type { Claim, ClaimDraft, Conversation, ExchangeCard, TurnRecord } from "../domain/memory.ts";

export interface KeptPage {
  id: string;
  url: string;
  text: string;
  seenAt: string;
}

/** Where conversations, their transcripts, turns and claims live. */
export interface MemoryStore {
  createConversation(title: string, at: Date): Conversation;
  conversation(id: string): Conversation | undefined;
  conversations(limit: number): Conversation[];
  touch(id: string, at: Date): void;

  /** The model-facing transcript, append-only, so replays are byte-identical and cache well. */
  transcript(conversationId: string): Entry[];
  append(conversationId: string, entries: Entry[]): void;

  saveTurn(turn: TurnRecord): void;
  /** The turn's answer once its citations have landed, after it was first saved. */
  updateTurn(turn: TurnRecord): void;
  turns(conversationId: string): TurnRecord[];
  /** Turns asked within [from, to), across all conversations, oldest first. */
  turnsBetween(from: Date, to: Date, limit: number): TurnRecord[];
  turnCount(before: Date): number;

  saveClaims(turn: TurnRecord, claims: ClaimDraft[], origin: Claim["origin"]): void;
  /** The exchange's index card: its kind, summary, and the terms it can be found by. Replaces any card it had. */
  saveCard(turn: TurnRecord, card: ExchangeCard): void;
  cardsFor(turnIds: string[]): Map<string, { kind: string; summary: string }>;
  /** Exchanges before `before` carrying any of these terms, with the ones each carries. */
  turnsWithTerms(terms: string[], before: Date, limit: number): Map<string, string[]>;
  /** How many exchanges before `before` carry each term: how much a match on it says. */
  termFrequency(terms: string[], before: Date): Map<string, number>;
  turnsByIds(ids: string[]): TurnRecord[];
  /** The exact text each source showed the model for this turn: the evidence as it stood that day. */
  saveSnapshots(turn: TurnRecord, texts: ReadonlyMap<string, string>): void;
  /** Every snapshot kept in a conversation, by source id (later turns win). */
  snapshotsFor(conversationId: string): Map<string, string>;
  /** The latest kept text of each page, by source id: what an earlier answer cited, as it stood then. */
  keptPages(ids: string[]): KeptPage[];
  claimsFor(turnIds: string[]): Claim[];
}

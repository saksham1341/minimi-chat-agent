import type { Entry } from "../agents/conversation.ts";
import type { Claim, ClaimDraft, Conversation, TurnRecord } from "../domain/memory.ts";

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
  turns(conversationId: string): TurnRecord[];
  /** Turns asked within [from, to), across all conversations, oldest first. */
  turnsBetween(from: Date, to: Date, limit: number): TurnRecord[];
  /** Full-text match over questions and answers, best first. */
  searchTurns(terms: string[], limit: number, excludeConversation?: string): TurnRecord[];

  saveClaims(turn: TurnRecord, claims: ClaimDraft[]): void;
  claimsFor(turnIds: string[]): Claim[];
}

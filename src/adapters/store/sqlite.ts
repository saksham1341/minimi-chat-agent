/**
 * The memory store on SQLite, through Node's built-in `node:sqlite`, so `npm install` compiles
 * nothing. One file under ./data; recall by topic goes through the exchange cards' terms, by date
 * through an index on time.
 */
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { Entry } from "../../agents/conversation.ts";
import type { Claim, ClaimDraft, Conversation, ExchangeCard, TurnRecord } from "../../domain/memory.ts";
import type { KeptPage, MemoryStore } from "../../ports/memory.ts";

const SCHEMA = `
create table if not exists conversations (
  id text primary key, title text not null, created_at text not null, updated_at text not null
);
create table if not exists entries (
  conversation_id text not null, seq integer not null, body text not null,
  primary key (conversation_id, seq)
);
create table if not exists turns (
  id text primary key, conversation_id text not null, at text not null, question text not null,
  answer_text text not null, lead text not null, shape text not null, answer text, sources text not null,
  activity text not null, model text not null
);
create index if not exists turns_at on turns(at);
create index if not exists turns_conversation on turns(conversation_id, at);
create table if not exists claims (
  id text primary key, turn_id text not null, conversation_id text not null, subject text not null,
  value text not null, source_url text, observed_at text not null, quote text, origin text not null
);
create index if not exists claims_turn on claims(turn_id);
create table if not exists exchange_cards (
  turn_id text primary key, kind text not null, summary text not null
);
create table if not exists exchange_terms (
  turn_id text not null, term text not null, primary key (turn_id, term)
);
create index if not exists exchange_terms_term on exchange_terms(term);
create table if not exists snapshots (
  turn_id text not null, source_id text not null, url text not null, text text not null, seen_at text not null,
  primary key (turn_id, source_id)
);
`;

type Row = Record<string, unknown>;

export class SqliteMemory implements MemoryStore {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("pragma journal_mode = wal;");
    this.db.exec(SCHEMA);
  }

  createConversation(title: string, at: Date): Conversation {
    const c: Conversation = { id: randomUUID(), title, createdAt: at.toISOString(), updatedAt: at.toISOString() };
    this.db.prepare("insert into conversations values (?, ?, ?, ?)").run(c.id, c.title, c.createdAt, c.updatedAt);
    return c;
  }

  conversation(id: string) {
    const row = this.db.prepare("select * from conversations where id = ?").get(id) as Row | undefined;
    return row && toConversation(row);
  }

  conversations(limit: number) {
    return (this.db.prepare("select * from conversations order by updated_at desc limit ?").all(limit) as Row[]).map(toConversation);
  }

  touch(id: string, at: Date) {
    this.db.prepare("update conversations set updated_at = ? where id = ?").run(at.toISOString(), id);
  }

  transcript(conversationId: string): Entry[] {
    return (this.db.prepare("select body from entries where conversation_id = ? order by seq").all(conversationId) as Row[]).map(
      (r) => JSON.parse(r.body as string) as Entry,
    );
  }

  append(conversationId: string, entries: Entry[]) {
    const next = (this.db.prepare("select coalesce(max(seq), -1) + 1 as n from entries where conversation_id = ?").get(conversationId) as Row).n as number;
    const insert = this.db.prepare("insert into entries values (?, ?, ?)");
    this.db.exec("begin");
    try {
      entries.forEach((entry, i) => insert.run(conversationId, next + i, JSON.stringify(entry)));
      this.db.exec("commit");
    } catch (error) {
      this.db.exec("rollback");
      throw error;
    }
  }

  saveTurn(t: TurnRecord) {
    this.db
      .prepare("insert into turns values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(t.id, t.conversationId, t.at, t.question, t.answerText, t.lead, t.shape, t.answer === undefined ? null : JSON.stringify(t.answer), JSON.stringify(t.sources), JSON.stringify(t.activity), t.model);
  }

  turns(conversationId: string) {
    return (this.db.prepare("select * from turns where conversation_id = ? order by at").all(conversationId) as Row[]).map(toTurn);
  }

  turnsBetween(from: Date, to: Date, limit: number) {
    return (
      this.db.prepare("select * from turns where at >= ? and at < ? order by at limit ?").all(from.toISOString(), to.toISOString(), limit) as Row[]
    ).map(toTurn);
  }

  turnCount(before: Date): number {
    return (this.db.prepare("select count(*) as n from turns where at <= ?").get(before.toISOString()) as Row).n as number;
  }

  saveClaims(turn: TurnRecord, claims: ClaimDraft[], origin: Claim["origin"]) {
    const insert = this.db.prepare(
      "insert into claims (id, turn_id, conversation_id, subject, value, source_url, observed_at, quote, origin) values (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    for (const c of claims) insert.run(randomUUID(), turn.id, turn.conversationId, c.subject, c.value, c.sourceUrl ?? null, turn.at, c.quote ?? null, origin);
  }

  saveCard(turn: TurnRecord, card: ExchangeCard) {
    this.db.prepare("insert or replace into exchange_cards values (?, ?, ?)").run(turn.id, card.kind, card.summary);
    const insert = this.db.prepare("insert or ignore into exchange_terms values (?, ?)");
    for (const term of card.terms) insert.run(turn.id, term);
  }

  cardsFor(turnIds: string[]): Map<string, { kind: string; summary: string }> {
    if (!turnIds.length) return new Map();
    const rows = this.db.prepare(`select * from exchange_cards where turn_id in (${turnIds.map(() => "?").join(",")})`).all(...turnIds) as Row[];
    return new Map(rows.map((r) => [r.turn_id as string, { kind: r.kind as string, summary: r.summary as string }]));
  }

  turnsWithTerms(terms: string[], before: Date, limit: number): Map<string, string[]> {
    if (!terms.length) return new Map();
    const rows = this.db
      .prepare(
        `select exchange_terms.turn_id as id, exchange_terms.term as term from exchange_terms join turns on turns.id = exchange_terms.turn_id
         where exchange_terms.term in (${terms.map(() => "?").join(",")}) and turns.at <= ? order by turns.at desc limit ?`,
      )
      .all(...terms, before.toISOString(), limit) as Row[];
    const out = new Map<string, string[]>();
    for (const r of rows) out.set(r.id as string, [...(out.get(r.id as string) ?? []), r.term as string]);
    return out;
  }

  termFrequency(terms: string[], before: Date): Map<string, number> {
    if (!terms.length) return new Map();
    const rows = this.db
      .prepare(
        `select exchange_terms.term as term, count(*) as n from exchange_terms join turns on turns.id = exchange_terms.turn_id
         where exchange_terms.term in (${terms.map(() => "?").join(",")}) and turns.at <= ? group by exchange_terms.term`,
      )
      .all(...terms, before.toISOString()) as Row[];
    return new Map(rows.map((r) => [r.term as string, r.n as number]));
  }

  turnsByIds(ids: string[]): TurnRecord[] {
    if (!ids.length) return [];
    return (this.db.prepare(`select * from turns where id in (${ids.map(() => "?").join(",")})`).all(...ids) as Row[]).map(toTurn);
  }

  saveSnapshots(turn: TurnRecord, texts: ReadonlyMap<string, string>) {
    const insert = this.db.prepare("insert or replace into snapshots values (?, ?, ?, ?, ?)");
    for (const source of turn.sources) {
      const text = texts.get(source.id);
      if (text) insert.run(turn.id, source.id, source.url, text, turn.at);
    }
  }

  snapshotsFor(conversationId: string): Map<string, string> {
    const rows = this.db
      .prepare(`select snapshots.source_id as id, snapshots.text as text from snapshots join turns on turns.id = snapshots.turn_id where turns.conversation_id = ? order by turns.at`)
      .all(conversationId) as Row[];
    return new Map(rows.map((r) => [r.id as string, r.text as string]));
  }

  keptPages(ids: string[]): KeptPage[] {
    if (!ids.length) return [];
    const rows = this.db
      .prepare(`select source_id as id, url, text, max(seen_at) as seenAt from snapshots where source_id in (${ids.map(() => "?").join(",")}) group by source_id`)
      .all(...ids) as Row[];
    return rows.map((r) => ({ id: r.id as string, url: r.url as string, text: r.text as string, seenAt: r.seenAt as string }));
  }

  claimsFor(turnIds: string[]): Claim[] {
    if (!turnIds.length) return [];
    const rows = this.db
      .prepare(`select * from claims where turn_id in (${turnIds.map(() => "?").join(",")}) order by observed_at`)
      .all(...turnIds) as Row[];
    return rows.map((r) => ({
      id: r.id as string,
      turnId: r.turn_id as string,
      conversationId: r.conversation_id as string,
      subject: r.subject as string,
      value: r.value as string,
      sourceUrl: (r.source_url as string | null) ?? undefined,
      quote: (r.quote as string | null) ?? undefined,
      origin: (r.origin as Claim["origin"]) ?? "stated",
      observedAt: r.observed_at as string,
    }));
  }
}


const toConversation = (r: Row): Conversation => ({
  id: r.id as string,
  title: r.title as string,
  createdAt: r.created_at as string,
  updatedAt: r.updated_at as string,
});

const toTurn = (r: Row): TurnRecord => ({
  id: r.id as string,
  conversationId: r.conversation_id as string,
  at: r.at as string,
  question: r.question as string,
  answerText: r.answer_text as string,
  lead: r.lead as string,
  shape: r.shape as string,
  answer: r.answer ? JSON.parse(r.answer as string) : undefined,
  sources: JSON.parse(r.sources as string),
  activity: JSON.parse(r.activity as string),
  model: r.model as string,
});

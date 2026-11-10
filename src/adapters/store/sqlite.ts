/**
 * The memory store on SQLite, through Node's built-in `node:sqlite`, so `npm install` compiles
 * nothing. One file under ./data; FTS5 for recall by topic, an index on time for recall by date.
 */
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { Entry } from "../../agents/conversation.ts";
import type { Claim, ClaimDraft, Conversation, TurnRecord } from "../../domain/memory.ts";
import type { MemoryStore } from "../../ports/memory.ts";

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
create virtual table if not exists turns_fts using fts5(turn_id unindexed, question, answer_text);
create table if not exists claims (
  id text primary key, turn_id text not null, conversation_id text not null, subject text not null,
  value text not null, source_url text, observed_at text not null
);
create index if not exists claims_turn on claims(turn_id);
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
    // Added after the first release: an existing memory file gains the column in place.
    const columns = (this.db.prepare("pragma table_info(claims)").all() as Row[]).map((c) => c.name);
    if (!columns.includes("quote")) this.db.exec("alter table claims add column quote text");
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
    this.db.prepare("insert into turns_fts values (?, ?, ?)").run(t.id, t.question, t.answerText);
  }

  turns(conversationId: string) {
    return (this.db.prepare("select * from turns where conversation_id = ? order by at").all(conversationId) as Row[]).map(toTurn);
  }

  turnsBetween(from: Date, to: Date, limit: number) {
    return (
      this.db.prepare("select * from turns where at >= ? and at < ? order by at limit ?").all(from.toISOString(), to.toISOString(), limit) as Row[]
    ).map(toTurn);
  }

  searchTurns(terms: string[], limit: number, excludeConversation: string | undefined, before: Date) {
    const clean = terms.map((t) => t.replace(/"/g, "")).filter(Boolean);
    if (!clean.length) return [];
    // Prefix match on a crude stem, so "CRMs" finds "CRM" and "pricing" finds "price"-less variants.
    const match = clean.map((t) => `"${stem(t)}"*`).join(" OR ");
    const rows = this.db
      .prepare(
        `select turns.* from turns_fts join turns on turns.id = turns_fts.turn_id
         where turns_fts match ? and turns.conversation_id != ? and turns.at <= ? order by bm25(turns_fts) limit ?`,
      )
      .all(match, excludeConversation ?? "", before.toISOString(), limit) as Row[];
    return rows.map(toTurn);
  }

  documentFrequency(term: string, before: Date): number {
    const clean = term.replace(/"/g, "");
    if (!clean) return 0;
    const row = this.db
      .prepare(`select count(*) as n from turns_fts join turns on turns.id = turns_fts.turn_id where turns_fts match ? and turns.at <= ?`)
      .get(`"${stem(clean)}"*`, before.toISOString()) as Row;
    return row.n as number;
  }

  turnCount(before: Date): number {
    return (this.db.prepare("select count(*) as n from turns where at <= ?").get(before.toISOString()) as Row).n as number;
  }

  saveClaims(turn: TurnRecord, claims: ClaimDraft[]) {
    const insert = this.db.prepare(
      "insert into claims (id, turn_id, conversation_id, subject, value, source_url, observed_at, quote) values (?, ?, ?, ?, ?, ?, ?, ?)",
    );
    for (const c of claims) insert.run(randomUUID(), turn.id, turn.conversationId, c.subject, c.value, c.sourceUrl ?? null, turn.at, c.quote ?? null);
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
      observedAt: r.observed_at as string,
    }));
  }
}

const stem = (term: string) => (term.length > 3 ? term.replace(/(?:es|s)$/, "") : term);

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

# Design

The README says what this is and why. This is how it fits together: the layers, what happens in one turn, and the rules the code keeps. Each rule names the file that keeps it.

## Layers

```
src/
  agents/      the runtime: loop, models, credentials, MCP client, inbox. Imports nothing of the app.
  domain/      types and rules with right answers: calendar phrases, quotes, edits, answer shapes.
  ports/       what services need from the outside: memory store, search provider, runtime, clock.
  adapters/    those needs met: SQLite, Exa/Tavily, embedded or remote runtime, system clock.
  services/    the operations: chat (one turn), recall, re-check, ledger, sources, web search.
  api/         thin interfaces: HTTP for the web app, MCP for any agent.
  assembly.ts  the one place adapters are chosen and wired.
web/src/       React client. Types are imported from the server, type-only, so the two cannot drift.
```

Imports point one way. `test/layers.test.ts` fails with the file and the import named if one doesn't. Services never import an adapter. The runtime imports nothing from the app.

### The driver and the backend

The agent runtime (`src/agents/`) is a driver. It holds the models and every model credential, runs the loop, and reaches tools only over MCP. The backend holds the tool, memory and the person's data, and never holds a model key. The boundary is the same in both modes:

- **embedded** (default): `EmbeddedRuntime` calls `AgentRuntime` in-process, and passes the request through JSON as if it were crossing a socket;
- **remote**: `npm run agents` serves `GET /models`, `POST /runs` (SSE) and `POST /runs/:id/input` behind an optional bearer token, and the backend uses `RemoteRuntime`.

The backend's MCP endpoint (`/mcp`, stateless, loopback-only by default) serves `web_search` to the runtime, or to any MCP client.

## One turn

`ChatService.turn` (`services/chat.ts`) is the operation. Everything else serves it.

1. **Recall** (`services/recall.ts`), in a few milliseconds and with no model involved. It works out which earlier exchanges the message means and writes the `<context>` block. See Memory.
2. **Re-check** (`services/recheck.ts`), only when recall is high or medium confidence. It re-reads, in parallel, up to 8 pages that the matched answer's facts came from, and waits at most 4 s. It looks each original quote up word for word and writes the `<rechecked>` block. The pages it reads become citable sources.
3. **The run.** The runtime gets `{runId, instruction, history, ask, endings}`:
   - the instruction is fixed text (byte-identical, so the provider caches it);
   - the history is the conversation as later turns replay it;
   - the ask carries the context blocks;
   - the endings are the answer shapes, sent as plain JSON schemas.
4. **Observation.** The run streams deltas and entries. The chat service reads them for the screen (search lanes, notes, sources) and keeps each page's text as a snapshot.
5. **Checks** when the run ends. Answer shapes are validated, and replies that talk about "the context" are caught; either continues the run once (`MAX_CORRECTIONS = 1`). Citations never do: they are found by a second run while the answer is written, and checked by lookup (see Citations).
6. **Record.** The turn is saved as the person saw it. The transcript gets the question and the settled answer only (see Replay). The person has the answer now. Then, in the background, the indexer writes the index card and the ledger stores it with the facts.

The screen gets a vocabulary of its own (`TurnEvent`), not the provider's:
- `start`, `activity`, `sources`;
- `text` and `thinking`;
- `searching`, the point where text before a tool call becomes a working note;
- `revise`, and `patch` (citations attached in place);
- `joined`, `shape`, `done`, `error`.

## The loop

`agents/loop.ts`, ported from Keel. It owns four decisions that fail quietly if left to a framework:

- **One message per round.** All results of a parallel round go back in a single `ran` entry. Splitting them teaches the model to stop calling tools in parallel.
- **Failures return.** A tool that threw comes back as a failed result, never as an omission.
- **A ceiling.** After `DEFAULT_MAX_ROUNDS = 3` requests the tools are withdrawn and the model is told to answer with what it has. After 2 more grace rounds the turn ends regardless.
- **Endings.** Plain text is always a reply. Each structured shape is offered as an `answer_<name>` tool, because tool arguments are where every provider enforces a schema. Called alone, an ending ends the turn. Called next to other tools, it is refused.

Also in the loop:

- **Leaked calls.** A tool call written out as XML text is caught, retracted from the screen, and the model is asked to make the call.
- **The inbox** (`agents/inbox.ts`). Messages said to a run while it works wait there. The loop drains all of them at once at the one seam where a message can join without landing inside an exchange the model is still owed: after a round's tool results, before the next request. Each one streams `dequeued` and enters the conversation as the person's message. Whatever is still waiting when the run ends was never heard, and the client sends it as the next question.

## Memory

The rule: **a model writes the metadata, software does the matching.** Matching never calls a model; writing the metadata is one background call per turn, after the answer.

### Indexing, in two steps

The answering model marks its main subjects inline, the first time each appears: `[[Neon]]`, `[[managed Postgres hosting]]` (`domain/annotations.ts`). The screen shows them as plain words, and they never count inside code. When the answer is done, the ledger saves a default card at once from those marks, a table's row names and the sites cited, so the exchange is findable by topic from the moment it is answered.

Then, after `done` is sent, `services/indexer.ts` starts a separate run: no tools, its own fixed instruction, and one way to end, `answer_index`. Its brief is the context a good card needs: this conversation's last few exchanges (so "what about Render?" is indexed as Postgres hosting, not a bare name), what memory matched the question to and how confidently (so a re-check is labelled one), the question with any messages that joined it, the answer with its citations, and the sources. Its card replaces the default one, keeping the marked topics as extra ways in; if the run fails, the default card stays. The cost is one model call per turn; the gain is that nobody waits for metadata, and the card is written with more context than the answering model had. The card (`domain/card.ts`) holds:
- the kind of exchange (new, re-check, follow-up, chat) and a one-line summary;
- the entities and topics, each with aliases, including generic category words ("Postgres hosting" is also "db hosts", "managed database");
- for prose answers, the facts stated, each with its subject, value, source and quote (a comparison's or report's facts are its own cells).

The ledger (`services/ledger.ts`) stores the card's terms and the facts. A fact keeps its quote only if the quote contains the fact's figure. Facts are tagged by origin:
- **stated** in an original answer;
- **observed** in a re-check or changes answer.

A re-check always measures against the stated facts, never against the last check.

### Resolving a reference

- **Days.** `domain/calendar.ts` writes out every way of naming each of the last 60 days as seen from today ("yesterday", "last tuesday", "3 november", "a week or so back"), each with a strength. Nothing parses the message: its word sequences are looked up among those phrases. A new phrasing is a new line there, never a grammar rule.
- **Topics.** The message's word sequences are matched against the cards' terms. A term carried by more than 30% of exchanges says nothing and is ignored.
- **Confidence.**
  - High: a strongly named day plus a topic match.
  - Medium: an exact day, a multi-word topic, or a day plus a topic.
  - Low: anything less.
  - Within a named day, the topic decides: when some of that day's exchanges match the topic, the others are dropped. When none matches and more than two were asked, confidence is low.
- **What the model sees.**
  - The current time.
  - A calendar of counts per day for the last 3 weeks: never titles, because a model shown titles will remember conversations it never had.
  - "Most likely meant", then "also possible". Each exchange shows how long ago it was, why it matched, the question, the answer, and the stated facts with their quotes.
  - Later observations, listed separately and dated.
  - For a named day with nothing on it, a line saying so.

The composer previews the same matching as you type (`GET /api/recall`, memory only).

## Citations

Search results carry stable ids derived from the URL (`S` + digit + 4 hex), so a page has the same id in every search and every conversation. What the model reads of each result is a few ranked passages, not the page (more for a vendor-page read, where tables need room), and that exact text is kept as the snapshot every quote is checked against.

**Found by a second run, not written by the answer** (`services/citer.ts`, `domain/citations.ts`):
- The answering model tags each fact with its page, `[S3f2a1]`, and writes no quotes. Less to write, and nothing to get wrong in form.
- As each paragraph is completed, it gets its own short run on the light model (Haiku), reading exactly the passages the answering model read for the pages that paragraph tags. For each claim it returns the words that end the claim and, per supporting page, the exact words that state it. It may use another passage when the tag was wrong.
- Paragraphs are independent, so their runs go in parallel, at most 3 at a time across the server, with backoff when the provider throttles. A chain of runs continuing one conversation was tried first and measured: it held the answer 9 s after it was written, for continuity a citation does not need.
- Software attaches each citation where its claim ends, replacing the page tag. Citations fill in on screen while the answer is still being written, and the answer is `done` the moment its text ends: the last citations land a few seconds later, and the saved turn takes them.

**Checked by lookup** (`domain/quotes.ts`), never sent back: the lookup ignores case, whitespace, curly quotes, dashes and markdown, and lets "..." stand for words left out.
- **Repaired in software** (`repairCitations`): words without quote marks become a quote if they are on the page, or a plain marker if not; a citation repeated back to back is written once.
- **Marked unverified** (`markUnverified`): a quote that isn't in the passage, or one that doesn't state the price, percentage or version of the sentence it supports. Citations side by side support their sentence together.
- A claim no passage supports keeps its bare page tag.

**Verdicts.** In a changes answer:
- "changed" needs the vendor's own page, a live read, or a source dated after the original;
- "unchanged" with nothing current behind it is shown as unverified (`domain/answers.ts`, `markCardQuotes`).

## Replay: answers as a trust boundary

Within a turn, the model sees everything the run produced. Between turns it does not. The transcript stores two entries per turn:
- the question, with when it was asked;
- the answer as given, with its citations still tagged.

Pages, search rounds, recalled context and corrections stay out. When a later turn needs more of a cited page than the quote, the model reads it back with `web_search` and `pages: ["S3f2a1"]`, either as kept that day or live with `fresh: true`. That is still the one tool. Quotes in follow-ups are checked against the same snapshots.

This keeps replay small: one search-heavy turn used to add over 100 KB to every later request. It also makes every answer stand on its citations.

## Speed

Actual time is spent on the model writing. Perceived time is designed:
- `start` arrives in under 0.1 s, with a skeleton in place of the answer;
- search lanes appear as the model types each query (streamed tool input);
- what the model writes before a search shows as working notes, which fold away when the answer lands;
- the answer is final when its text ends: citations land behind it and the index card is written afterwards, both on the light model, so nobody waits for either;
- the model reads passages, not pages, which shortens its start;
- planning every search up front with the light model (`services/planner.ts`, `PLAN_SEARCHES=true`) is built but off: on Bedrock a Haiku plan took 3–5 s, as long as Sonnet's own first round, and slowed answers that needed no search;
- the search cache shares in-flight requests and reuses results for 10 minutes (2 minutes for live reads);
- the re-check's page reads run in parallel with a hard 4 s wait.

## Client

`web/src/view.ts` folds `TurnEvent`s into a `ViewTurn`, the same shape whether a turn is streaming or loaded from history.

- **Layout.** The thread shows the answer: prose with Wikipedia-style citation previews, a hover card on desktop and a bottom sheet on touch. The canvas, beside the thread from 900 px and a sheet on phones, shows the work: recall, search lanes, sources and the answer cards.
- **The composer** stays usable while an answer streams:
  - a message is sent to the running turn at once and joins after its next round of searches;
  - one said before the run starts joins the opening question;
  - what is still queued when the answer finishes goes together as one message;
  - stop cancels the answer and hands queued messages back to the composer.

## Tests

`npm test` runs in under a second and never calls a model or the network. Fakes stand in at the ports, and the remote runtime is exercised over real HTTP on localhost. Tests assert behaviour:
- the brief's phrasings resolve to the right day and topic;
- quotes are found, repaired or flagged;
- edits change only what they name;
- inbox messages join at the seam;
- replay keeps only the question and the answer;
- imports point one way.

## Deliberately left out

- **Embeddings**, because the card's aliases carry the meaning and exact matching can be explained and tested.
- **A recall tool or a router model**, because each one is a model round to wait for. (Indexing is a model call, but after the answer.)
- **Provider-native citations**, because they only work with Claude.
- **Sign-in and per-person memory**: one person per deployment for now.

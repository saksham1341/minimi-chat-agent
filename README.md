# A chat agent with one tool, and a memory that knows what day it is

```bash
cp .env.example .env    # add a model key (Anthropic or Bedrock) and a search key (Exa or Tavily)
npm install
npm start               # http://localhost:3000
```

Node 22.13 or newer. Every key it can use is listed in `.env.example`; the server says at startup which ones it found.

## How it works

The test questions are not really search questions. "On Monday we shortlisted 5 CRM tools", "what did I ask you on 3 November?", "last Tuesday I asked about Postgres hosting": each one needs **a date, a memory of what was said on that date, and fresh searches against exactly what was said**. The design follows from that.

A turn runs in four steps (`src/services/chat.ts`):

1. **Recall, before the model is called.** Code, not the model, resolves "Monday", "3 November" and "last Tuesday" into instants in the person's time zone (`src/domain/time.ts`). It biases to the past and names both readings when "last Monday" is ambiguous. It reads the conversations from those days and full-text matches the topic (SQLite FTS5), then writes the result into a `<context>` block on the message: the current time, the resolved dates, what was asked and answered, and the facts stated then. This takes milliseconds.
2. **The loop.** The model searches and answers. Several searches in one turn run in parallel, and all their results go back in one message. A failed search comes back as a failed result rather than vanishing. After a fixed number of rounds the search tool is withdrawn and the model is told to answer with what it has. Results are numbered per answer (`[S1]`…) so every fact can be cited and checked.
3. **An answer has a shape.** Plain text is a reply. A comparison of three or more options, a "what changed since" report and a clarifying question are tools whose arguments *are* the answer. The provider checks them against a schema, they stream in, and the UI draws each as its own card.
4. **The ledger, after the answer is on screen.** The facts the answer stated (prices, limits, dates) are recorded with their source and the time they were seen. Structured answers already are claims; prose goes through a small model in the background. So "is your answer still correct?" becomes a list of specific facts to re-check, with `since` set to the day they were stated.

## Why it's built this way

- **Memory is the harness's job, not a tool.** A `recall` tool would cost a full model round trip (a second or more) before the agent even knows whether there is anything to remember. Resolving "last Tuesday" is also arithmetic with one right answer. So the mechanical part runs every turn, and the judgement (what the person meant, whether it still holds) stays with the model. The model's only tool is `web_search`, as the brief asks.
- **Ports and adapters** (from Keel, my own agent framework, ported from Python):
  - `agents/` is the runtime: the loop and model adapters. It imports nothing of the app.
  - `domain/` holds rules with no I/O, and `ports/` + `adapters/` hold everything outside the process.
  - `services/` holds the operations, `api/` is a thin HTTP interface, and `assembly.ts` is the one place that reads the environment.
  - A test (`test/layers.test.ts`) fails if a layer imports the wrong way.
  - A missing key is a named adapter that refuses honestly (`AbsentSearch`), never a `null` and an `if`.
- **The model picker is the adapter list.** Anthropic (Opus, Sonnet and Haiku 5.5) and Bedrock (Sonnet 4.5) are adapters on one port, registered only when their keys are set. Each adapter replays its own reasoning blocks and rebuilds turns another provider wrote, so switching models mid-conversation is safe.
- **Fast where people notice:**
  - Tokens stream to the screen.
  - Searches run in parallel and repeated queries are cached.
  - The system prompt never changes (the date lives in the message), so it stays in the prompt cache.
  - Reasoning effort is low by default. On Bedrock that means thinking off, measured at about 1.8 s to first token against 2.5–5.4 s with it.
- **Exa by default.** It filters by published date ("since Monday"), returns page text in the same call, and can re-read a page live. Live re-reads matter because pricing pages change in place and carry no date: the agent is told to use `since` for announcements and `fresh` for current prices.
- **Honest by construction.** If memory has nothing for "3 November", the context says so, and the agent says so too instead of inventing a conversation.

## Considered and rejected

- **A recall tool, or a router model that picks one.** Each adds a model call before the first useful token, and the date math is deterministic anyway.
- **An LLM to parse dates.** It is slower and sometimes wrong about weekdays. The parser is about 200 lines and unit-tested on the brief's own phrasings.
- **Embeddings for memory.** Questions name products and days, which FTS5 and date ranges match exactly. Vectors would add a dependency and a model for no gain at this scale.
- **Every answer as JSON.** Chat should stream as prose. Only answers whose structure helps the reader are shapes.
- **An SDK tool runner or agent framework.** The loop's invariants (one message per parallel round, failures returned, a ceiling, endings) fail quietly if a library decides them, so they are about 180 lines here, with tests.
- **Porting all of Keel.** Tenancy, proposals, jobs and versioning are for multi-user systems. Only its layering and rules came over.

## With another week

- **Evals.** About 50 dated multi-session scripts, like the brief's examples, run against a frozen clock, graded on whether the date was resolved, the memory found and the claims re-checked. Every prompt or model change would be measured against them.
- **Proactive re-checks.** A daily job that re-verifies stored claims and opens the next conversation with "Neon cut its Launch price since we talked".
- **Page fetching for long documents** (pricing PDFs, changelogs), behind the same tool.
- **Per-person memory and auth.** Today it is one person per server.
- **Conversation compaction** for very long threads.

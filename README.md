# A chat agent that knows what day it is, and shows its evidence

```bash
cp .env.example .env    # a model (Anthropic API or AWS Bedrock) and a search key (Exa or Tavily)
npm install
npm start               # http://localhost:3000  (HOST=0.0.0.0 to open it to your network)
```

Node 22.13+. Every variable it reads is in `.env.example`; startup prints what it found.

## How it works

The brief's questions ("On Monday we shortlisted 5 CRM tools… changed since?") need **a day, what was said that day, and evidence about now**. A turn (`src/services/chat.ts`):

1. **Recall, in code, with no trigger phrases and no date grammar.**
   - Each past exchange is described in its day's words as seen from today ("monday", "november", "3", "yesterday", "last week"). It is matched against the message as text, together with the message's rare words (FTS5; a word counts only if few past exchanges contain it). "On Monday we shortlisted CRM tools" finds Monday's CRM exchange; "now", "thing" and "Monday.com" find nothing.
   - The matches reach the model with the facts stated then, their source quotes, and a three-week calendar, so it reads which day "last Tuesday" means and sees when a day had nothing.
   - The composer previews what a draft will recall as you type, using the same matching.
2. **Reading ahead.** When the message points at a day whose exchanges stated facts, each vendor's own page and its news since then start loading into the search cache, and the model is told exactly which searches are ready. If it runs one, the results come back at once; nothing is ever substituted for a search it did not ask for.
3. **The run.** The agent runtime (`src/agents/`) runs the turn: the loop, the models and every model credential. It reaches the application's one tool, `web_search`, only over MCP. Parallel calls return in one message, failures come back as results, rounds are capped, and a tool call written as text is caught and redone. Results come back as text for the model and as data for the chat service, which numbers sources and keeps their text from what the run reports.
4. **Answers have shapes.** Prose, or a comparison, a what-changed report or a clarifying question: tool calls whose schema-checked arguments are the answer. They stream into a live canvas.
5. **Citations are quotes the application checks.** The model cites a page's stable id with the exact words it relied on, `[S3f2a1 "$1.50/branch-month"]`, several sources per claim if they agree; people see numbers. Each source's text is kept as a snapshot and every quote is checked against it when the run ends. Broken citations continue the run once with the correction; other misses are shown flagged. A "changed" verdict must cite a live read, the vendor's own domain (never an aggregator), or a page dated after the baseline; an "unchanged" with nothing current behind it shows as unverified.
6. **The ledger** stores each stated fact with its source, quote and date, so "is it still correct?" compares words, not memories.

## Why

- **Compute what is computable; leave judgement to the model.** Matching, quote checks and evidence dates have right answers: code does them in milliseconds, and tests check them. Which day is meant, whether memory matters, and whether something changed are judgements, so the model makes them within those checks.
- **Keel's split: a driver and a backend.** The agent runtime is a driver: it holds the models and their keys, runs the loop, and reaches the backend only over MCP, as any other agent would. Point Claude Code at `/mcp` and it gets the same search. The backend (memory, search, citations and checks) never holds a model key, and asks the runtime to run a turn through a port: in-process by default, or as its own deployment (`APP_AGENTS=remote`, `npm run agents`). The boundary is the same either way, and tests run it over real HTTP.
- **Ports and adapters** inside the backend: `domain/` (no I/O), `ports/` + `adapters/` (runtime, Exa, Tavily, SQLite), `services/`, thin `api/` (HTTP for people, MCP for agents) and `assembly.ts`. A test enforces the import direction (the runtime imports nothing of the backend), and a missing key is an adapter that refuses honestly.
- **Feeling fast is design too.** Activity is on screen in under 0.1 s, followed by a placeholder, the model's working note, and search lanes that appear as it types each query.

Measured on Sonnet 4.5 via Bedrock: memory-only answers 3–8 s; searched answers and follow-ups 15–25 s; comparisons about 45 s; re-checks 40–55 s, mostly the model writing the card, which streams from about 12 s.

## Considered and rejected

- **A recall tool or a router model:** a model round before anything useful.
- **A date grammar or an LLM date parser:** grammars miss phrasings nobody wrote a rule for, and a parser call is slow. Day words plus a calendar need neither.
- **Embeddings:** questions name products and days, which text matching handles.
- **Provider-native citations:** Claude-only, and uncertain on Bedrock. Checked quotes work with any model.
- **More thinking on re-checks:** tried it; it added 15–20 s and gave the same verdict.
- **All of Keel:** tenancy and jobs are for multi-user systems.

## With another week

- **Evals:** dated multi-session scripts on a frozen clock, scoring recall, quote validity and verdicts.
- **A faster model for writing cards:** that is now most of the wait.
- **Scheduled re-checks of the ledger.**
- **Sign-in and per-person memory.**
- **Conversation compaction.**

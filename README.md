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
2. **Reading ahead.** When the message points at a day whose exchanges stated facts, each vendor's own page and its news since then start loading in the background, beside the model's first request. If the model asks for them they are already there (ten re-check searches took 0.0 s of tool time); if not, they are dropped.
3. **The loop** (`agents/loop.ts`, ported from my framework Keel). The model's one tool, `web_search`, comes over MCP. Parallel calls return in one message, failures come back as results, rounds are capped, and a tool call written as text is caught and redone.
4. **Answers have shapes.** Prose, or a comparison, a what-changed report or a clarifying question: tool calls whose schema-checked arguments are the answer. They stream into a live canvas.
5. **Citations are quotes the harness checks.** The model cites the exact words it relied on, `[S1 "$1.50/branch-month"]`, several sources per claim if they agree. Each source's text is kept as a snapshot and every quote is checked against it. Broken citations send prose back once; other misses are shown flagged. A "changed" verdict must cite a live read, the vendor's own domain (never an aggregator), or a page dated after the baseline; an "unchanged" with nothing current behind it shows as unverified.
6. **The ledger** stores each stated fact with its source, quote and date, so "is it still correct?" compares words, not memories.

## Why

- **Compute what is computable; leave judgement to the model.** Matching, quote checks and evidence dates have right answers: code does them in milliseconds, and tests check them. Which day is meant, whether memory matters, and whether something changed are judgements, so the model makes them within those checks.
- **Ports and adapters** (Keel's layering). The runtime (`agents/`) imports nothing of the app. Then come `domain/` (no I/O), `ports/` + `adapters/` (Bedrock, Anthropic, Exa, Tavily, SQLite, MCP), `services/`, thin `api/` and `assembly.ts`. A test enforces the import direction, and a missing key is an adapter that refuses honestly.
- **Tools over MCP**, so the agent's capabilities are whatever server `MCP_ENDPOINT` names: by default this process, at a cost of milliseconds.
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

# A chat agent that knows what day it is, and shows its evidence

```bash
cp .env.example .env    # a model (Anthropic API or AWS Bedrock) and a search key (Exa or Tavily)
npm install
npm start               # http://localhost:3000  (HOST=0.0.0.0 to open it to your network)
```

Node 22.13+. Every variable it reads is in `.env.example`; startup prints what it found.

## How it works

The brief's questions ("On Monday we shortlisted 5 CRM tools… changed since?") need **the right earlier exchange, what it said, and evidence about now**. The model writes the metadata; software does the matching and the checking.

1. **Indexing, in the same response.** As it answers, the model also writes the exchange's index card as structured output: what kind of exchange it was, a summary, the entities and topics with every way a person might say them ("Postgres hosting" is also "db hosts", "managed database"), and the facts it stated with their quotes. No second model call.
2. **Resolving a reference, in software.** Every past day's names are generated from the calendar ("yesterday", "last tuesday", "3 november", "a week or so back") and, with the cards' terms, matched against the message's own word sequences. Within a named day, the topic decides. The model gets the exchanges the message most likely means, how long ago each was, a stated confidence and its reason, their original facts as the baseline, and a calendar of counts (never titles, so a title cannot pass for a memory). The composer previews this as you type.
3. **Re-checking by quote.** For a confident match, software re-reads the pages the original facts came from and looks each quote up word for word: still there, or gone (with the closest passage now), in a few seconds, before the model starts. The model judges what changed and searches for what that does not cover.
4. **The run.** The agent runtime (`src/agents/`) holds the loop, the models and every model credential, and reaches the backend's one tool, `web_search`, only over MCP. Parallel calls return together, failures come back as results, rounds are capped. The `answer_*` calls are not tools but how an answer hands over a structured shape (a comparison, a what-changed report, the index card), since tool arguments are where providers enforce a schema.
5. **Checked citations.** The model cites a page's stable id with the exact words it relied on: `[S3f2a1 "$1.50/branch-month"]`. Every quote is checked against the page text the run saw, and must state the sentence's price, percentage or version, or it shows as unverified. Slips of form are repaired in software; only a source that was never found, or a citation standing in for the fact, sends the answer back once. An "unchanged" with nothing current behind it shows as unverified.
6. **Answers as a trust boundary.** Later turns replay only each question (with when it was asked) and the answer as given, its citations still tagged. The pages stay out. When a follow-up needs more of a cited page, the model reads it back by id (`web_search` with `pages`), as kept that day or live. The replay stays small, and every answer stands on its citations.
7. **Working in the open.** What the model writes before a search, and its reasoning when the provider streams it, show as working notes and fold away when the answer lands. A corrected draft stays on screen, dimmed, until the new text starts. The answer is final the moment its text ends; nobody waits for the index card behind it.

## Why

- **Each does what it is good at.** Recognising what was discussed and how people will refer to it is a language task, done by the model that just answered. Matching, quote lookups and evidence dates have right answers, so software does them in milliseconds, and tests encode the cases that once failed. The model keeps the judgement.
- **A driver and a backend.** The runtime holds the models and keys and reaches the backend only over MCP, as any agent would: point Claude Code at `/mcp` and it gets the same search. The backend never holds a model key. It runs the runtime in-process by default, or as its own deployment (`APP_AGENTS=remote`, `npm run agents`); tests cross that boundary over real HTTP. Inside the backend, ports and adapters, with the import direction enforced by a test.
- **Feeling fast is design too.** Activity is on screen in under 0.1 s, working notes from about 2 s, and search lanes appear as the model types each query.

Measured on Sonnet 4.5 via Bedrock: memory-only answers 4–6 s; a searched answer 18 s; a follow-up reading back cited pages 20 s; a re-check of an earlier comparison 38 s; a fresh comparison about 45 s.

## Considered and rejected

- **A recall tool, a router model, or an indexing call:** each is a model round the person waits for, or pays for.
- **A date grammar or an LLM date parser:** grammars miss phrasings nobody wrote a rule for; generated day names need neither.
- **Embeddings:** the card's aliases carry the meaning, and exact matching against them is explainable and testable.
- **Provider-native citations:** Claude-only; checked quotes work with any model.
- **Replaying whole search results:** one question brought back over 100 KB of pages, re-sent with every follow-up.
- **More thinking on re-checks:** 15–20 s more for the same verdict; the quote diff settles most of it.

## With another week

- **Evals:** dated multi-session scripts on a frozen clock, scoring resolution, quote validity and verdicts.
- **A faster model for lookups:** most of the wait is Sonnet 4.5 writing.
- **Scheduled re-checks of the ledger,** using the same quote diff.
- **Sign-in and per-person memory.**

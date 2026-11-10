/** A search plan: the searches a message needs, written before the answer (`services/planner.ts`). */
import { z } from "zod";

export const Plan = z.object({
  searches: z
    .array(
      z.object({
        query: z.string().min(1).describe("What to search for, as typed into a search engine."),
        domains: z.array(z.string()).max(5).optional().describe("Only these sites, e.g. ['neon.com'], for a vendor's own page."),
        fresh: z.boolean().optional().describe("Re-read the pages live: for current prices, plans, limits."),
        since: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Only pages published on or after this day: for news or changes since a date."),
      }),
    )
    .max(6)
    .describe("Every search the answer needs, run in parallel. Empty if it needs none."),
});

/**
 * Planning a re-check from the ledger, before the model is called.
 *
 * "Is your answer still correct?" has an obvious first move: re-read the pages the facts came
 * from. Leaving that to the model costs a full model round (reading the question, deciding to
 * search, writing the calls) before any page is fetched. The ledger already knows which page each
 * fact came from, so the harness fires those reads itself, in parallel, the moment the question
 * arrives, and the model starts with them in hand. What the pages don't cover (announcements since
 * the date) is still the model's call.
 */
import type { Claim } from "./memory.ts";

export interface PlannedSearch {
  query: string;
  domains?: string[];
  fresh?: true;
  since?: string;
  max_results: number;
}

const PRICE = /\$|€|£|₹|\bpric|\bplan\b|\bplans\b|\btier|\bseat|\/mo|per month|free/i;
const MAX_SITES = 6;

export function planRechecks(claims: Claim[]): PlannedSearch[] {
  const bySite = new Map<string, Claim[]>();
  for (const claim of claims) {
    const site = siteOf(claim.sourceUrl);
    if (site) bySite.set(site, [...(bySite.get(site) ?? []), claim]);
  }
  // The day the facts were stated: what "since" means for the news half of the question.
  const baseline = claims.map((c) => c.observedAt.slice(0, 10)).filter(Boolean).sort()[0];
  return [...bySite.entries()].slice(0, MAX_SITES).flatMap(([site, facts]) => {
    const subject = nameOf(facts[0].subject);
    const aboutPrice = facts.some((f) => PRICE.test(`${f.subject} ${f.value}`));
    const reread: PlannedSearch = { query: aboutPrice ? `${subject} pricing plans` : subject, domains: [site], fresh: true, max_results: 3 };
    // "…or shipped something big since?": the live page shows the present, not what happened.
    const news: PlannedSearch[] = baseline ? [{ query: `${subject} new features announcement launch`, since: baseline, max_results: 3 }] : [];
    return [reread, ...news];
  });
}

/** "HubSpot Sales Hub, Price/seat/month" or "Neon pricing" → "HubSpot Sales Hub" / "Neon". */
function nameOf(subject: string): string {
  return subject.split(",")[0].replace(/\b(?:pricing|price|prices|plans?|tiers?)\b/gi, "").replace(/\s+/g, " ").trim() || subject;
}

function siteOf(url?: string): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return undefined;
  }
}

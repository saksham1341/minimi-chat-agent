/**
 * What to read ahead when earlier facts come back from memory.
 *
 * If the person is asking whether an earlier answer still holds, the first thing the model will
 * want is the vendors' own pages as they read now, and what they announced since. Those reads can
 * start before the model has decided anything: if it then asks for them they are already there,
 * and if it does not (the memory was not what the question was about) they are dropped. This is
 * speculation, not a decision: the model still chooses what to search.
 *
 * Planned per vendor, not per source site: two vendors whose facts both came from an aggregator
 * are two reads, of each vendor's own page.
 */
import type { Claim } from "./memory.ts";

export interface PlannedRead {
  vendor: string;
  kind: "page" | "news";
  query: string;
  domains?: string[];
  fresh?: true;
  since?: string;
}

const PRICE = /\$|€|£|₹|\bpric|\bplan\b|\bplans\b|\btier|\bseat|\/mo|per month|free/i;
const MAX_VENDORS = 6;

export function planReadAhead(claims: Claim[]): PlannedRead[] {
  const byVendor = new Map<string, Claim[]>();
  for (const claim of claims) {
    const vendor = vendorOf(claim.subject);
    if (vendor) byVendor.set(vendor, [...(byVendor.get(vendor) ?? []), claim]);
  }
  // The day the facts were stated: what "since" means for the news half.
  const baseline = claims.map((c) => c.observedAt.slice(0, 10)).filter(Boolean).sort()[0];
  return [...byVendor.entries()].slice(0, MAX_VENDORS).flatMap(([vendor, facts]) => {
    const aboutPrice = facts.some((f) => PRICE.test(`${f.subject} ${f.value}`));
    // The vendor's own site, if an earlier source was on it; otherwise a live search for its page.
    const own = facts.map((f) => siteOf(f.sourceUrl)).find((site) => site && isVendorSite(vendor, site));
    const page: PlannedRead = {
      vendor, kind: "page", query: aboutPrice ? `${vendor} pricing plans` : vendor, fresh: true, ...(own ? { domains: [own] } : {}),
    };
    const news: PlannedRead[] = baseline ? [{ vendor, kind: "news", query: `${vendor} new features announcement launch`, since: baseline }] : [];
    return [page, ...news];
  });
}

/** "HubSpot Sales Hub, Price/seat/month" → "HubSpot Sales Hub". */
export function vendorOf(subject: string): string {
  return subject.split(",")[0].replace(/\b(?:pricing|price|prices|plans?|tiers?)\b/gi, "").replace(/\s+/g, " ").trim();
}

/**
 * Is `domain` the vendor's own site? Its name has to be in it: hubspot.com for "HubSpot Sales
 * Hub", neon.tech for "Neon". An aggregator (g2.com, capterra.com) never is.
 */
export function isVendorSite(subject: string, domain: string): boolean {
  const host = domain.toLowerCase().replace(/^www\./, "");
  const label = host.split(".").slice(-2)[0] ?? host;
  const words = vendorOf(subject).toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3);
  const joined = words.join("");
  return words.some((w) => label === w || label.startsWith(w) || host.includes(`${w}.`)) || (joined.length >= 4 && label.includes(joined));
}

export function siteOf(url?: string): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return undefined;
  }
}

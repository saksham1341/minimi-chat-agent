/**
 * Telling a vendor's own pages from everyone else's. "Changed" needs the vendor's own current page
 * (or a dated source); hubspot.com is HubSpot's, g2.com is nobody's.
 */
function vendorOf(subject: string): string {
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

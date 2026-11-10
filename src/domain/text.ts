/**
 * Text normalised for matching: what the person typed and what the indexer wrote meet here.
 * Lowercase, punctuation and hyphens to spaces (keeping the characters names use: + # and a dot
 * inside a word, as in monday.com), and a plural folded to its singular so "db hosts" meets
 * "db host".
 */
export function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‘’']/g, "")
    .replace(/[^a-z0-9+#.\s]/g, " ")
    .replace(/(?<![a-z0-9])\.|\.(?![a-z0-9])/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const singular = (word: string) => (word.length > 3 && /[^s]s$/.test(word) ? word.slice(0, -1) : word);

/** A phrase in its matching form: normalised, each word singular. */
export function matchForm(text: string): string {
  return normalise(text).split(" ").map(singular).join(" ");
}

/** Every run of one to `max` consecutive words in the text, in matching form. */
export function phrases(text: string, max = 4): Set<string> {
  const words = matchForm(text).split(" ").filter(Boolean);
  const out = new Set<string>();
  for (let n = 1; n <= max; n++) for (let i = 0; i + n <= words.length; i++) out.add(words.slice(i, i + n).join(" "));
  return out;
}

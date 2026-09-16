// Shared brand-name matching, used by every source that has to decide "is this listing actually this brand?".
// Kept in one place so a fix (diacritics, a new noise word) applies everywhere at once.

// Words that carry no brand identity.
const GENERIC_WORDS = new Set([
  "ice", "cream", "creams", "icecream", "icecreams", "india", "the", "and", "gelato", "foods",
]);

/**
 * Lowercase, strip accents and punctuation: "Häagen-Dazs®" -> "haagendazs".
 * Without the accent step, "Häagen" reduces to "hagen" and never matches the brand name people type.
 */
export function squash(text) {
  return String(text || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

/** The words of a brand name that actually identify it. */
export function distinctiveWords(name) {
  return String(name || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !GENERIC_WORDS.has(w));
}

/** True when every distinctive word of the brand appears in the text. */
export function mentionsBrand(text, words) {
  const haystack = squash(text);
  return words.length > 0 && words.every((w) => haystack.includes(w));
}

/**
 * Domain stems worth trying for a brand, most likely first.
 * "Get-A-Whey" gives both "getawhey" (what they actually registered) and "getwhey" (words only).
 */
export function domainStems(name) {
  const full = squash(name);
  const joined = distinctiveWords(name).join("");
  return [...new Set([full, joined].filter((s) => s.length > 2))];
}

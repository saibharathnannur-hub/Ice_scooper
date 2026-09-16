// Last-resort prices for brands sold only in their own parlours. They have no retail listings at all, so the
// only public trace of what they charge is ordinary web results - menu pages, directory listings, reviews.
//
// This is the weakest source in the app: snippets go stale and rarely state a pack size cleanly. It is used
// only when nothing better exists, and the model is told to treat it that way.
import { distinctiveWords, mentionsBrand } from "./textMatch.js";

const ENDPOINT = "https://google.serper.dev/search";
const TIMEOUT_MS = 15000;
const MAX_MENTIONS = 12;
const CACHE_MS = 6 * 60 * 60 * 1000;
const cache = new Map();

const HAS_PRICE = /(₹|rs\.?\s?\d|inr\s?\d)/i;

/** Web results that quote a price for this brand. Returns [] when the key is missing or nothing is found. */
export async function fetchWebPriceMentions(brandName) {
  const words = distinctiveWords(brandName);
  if (words.length === 0 || !process.env.SERPER_API_KEY) return [];

  const key = brandName.toLowerCase();
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.items;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let data;
  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "X-API-KEY": process.env.SERPER_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ q: `${brandName} ice cream price menu 500ml tub`, gl: "in", num: 10 }),
      signal: controller.signal,
    });
    if (!res.ok) return [];
    data = await res.json();
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }

  const items = [];
  for (const result of data?.organic || []) {
    const text = `${result.title || ""} ${result.snippet || ""}`.replace(/\s+/g, " ").trim();
    if (!HAS_PRICE.test(text)) continue;
    // The brand has to be named in the result itself, or the prices could belong to anyone.
    if (!mentionsBrand(text, words) && !mentionsBrand(result.link || "", words)) continue;

    items.push({ text: text.slice(0, 300), url: result.link });
    if (items.length >= MAX_MENTIONS) break;
  }

  cache.set(key, { at: Date.now(), items });
  return items;
}

/** Formats price mentions as one more page, clearly marked as the least reliable source. */
export function webPriceMentionsAsPage(items) {
  if (!items.length) return null;
  return {
    url: "web search results (price mentions)",
    text: `WEB PRICE MENTIONS (lowest confidence - snippets from web results, often out of date and may quote a different outlet or pack)\n${items
      .map((i) => `- ${i.text} [${i.url}]`)
      .join("\n")}`,
  };
}

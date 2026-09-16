// Prices from Google Shopping, via Serper. This is the one price source that works from a cloud host:
// DMart blocks Vercel's servers and the delivery apps hide prices from logged-out visitors.
// Without SERPER_API_KEY the app simply skips it.
const ENDPOINT = "https://google.serper.dev/shopping";
const CACHE_MS = 6 * 60 * 60 * 1000; // repeat scans of a brand must not re-spend search credits
const cache = new Map();
const TIMEOUT_MS = 15000;
const MAX_ITEMS = 70; // two searches of 40, minus the overlap between them

const GENERIC_WORDS = new Set(["ice", "cream", "creams", "icecream", "icecreams", "india", "the", "and", "gelato", "foods"]);

let lastError = null;

/** Why the most recent lookup came back empty, for the scan's diagnostics. */
export function lastShoppingError() {
  return lastError;
}

function distinctiveWords(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !GENERIC_WORDS.has(w));
}

// "₹269.00" / "Rs. 1,199" / "$5.99" -> { price, currency }
// Match the number itself rather than stripping characters: the dot in "Rs." would otherwise
// read as a decimal point and turn 1,199 into 0.1199.
function parsePrice(raw) {
  const text = String(raw || "").trim();
  if (!text) return null;
  const match = text.match(/(\d[\d,]*)(\.\d{1,2})?/);
  if (!match) return null;
  const number = Number(match[1].replace(/,/g, "") + (match[2] || ""));
  if (!Number.isFinite(number) || number <= 0) return null;
  const currency = /₹|rs\.?|inr/i.test(text) ? "INR" : /\$|usd/i.test(text) ? "USD" : /£/.test(text) ? "GBP" : null;
  return { price: number, currency };
}

/** Ice cream products for this brand that are on sale somewhere, with prices. Returns [] when unavailable. */
export async function fetchShoppingPrices(brandName, { country = "in" } = {}) {
  lastError = null;
  const words = distinctiveWords(brandName);
  if (words.length === 0) return [];
  if (!process.env.SERPER_API_KEY) {
    lastError = "SERPER_API_KEY not set";
    return [];
  }

  const cached = cache.get(`${brandName.toLowerCase()}|${country}`);
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.items;

  // A search returns 40 listings at most, and the plain brand query skews to small cups and bars.
  // A second, tub-focused query surfaces the big packs, for one more credit.
  const queries = [`${brandName} ice cream`, `${brandName} ice cream tub 1 litre price`];
  const responses = await Promise.all(queries.map((q) => searchShopping(q, country)));
  const entries = responses.flatMap((r) => r?.shopping || []);
  if (entries.length === 0) return [];

  const items = [];
  const seen = new Set();
  for (const entry of entries) {
    const title = String(entry.title || "");
    // Sellers stuff rival brand names into the tail of a title ("... | naturals coconut ice cream price"),
    // so only trust the brand name where it belongs: in the listing's brand field, or at the start of the title.
    const brandField = String(entry.brand || "").toLowerCase().replace(/[^a-z0-9]/g, "");
    const titleStart = title.toLowerCase().split(/[|–—]/)[0].replace(/[^a-z0-9]/g, "").slice(0, 60);
    if (!words.some((w) => brandField.includes(w) || titleStart.includes(w))) continue;

    const parsed = parsePrice(entry.price);
    if (!parsed) continue;

    const key = title.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 60);
    if (seen.has(key)) continue; // the two queries overlap
    seen.add(key);

    items.push({
      name: title,
      price: parsed.price,
      currency: parsed.currency,
      seller: entry.source || null,
      rating: entry.rating ?? null,
      url: entry.link || null,
    });
    if (items.length >= MAX_ITEMS) break;
  }

  cache.set(`${brandName.toLowerCase()}|${country}`, { at: Date.now(), items });
  return items;
}

async function searchShopping(query, country) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      // Key travels in a header, never the URL.
      headers: { "X-API-KEY": process.env.SERPER_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ q: query, gl: country, num: 40 }),
      signal: controller.signal,
    });
    if (res.status === 401 || res.status === 403) {
      lastError = "Google Shopping rejected the API key (check SERPER_API_KEY)";
      return null;
    }
    if (res.status === 429) {
      lastError = "Google Shopping lookups have run out of free credits";
      return null;
    }
    if (!res.ok) {
      lastError = `Google Shopping returned HTTP ${res.status}`;
      return null;
    }
    return await res.json();
  } catch (err) {
    lastError = `Google Shopping request failed: ${err.name === "AbortError" ? "timed out" : err.message}`;
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Formats shopping prices as one more page for the model to read. */
export function shoppingPricesAsPage(items) {
  if (!items.length) return null;
  return {
    url: "https://www.google.com/shopping (retail listings)",
    text: `SHOPPING PRICES (Google Shopping listings - the pack size is usually inside the product title)\n${items
      .map((i) => `- ${i.name} | price: ${i.price} ${i.currency || ""}${i.seller ? ` | sold by: ${i.seller}` : ""}`)
      .join("\n")}`,
  };
}

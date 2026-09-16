// Prices from Google Shopping, via Serper. This is the one price source that works from a cloud host:
// DMart blocks Vercel's servers and the delivery apps hide prices from logged-out visitors.
// Without SERPER_API_KEY the app simply skips it.
const ENDPOINT = "https://google.serper.dev/shopping";
const TIMEOUT_MS = 15000;
const MAX_ITEMS = 30;

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

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let data;
  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      // Key travels in a header, never the URL.
      headers: { "X-API-KEY": process.env.SERPER_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ q: `${brandName} ice cream`, gl: country, num: 40 }),
      signal: controller.signal,
    });
    if (res.status === 401 || res.status === 403) {
      lastError = "Google Shopping rejected the API key (check SERPER_API_KEY)";
      return [];
    }
    if (res.status === 429) {
      lastError = "Google Shopping lookups have run out of free credits";
      return [];
    }
    if (!res.ok) {
      lastError = `Google Shopping returned HTTP ${res.status}`;
      return [];
    }
    data = await res.json();
  } catch (err) {
    lastError = `Google Shopping request failed: ${err.name === "AbortError" ? "timed out" : err.message}`;
    return [];
  } finally {
    clearTimeout(timer);
  }

  const items = [];
  for (const entry of data?.shopping || []) {
    const title = String(entry.title || "");
    // Shopping results drift off-brand quickly, so keep only titles that name this brand.
    const squashed = title.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (!words.some((w) => squashed.includes(w))) continue;

    const parsed = parsePrice(entry.price);
    if (!parsed) continue;

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
  return items;
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

// Open Food Facts is a free, open database (ODbL) of packaged products, including Indian ice creams.
// It carries the printed ingredient lists that packaged brands rarely publish on their own sites. No key needed.
const UA = "IceCreamScout/1.0 (https://icecream-scout.vercel.app)";
const SEARCH_URL = "https://world.openfoodfacts.org/cgi/search.pl";
const TIMEOUT_MS = 12000;
const MAX_ITEMS = 30;

const GENERIC_WORDS = new Set(["ice", "cream", "creams", "icecream", "icecreams", "india", "the", "and", "gelato", "foods"]);

function distinctiveWords(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !GENERIC_WORDS.has(w));
}

/** Packaged products for this brand with their printed ingredients. Returns [] when the brand isn't listed. */
export async function fetchPackagedProducts(brandName) {
  const words = distinctiveWords(brandName);
  if (words.length === 0) return [];

  const params = new URLSearchParams({
    search_terms: `${brandName} ice cream`,
    search_simple: "1",
    action: "process",
    json: "1",
    page_size: "40",
    fields: "product_name,brands,quantity,ingredients_text,countries",
  });

  // Open Food Facts returns short-lived 503s under load, so give it a couple of quick retries.
  let data = null;
  for (let attempt = 0; attempt < 3 && !data; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, attempt * 1000));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(`${SEARCH_URL}?${params}`, {
        headers: { "User-Agent": UA, Accept: "application/json" },
        signal: controller.signal,
      });
      if (res.ok) data = await res.json();
    } catch {
      // an optional source must never fail the scan
    } finally {
      clearTimeout(timer);
    }
  }
  if (!data) return [];

  const items = [];
  for (const p of data?.products || []) {
    // The search is fuzzy, so keep only products whose own brand field names this brand.
    const brands = String(p.brands || "").toLowerCase().replace(/[^a-z0-9]/g, "");
    if (!words.every((w) => brands.includes(w))) continue;
    if (!p.product_name || !p.ingredients_text) continue;

    items.push({
      name: p.product_name,
      quantity: p.quantity || null,
      ingredients: String(p.ingredients_text).replace(/\s+/g, " ").trim().slice(0, 300),
    });
    if (items.length >= MAX_ITEMS) break;
  }
  return items;
}

/** Formats packaged-product data as one more page for the model to read. */
export function packagedProductsAsPage(items) {
  if (!items.length) return null;
  return {
    url: "https://world.openfoodfacts.org (product labels)",
    text: `PRODUCT LABELS (Open Food Facts - ingredients printed on the pack)\n${items
      .map((i) => `- ${i.name}${i.quantity ? ` | pack: ${i.quantity}` : ""} | ingredients: ${i.ingredients}`)
      .join("\n")}`,
  };
}

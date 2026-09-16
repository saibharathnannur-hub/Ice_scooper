// Packaged brands (Amul, Havmor, Kwality Wall's...) rarely publish prices on their own sites, and delivery apps
// hide them. DMart's storefront API is public, needs no key, and carries MRP, selling price and pack size.
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const SEARCH_URL = "https://digital.dmart.in/api/v2/search";
const STORE_ID = "10151"; // DMart prices vary slightly by store; this is their default web store
const TIMEOUT_MS = 12000;
const MAX_ITEMS = 40;

const GENERIC_WORDS = new Set(["ice", "cream", "creams", "icecream", "icecreams", "india", "the", "and", "gelato", "foods"]);

function distinctiveWords(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !GENERIC_WORDS.has(w));
}

let lastError = null;

/** Why the most recent lookup came back empty, for the scan's diagnostics. */
export function lastRetailError() {
  return lastError;
}

/**
 * Ice cream products that DMart actually sells for this brand, with prices.
 * Returns [] for brands it doesn't stock (artisanal parlour brands, mostly) rather than throwing.
 */
export async function fetchRetailPrices(brandName) {
  lastError = null;
  const words = distinctiveWords(brandName);
  if (words.length === 0) return [];

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let data;
  try {
    const res = await fetch(
      `${SEARCH_URL}/${encodeURIComponent(`${brandName} ice cream`)}?page=1&size=40&channel=web&storeId=${STORE_ID}`,
      { headers: { "User-Agent": UA, Accept: "application/json" }, signal: controller.signal }
    );
    if (!res.ok) {
      lastError = `DMart returned HTTP ${res.status}`;
      return [];
    }
    data = await res.json();
  } catch (err) {
    // a missing price source should never fail the whole scan, but record why it was missing
    lastError = `DMart request failed: ${err.name === "AbortError" ? "timed out" : err.message}`;
    return [];
  } finally {
    clearTimeout(timer);
  }

  const items = [];
  for (const product of data?.products || []) {
    // DMart's search is fuzzy - a search for one brand returns others, so match on the maker's own name.
    const maker = String(product.manufacturer || "").toLowerCase().replace(/[^a-z0-9]/g, "");
    if (!words.some((w) => maker.includes(w))) continue;

    for (const sku of product.sKUs || []) {
      const price = Number(sku.priceSALE);
      const mrp = Number(sku.priceMRP);
      if (!Number.isFinite(price) || price <= 0) continue;
      items.push({
        name: sku.name || product.name,
        brand: product.manufacturer || null,
        size: sku.variantTextValue || null,
        price,
        mrp: Number.isFinite(mrp) && mrp > 0 ? mrp : null,
        currency: "INR",
        url: product.targetUrl ? `https://www.dmart.in${product.targetUrl}` : null,
      });
      if (items.length >= MAX_ITEMS) return items;
    }
  }
  return items;
}

/** Formats retail prices as one more page for the model to read alongside the brand's own pages. */
export function retailPricesAsPage(items) {
  if (!items.length) return null;
  return {
    url: "https://www.dmart.in (retail prices)",
    text: `RETAIL PRICES (DMart, India - selling price and MRP in INR)\n${items
      .map(
        (i) =>
          `- ${i.name}${i.size ? ` | size: ${i.size}` : ""} | price: ${i.price} INR${i.mrp && i.mrp !== i.price ? ` | MRP: ${i.mrp} INR` : ""}`
      )
      .join("\n")}`,
  };
}

// Shared scan logic: used by the local Express server (src/server.js) and the Vercel function (api/scan.js).
import { crawlSiteForFlavors } from "./fetchSite.js";
import { extractFlavorsWithGemini } from "./gemini.js";
import { fetchZomatoMenus } from "./zomatoLookup.js";
import { fetchRetailPrices, retailPricesAsPage, lastRetailError } from "./retailPrices.js";
import { fetchPackagedProducts, packagedProductsAsPage } from "./openFoodFacts.js";
import { fetchShoppingPrices, shoppingPricesAsPage, lastShoppingError } from "./shoppingPrices.js";
import { fetchWebPriceMentions, webPriceMentionsAsPage } from "./webPrices.js";
import { compareWithMyBrand } from "./compare.js";

export class ScanError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const MAX_SITES = 3;

function isValidHttpUrl(value) {
  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

// One site gets the whole page budget; with more sites, split it so the prompt stays a sensible size.
function pagesPerSite(siteCount) {
  return siteCount === 1 ? 8 : siteCount === 2 ? 5 : 3;
}

// "Weak" means the table would look half empty: no flavors at all, or most rows missing sizes or ingredients.
// That's when the brand's Zomato menu is worth the extra lookup (it carries flavors, descriptions and pack sizes).
const ENOUGH_COVERAGE = 0.5;

function share(products, fn) {
  return products.length ? products.filter(fn).length / products.length : 0;
}

function isWeak(result) {
  const products = result?.products || [];
  if (products.length === 0) return true;
  return (
    share(products, (p) => p.sizes?.length) < ENOUGH_COVERAGE ||
    share(products, (p) => p.ingredients?.length) < ENOUGH_COVERAGE
  );
}

function lacksPrices(result) {
  const products = result?.products || [];
  if (products.length === 0) return true;
  return share(products, (p) => p.price != null || p.sizes?.some((s) => s.price != null)) < ENOUGH_COVERAGE;
}

function brandNameFrom(result, sites, given) {
  if (result?.brand) return result.brand;
  if (given) return String(given).trim() || null; // the searched name, when the site itself gave nothing
  try {
    return new URL(sites[0]).hostname.replace(/^www\./, "").split(".")[0];
  } catch {
    return null;
  }
}

// Cheapest real ice cream works out around ₹27 per 100 ml, so anything far below that is a misread
// (a "₹2" picked out of page furniture) rather than a price.
const MIN_PRICE = 5;
const MIN_PRICE_PER_100ML = 5;

function plausiblePrice(price, ml) {
  if (price == null) return false;
  if (!(price >= MIN_PRICE)) return false;
  if (ml && (price / ml) * 100 < MIN_PRICE_PER_100ML) return false;
  return true;
}

/** Drops duplicate sizes within a flavor and prices that can't be real. */
function cleanProducts(products) {
  return (products || []).map((p) => {
    const sizes = new Map();
    for (const size of p.sizes || []) {
      const key = size.ml != null ? `ml:${size.ml}` : `label:${String(size.label || "").toLowerCase().replace(/[^a-z0-9]/g, "")}`;
      const price = plausiblePrice(size.price, size.ml) ? size.price : null;
      const prev = sizes.get(key);
      sizes.set(
        key,
        prev
          ? { ...prev, ml: prev.ml ?? size.ml, price: prev.price ?? price, currency: prev.currency || size.currency }
          : { ...size, price }
      );
    }
    return {
      ...p,
      sizes: [...sizes.values()],
      price: plausiblePrice(p.price, null) ? p.price : null,
    };
  });
}

const flavorKey = (name) => String(name || "").toLowerCase().replace(/[^a-z0-9]/g, "");

function mergeSizes(first = [], second = []) {
  const map = new Map();
  for (const size of [...first, ...second]) {
    // "750 ml" and "750 ml tub" are the same pack, so volume wins as the key when it's known.
    const key = size.ml != null ? `ml:${size.ml}` : `label:${flavorKey(size.label)}`;
    const prev = map.get(key);
    map.set(
      key,
      prev
        ? {
            ...prev,
            label: prev.price != null ? prev.label : size.price != null ? size.label : prev.label,
            ml: prev.ml ?? size.ml,
            price: prev.price ?? size.price,
            currency: prev.currency || size.currency,
          }
        : { ...size }
    );
  }
  return [...map.values()];
}

// The second pass sees extra sources but can still describe a flavor less fully than the first did,
// so keep whichever pass filled each cell rather than letting the later one overwrite with blanks.
function mergeResults(first, second) {
  if (!first) return second;
  if (!second) return first;

  const map = new Map();
  for (const product of first.products || []) map.set(flavorKey(product.flavor), { ...product });
  for (const product of second.products || []) {
    const key = flavorKey(product.flavor);
    const prev = map.get(key);
    if (!prev) {
      map.set(key, { ...product });
      continue;
    }
    map.set(key, {
      ...prev,
      description: prev.description || product.description,
      ingredients: prev.ingredients?.length ? prev.ingredients : product.ingredients || [],
      sizes: mergeSizes(prev.sizes, product.sizes),
      price: prev.price ?? product.price,
      currency: prev.currency || product.currency,
      sourcePageUrl: prev.sourcePageUrl || product.sourcePageUrl,
    });
  }

  return {
    ...second,
    brand: second.brand || first.brand,
    notes: second.notes || first.notes,
    products: [...map.values()],
  };
}

function menusAsPages(outlets) {
  return outlets.map((o) => ({
    url: o.url,
    text: `ZOMATO MENU for ${o.name}${o.city ? `, ${o.city}` : ""} (${o.menu.length} items)\n${o.menu
      .map((m) => `- ${m.name}${m.description ? ` | ${m.description}` : ""}`)
      .join("\n")}`,
  }));
}

export async function scanSite(urlOrUrls, { zomatoUrls = [], brand = null } = {}) {
  const sites = [...new Set((Array.isArray(urlOrUrls) ? urlOrUrls : [urlOrUrls]).filter(Boolean).map(String))].slice(
    0,
    MAX_SITES
  );
  const outletUrls = (Array.isArray(zomatoUrls) ? zomatoUrls : [zomatoUrls]).filter(Boolean).map(String);

  // A brand name alone is enough: shopping listings and pack labels are both looked up by name.
  if (sites.length === 0 && outletUrls.length === 0 && !brand) {
    throw new ScanError("Please provide a valid http(s) URL.", 400);
  }
  if (!sites.every(isValidHttpUrl)) {
    throw new ScanError("Please provide a valid http(s) URL.", 400);
  }

  if (!process.env.GEMINI_API_KEY) {
    throw new ScanError(
      "Server is missing GEMINI_API_KEY. Locally, add it to your .env file; on Vercel, add it under Project Settings → Environment Variables.",
      500
    );
  }

  const budget = pagesPerSite(Math.max(sites.length, 1));
  const crawls = await Promise.allSettled(sites.map((u) => crawlSiteForFlavors(u, { maxLinkedPages: budget })));

  const pages = [];
  const errors = [];
  const scanned = [];
  crawls.forEach((c, i) => {
    if (c.status === "fulfilled") {
      pages.push(...c.value.pages);
      errors.push(...c.value.errors);
      scanned.push(sites[i]);
    } else {
      errors.push({ url: sites[i], error: c.reason?.message || String(c.reason) });
    }
  });

  // A blocked or broken site isn't fatal: retail listings and pack labels are looked up from the brand name alone.
  let result = pages.length ? await extractFlavorsWithGemini(sites.join(", "), pages) : null;
  let usedZomatoMenu = false;
  let usedRetailPrices = false;
  let usedProductLabels = false;
  let usedShoppingPrices = false;
  let usedWebPrices = false;

  // The brand's own site is the preferred source. When it comes up short, top it up from its Zomato menu
  // (flavors, sizes) and from retail listings (prices), then re-read everything together as one table.
  const products = result?.products || [];
  const wantMenus = outletUrls.length > 0 && (!result || isWeak(result));
  const wantPrices = !result || lacksPrices(result);
  const wantLabels = !result || share(products, (p) => p.ingredients?.length) < ENOUGH_COVERAGE;
  const brandName = brandNameFrom(result, sites, brand);

  if (wantMenus || wantPrices || wantLabels) {
    const [menus, retail, labels, shopping] = await Promise.all([
      wantMenus
        ? fetchZomatoMenus(outletUrls).catch((err) => {
            errors.push({ url: outletUrls[0], error: `Zomato menu lookup failed: ${err.message}` });
            return [];
          })
        : [],
      wantPrices && brandName ? fetchRetailPrices(brandName) : [],
      wantLabels && brandName ? fetchPackagedProducts(brandName) : [],
      wantPrices && brandName ? fetchShoppingPrices(brandName) : [],
    ]);

    const extraPages = [...menusAsPages(menus)];
    const retailPage = retailPricesAsPage(retail);
    if (retailPage) extraPages.push(retailPage);
    else if (wantPrices && brandName && lastRetailError()) {
      errors.push({ url: "https://www.dmart.in", error: lastRetailError() });
    }
    const labelsPage = packagedProductsAsPage(labels);
    if (labelsPage) extraPages.push(labelsPage);
    const shoppingPage = shoppingPricesAsPage(shopping);
    if (shoppingPage) extraPages.push(shoppingPage);
    else if (wantPrices && brandName && lastShoppingError()) {
      errors.push({ url: "https://www.google.com/shopping", error: lastShoppingError() });
    }

    // Parlour brands aren't sold in packs, so shopping finds nothing. Their prices only survive in ordinary
    // web results, which is worse data - so it is a fallback to the fallback.
    if (wantPrices && brandName && shopping.length === 0) {
      const mentions = await fetchWebPriceMentions(brandName);
      const mentionsPage = webPriceMentionsAsPage(mentions);
      if (mentionsPage) {
        extraPages.push(mentionsPage);
        usedWebPrices = true;
      }
    }

    if (extraPages.length) {
      const sourceLabel = [...sites, ...menus.map((o) => o.url)].filter(Boolean).join(", ");
      const enriched = await extractFlavorsWithGemini(sourceLabel, [...pages, ...extraPages]);
      result = mergeResults(result, enriched);
      usedZomatoMenu = menus.length > 0;
      usedRetailPrices = Boolean(retailPage);
      usedProductLabels = Boolean(labelsPage);
      usedShoppingPrices = Boolean(shoppingPage);
    }
  }

  if (!result) {
    const firstCrawlError = crawls.find((c) => c.status === "rejected")?.reason?.message;
    throw new ScanError(
      firstCrawlError
        ? `Couldn't read that brand: ${firstCrawlError}, and no retail or Zomato data was found either.`
        : "Couldn't read flavors from that site, its Zomato menu, or retail listings.",
      502
    );
  }

  result = { ...result, products: cleanProducts(result.products) };

  // The first pass writes "nothing found" when the brand's own site is bare. If the fallbacks then filled the
  // table, that note contradicts what the reader is looking at.
  if (result.products.length > 0 && /no ice cream product data/i.test(result.notes || "")) {
    result.notes = null;
  }

  return {
    ...result,
    comparison: compareWithMyBrand(result),
    _meta: {
      sitesScanned: scanned,
      pagesScanned: pages.map((p) => p.url),
      usedZomatoMenu,
      usedRetailPrices,
      usedProductLabels,
      usedShoppingPrices,
      usedWebPrices,
      pageFetchErrors: errors,
    },
  };
}

// Looks up ratings for several Zomato outlets. Zomato blocks direct requests from Vercel's servers, so when
// APIFY_TOKEN is set this goes through Apify's Zomato scraper; without it (e.g. running locally) it reads pages directly.
import { fetchZomatoOutlet, normalizeZomatoOutletUrl, ZomatoError } from "./zomato.js";

const MAX_OUTLETS = 5;
const APIFY_ACTOR = "memo23~zomato-scraper";
const APIFY_TIMEOUT_SECS = 120;
const NOTE = "Zomato hides menu prices from logged-out visitors, so only ratings are shown.";

function toOutletUrls(urls) {
  const list = (Array.isArray(urls) ? urls : [urls]).filter(Boolean).map(normalizeZomatoOutletUrl);
  const unique = [...new Set(list)];
  if (unique.length === 0) throw new ZomatoError("Add at least one Zomato outlet link.");
  return unique.slice(0, MAX_OUTLETS);
}

// Apify runs the Zomato fetch for us, because Zomato blocks Vercel's servers directly.
async function apifyRun(outletUrls, { scrapeMenu = false } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), (APIFY_TIMEOUT_SECS + 30) * 1000);
  let res;
  try {
    res = await fetch(
      `https://api.apify.com/v2/acts/${APIFY_ACTOR}/run-sync-get-dataset-items?timeout=${APIFY_TIMEOUT_SECS}&maxItems=${outletUrls.length}`,
      {
        method: "POST",
        // Token goes in a header, never the URL, so it can't end up in logs.
        headers: { Authorization: `Bearer ${process.env.APIFY_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          startUrls: outletUrls.map((url) => ({ url })),
          maxItems: outletUrls.length,
          scrapeMenu, // menu items are billed per item, so only when the brand's site gave nothing
          scrapeReviews: false,
          maxConcurrency: 2,
        }),
        signal: controller.signal,
      }
    );
  } catch (err) {
    throw new ZomatoError(`Couldn't reach Apify (${err.name === "AbortError" ? "timed out" : err.message}).`, 504);
  } finally {
    clearTimeout(timer);
  }

  if (res.status === 401 || res.status === 403) {
    throw new ZomatoError("Apify rejected the API token. Check APIFY_TOKEN.", 502);
  }
  if (res.status === 402) throw new ZomatoError("The Apify account is out of credit.", 502);
  if (res.status === 408) throw new ZomatoError("The Zomato lookup took too long. Please try again.", 504);
  if (!res.ok) throw new ZomatoError(`Apify returned HTTP ${res.status}.`, 502);

  return res.json();
}

async function lookupViaApify(outletUrls) {
  const items = await apifyRun(outletUrls);
  return (Array.isArray(items) ? items : [])
    .filter((i) => i && i.name)
    .map((i) => ({
      name: i.name,
      url: i.url || null,
      // locality is like "Fort, Mumbai" (area + city already combined) - drop the trailing city so it isn't repeated.
      area: i.locality && i.city ? i.locality.replace(new RegExp(`,\\s*${i.city}$`), "") : i.locality || null,
      city: i.city || null,
      address: i.address || null,
      ratings: i.rating ? [{ type: "Overall", rating: Number(i.rating), reviewCount: i.reviewCount ?? i.votes ?? null }] : [],
    }));
}

async function lookupDirect(outletUrls) {
  const results = await Promise.allSettled(outletUrls.map((u) => fetchZomatoOutlet(u)));
  const outlets = [];
  const errors = [];
  results.forEach((r, i) => {
    if (r.status === "fulfilled") {
      const z = r.value;
      outlets.push({ name: z.name, url: z.url, area: null, city: null, address: z.address, ratings: z.ratings });
    } else {
      errors.push({ url: outletUrls[i], error: r.reason?.message || String(r.reason) });
    }
  });
  if (outlets.length === 0) {
    const first = results.find((r) => r.status === "rejected")?.reason;
    throw first instanceof ZomatoError ? first : new ZomatoError("Couldn't read any of those Zomato outlets.", 502);
  }
  return { outlets, errors };
}

// Menus are only fetched as a fallback, when the brand's own site gave nothing useful.
const MAX_MENU_OUTLETS = 2;

function flattenMenuItems(raw) {
  const items = [];
  const walk = (node) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) return node.forEach(walk);
    const name = node.name || node.title;
    if (typeof name === "string" && name.trim()) {
      items.push({ name: name.trim(), description: node.description || node.desc || null });
    }
    for (const key of ["items", "menuItems", "categories", "category", "menu", "menus", "dishes"]) {
      if (node[key]) walk(node[key]);
    }
  };
  walk(raw);
  return items;
}

async function fetchMenusViaApify(outletUrls) {
  const res = await apifyRun(outletUrls, { scrapeMenu: true });
  return (Array.isArray(res) ? res : [])
    .filter((i) => i && i.name)
    .map((i) => ({
      name: i.name,
      city: i.city || null,
      url: i.url || null,
      menu: flattenMenuItems(i.menuItems || i.menu || []),
    }));
}

async function fetchMenusDirect(outletUrls) {
  const results = await Promise.allSettled(outletUrls.map((u) => fetchZomatoOutlet(u)));
  return results
    .filter((r) => r.status === "fulfilled")
    .map((r) => ({
      name: r.value.name,
      city: null,
      url: r.value.url,
      menu: (r.value.menu || []).map((m) => ({ name: m.name, description: m.description })),
    }));
}

/** Menu item names and descriptions from a couple of outlets. Zomato never exposes prices to logged-out visitors. */
export async function fetchZomatoMenus(urls) {
  const outletUrls = toOutletUrls(urls).slice(0, MAX_MENU_OUTLETS);
  const outlets = process.env.APIFY_TOKEN ? await fetchMenusViaApify(outletUrls) : await fetchMenusDirect(outletUrls);
  return outlets.filter((o) => o.menu.length > 0);
}

export async function lookupZomatoOutlets(urls) {
  const outletUrls = toOutletUrls(urls);
  if (process.env.APIFY_TOKEN) {
    return { source: "apify", outlets: await lookupViaApify(outletUrls), errors: [], note: NOTE };
  }
  return { source: "direct", ...(await lookupDirect(outletUrls)), note: NOTE };
}

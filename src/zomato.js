// Reads a public Zomato outlet page. Logged-out visitors get the outlet's ratings, review counts and menu item
// names; Zomato withholds menu prices from them (price_login_blocker), and this deliberately does not log in.
import { fetchHtml } from "./fetchSite.js";

export class ZomatoError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

// Second path segments that belong to Zomato listing pages (Zomato also localizes "restaurants", e.g. "restauracje")
// or to an outlet's sub-pages behind a short link (e.g. /NaturalsCP/order), rather than a single outlet.
const NON_OUTLET_SEGMENTS = new Set([
  "restaurants", "restaurantes", "restauracje", "restaurace", "ristoranti", "restoranlar",
  "delivery", "dine-out", "collections", "nightlife", "cafes",
  "order", "menu", "reviews", "photos", "info",
]);

/** Turns any link to one Zomato outlet (overview, /order, /menu, /reviews) into its /order page URL. */
export function normalizeZomatoOutletUrl(input) {
  let u;
  try {
    u = new URL(String(input || "").trim());
  } catch {
    throw new ZomatoError("Please paste a valid Zomato link.");
  }
  if (!/(^|\.)zomato\.com$/i.test(u.hostname)) {
    throw new ZomatoError("That isn't a zomato.com link.");
  }
  const [city, slug] = u.pathname.split("/").filter(Boolean);
  if (!city || !slug || NON_OUTLET_SEGMENTS.has(slug)) {
    throw new ZomatoError(
      "Paste the link to one outlet's Zomato page, e.g. https://www.zomato.com/mumbai/nic-ice-creams-fort"
    );
  }
  return `https://www.zomato.com/${city}/${slug}/order`;
}

// Zomato embeds its page data as window.__PRELOADED_STATE__ = JSON.parse("<escaped JSON>").
function readPreloadedState(html) {
  const marker = '__PRELOADED_STATE__ = JSON.parse("';
  const at = html.indexOf(marker);
  if (at < 0) return null;
  const from = at + marker.length;
  const end = html.indexOf('");', from);
  if (end < 0) return null;
  try {
    return JSON.parse(JSON.parse(`"${html.slice(from, end)}"`));
  } catch {
    return null;
  }
}

const RATING_LABELS = { DINING: "Dining", DELIVERY: "Delivery" };

export async function fetchZomatoOutlet(link) {
  const url = normalizeZomatoOutletUrl(link);

  let html;
  try {
    html = await fetchHtml(url);
  } catch (err) {
    throw new ZomatoError(
      `Couldn't open that Zomato page (${err.message}). Zomato may be blocking automated visits right now.`,
      502
    );
  }

  const state = readPreloadedState(html);
  const outlet = state && Object.values(state.pages?.restaurant || {})[0];
  if (!outlet) {
    throw new ZomatoError("Couldn't read outlet data from that Zomato page. Zomato may have changed its site.", 502);
  }

  const info = outlet.sections?.SECTION_BASIC_INFO || {};
  const contact = outlet.sections?.SECTION_RES_CONTACT || {};

  const ratings = Object.values(info.rating_new?.ratings || {})
    .filter((r) => r && r.rating)
    .map((r) => ({
      type: RATING_LABELS[r.rating_type] || r.rating_type,
      rating: Number(r.rating),
      reviewCount: r.reviewCount || null,
    }));

  const menuByName = new Map();
  for (const { menu: section } of outlet.order?.menuList?.menus || []) {
    for (const { category } of section?.categories || []) {
      for (const { item } of category?.items || []) {
        if (!item?.name || menuByName.has(item.name)) continue;
        menuByName.set(item.name, {
          section: section.name || null,
          name: item.name,
          description: item.desc || null,
          // Only present if Zomato ever stops hiding prices from logged-out visitors.
          price: typeof item.price === "number" && item.price > 0 ? item.price : null,
        });
      }
    }
  }
  const menu = [...menuByName.values()];
  const pricesAvailable = menu.some((m) => m.price != null);

  return {
    source: "zomato",
    url,
    name: info.name || null,
    cuisines: info.cuisine_string || null,
    address: contact.address || null,
    ratings,
    menu,
    pricesAvailable,
    note: pricesAvailable ? null : "Zomato hides menu prices from logged-out visitors, so prices aren't shown.",
  };
}

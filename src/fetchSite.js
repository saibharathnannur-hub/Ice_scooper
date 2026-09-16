import * as cheerio from "cheerio";
import dns from "node:dns/promises";
import net from "node:net";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

const MAX_CHARS_PER_PAGE = 12000; // keep prompts small and cheap
const MAX_LINKED_PAGES = 8; // how many extra product/flavor pages to follow
const FETCH_TIMEOUT_MS = 12000;
const MAX_REDIRECTS = 5;
const MAX_STRUCTURED_CHARS = 4000;
const MAX_EMBEDDED_CHARS = 45000; // app data (e.g. Next.js) can hold the whole catalog
const MAX_EMBEDDED_FIELD_CHARS = 300;
const MAX_CATALOG_CHARS = 40000;

// Words that suggest a link leads to a flavor/product listing or detail page.
const RELEVANT_LINK_HINTS = [
  "flavor",
  "flavour",
  "product",
  "ice-cream",
  "icecream",
  "tub",
  "cup",
  "pint",
  "range",
  "collection",
  "category",
  "shop",
  "menu",
];

// Paths that are almost never product pages; skipping them saves the page budget for flavors.
const LOW_VALUE_PATH =
  /(blog|news|press|media|talks|stories|article|recipe|career|job|event|video|gallery|author|\/tag\/|faq|contact|privacy|terms|policy|login|account|cart|checkout)/i;

// App-data fields that never help describe a flavor (ids, timestamps, media, layout).
const SKIP_EMBEDDED_FIELD =
  /^(_?id|uuid|documentId|slug|locale|order|position|sort|__typename|url|href|src|alt|width|height|hash|ext|mime|provider|caption|color|theme|className|style)$|(Id|Url|URL|At)$/;

// App-data sections that aren't the product catalog.
const SKIP_EMBEDDED_SECTION =
  /blog|post|article|news|press|video|parlou?r|store|outlet|location|partner|banner|seo|meta|testimonial|review|faq|career|job|gallery|social|nav|footer|header|thumbnail|image|logo|icon/i;

function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    );
  }

  const v6 = ip.toLowerCase();
  if (v6.startsWith("::ffff:")) {
    // IPv4-mapped IPv6, either "::ffff:127.0.0.1" or the normalized "::ffff:7f00:1"
    const rest = v6.slice(7);
    if (net.isIPv4(rest)) return isPrivateAddress(rest);
    const [hi, lo] = rest.split(":").map((h) => parseInt(h, 16));
    if (Number.isNaN(hi) || Number.isNaN(lo)) return true;
    return isPrivateAddress(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  return v6 === "::" || v6 === "::1" || v6.startsWith("fc") || v6.startsWith("fd") || v6.startsWith("fe80");
}

// The server fetches whatever URL a visitor types, so refuse anything that points into a private network.
async function assertPublicUrl(url) {
  const u = new URL(url);
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error(`Only http(s) URLs are allowed: ${url}`);
  }
  const host = u.hostname.replace(/^\[|\]$/g, "");
  const addresses = net.isIP(host) ? [host] : (await dns.lookup(host, { all: true })).map((a) => a.address);
  if (addresses.length === 0 || addresses.some(isPrivateAddress)) {
    throw new Error(`Refusing to fetch a private or local address: ${u.hostname}`);
  }
}

async function fetchPage(url, { accept, isAllowedType }) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    let current = url;
    // Follow redirects by hand so every hop gets the private-address check.
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      await assertPublicUrl(current);
      const res = await fetch(current, {
        headers: { "User-Agent": UA, Accept: accept },
        signal: controller.signal,
        redirect: "manual",
      });

      const location = res.headers.get("location");
      if (res.status >= 300 && res.status < 400 && location) {
        current = new URL(location, current).toString();
        continue;
      }

      if (!res.ok) throw new Error(`HTTP ${res.status} for ${current}`);
      const contentType = res.headers.get("content-type") || "";
      if (!isAllowedType(contentType)) {
        throw new Error(`Unexpected content type (${contentType}) for ${current}`);
      }
      return await res.text();
    }
    throw new Error(`Too many redirects for ${url}`);
  } finally {
    clearTimeout(t);
  }
}

export function fetchHtml(url) {
  return fetchPage(url, {
    accept: "text/html,*/*",
    isAllowedType: (ct) => ct.includes("text/html") || ct.includes("xml"),
  });
}

async function fetchJson(url) {
  const text = await fetchPage(url, { accept: "application/json", isAllowedType: (ct) => ct.includes("json") });
  return JSON.parse(text);
}

function stripHtml(value) {
  return String(value)
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#39;|&rsquo;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

// Walk JSON-LD (schema.org) looking for Product / ProductGroup / ItemList entries with prices.
function collectProducts(node, lines, seen = new Set()) {
  if (!node || typeof node !== "object" || seen.has(node)) return;
  seen.add(node);
  if (Array.isArray(node)) {
    node.forEach((n) => collectProducts(n, lines, seen));
    return;
  }

  const types = [].concat(node["@type"] || []).join(",");
  if (/Product/i.test(types) && node.name) {
    const offers = [].concat(node.offers || []).flatMap((o) => (o && o.offers ? [].concat(o.offers) : [o]));
    const priced = offers.filter((o) => o && (o.price != null || o.lowPrice != null));
    if (priced.length === 0) {
      lines.push(`product: ${node.name}${node.size ? ` | size: ${node.size}` : ""}`);
    }
    for (const o of priced) {
      const price =
        o.price ?? (o.highPrice != null && o.highPrice !== o.lowPrice ? `${o.lowPrice}-${o.highPrice}` : o.lowPrice);
      const variant = o.name && o.name !== node.name ? ` | variant: ${o.name}` : "";
      lines.push(`product: ${node.name}${variant} | price: ${price} ${o.priceCurrency || ""}`.trim());
    }
  }

  for (const key of ["@graph", "hasVariant", "itemListElement", "item", "mainEntity"]) {
    if (node[key]) collectProducts(node[key], lines, seen);
  }
}

/** Prices often live only in the page's structured data (JSON-LD / meta tags), not the visible text. */
function extractStructuredData($) {
  const lines = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      collectProducts(JSON.parse($(el).contents().text()), lines);
    } catch {
      // ignore malformed JSON-LD
    }
  });

  const metaPrice = $(
    'meta[property="product:price:amount"], meta[property="og:price:amount"], meta[itemprop="price"]'
  ).attr("content");
  if (metaPrice) {
    const metaCurrency = $(
      'meta[property="product:price:currency"], meta[property="og:price:currency"], meta[itemprop="priceCurrency"]'
    ).attr("content");
    lines.push(`page price (meta tag): ${metaPrice} ${metaCurrency || ""}`.trim());
  }

  return [...new Set(lines)].join("\n").slice(0, MAX_STRUCTURED_CHARS);
}

function describeEmbeddedItem(obj) {
  const parts = [];
  for (const [key, value] of Object.entries(obj)) {
    if ((typeof value !== "string" && typeof value !== "number") || SKIP_EMBEDDED_FIELD.test(key)) continue;
    const text = stripHtml(value);
    if (!text || /^https?:\/\//.test(text) || /^\d{4}-\d{2}-\d{2}T/.test(text)) continue;
    parts.push(`${key}: ${text.slice(0, MAX_EMBEDDED_FIELD_CHARS)}`);
  }
  return parts.join(" | ");
}

function collectEmbeddedItems(node, key, depth, lines) {
  if (!node || typeof node !== "object" || depth > 15) return;
  if (key && SKIP_EMBEDDED_SECTION.test(key)) return;
  if (Array.isArray(node)) {
    node.forEach((n) => collectEmbeddedItems(n, key, depth + 1, lines));
    return;
  }
  if ("mime" in node || "formats" in node) return; // uploaded image/file objects

  if (typeof node.title === "string" || typeof node.name === "string") {
    const details = describeEmbeddedItem(node);
    if (details.includes(" | ")) lines.push(`- ${details}`); // a bare name on its own isn't useful
  }
  for (const [childKey, child] of Object.entries(node)) {
    if (child && typeof child === "object") collectEmbeddedItems(child, childKey, depth + 1, lines);
  }
}

/** Next.js sites ship their page data as JSON, which often holds the whole catalog the browser renders. */
function extractEmbeddedData($) {
  const raw = $("script#__NEXT_DATA__").text();
  if (!raw) return [];
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return [];
  }
  const lines = [];
  collectEmbeddedItems(data.props?.pageProps ?? data.props, "pageProps", 0, lines);
  return lines;
}

/** Strip boilerplate and return readable text, embedded product data, and candidate internal links. */
function extractTextAndLinks(html, baseUrl) {
  const $ = cheerio.load(html);
  // Both must run before <script> tags are stripped.
  const structured = extractStructuredData($);
  const embeddedLines = extractEmbeddedData($);
  $("script, style, noscript, svg, header nav, footer, [aria-hidden='true']").remove();

  const visibleText = $("body").text().replace(/\s+/g, " ").trim().slice(0, MAX_CHARS_PER_PAGE);

  const base = new URL(baseUrl);
  const links = new Map(); // href -> anchor text

  $("a[href]").each((_, el) => {
    const href = $(el).attr("href");
    const text = $(el).text().trim().toLowerCase();
    if (!href) return;
    let abs;
    try {
      abs = new URL(href, base).toString();
    } catch {
      return;
    }
    const u = new URL(abs);
    if (u.hostname !== base.hostname) return; // same-site only
    u.hash = "";
    abs = u.toString();
    if (abs === base.toString()) return; // the page itself ("https://x.com" and "https://x.com/" are the same)
    if (/\.(pdf|jpg|jpeg|png|gif|svg|zip|mp4|css|js)$/i.test(u.pathname)) return;
    if (LOW_VALUE_PATH.test(u.pathname)) return;

    const haystack = `${text} ${u.pathname.toLowerCase()}`;
    const isRelevant = RELEVANT_LINK_HINTS.some((h) => haystack.includes(h));
    if (isRelevant && !links.has(abs)) {
      links.set(abs, text || abs);
    }
  });

  return { visibleText, structured, embeddedLines, links: [...links.keys()] };
}

/** Shopify stores expose every product, variant and price at /products.json. Returns null for other sites. */
async function fetchShopCatalog(siteUrl) {
  const feedUrl = new URL("/products.json?limit=250", siteUrl).toString();
  let data;
  try {
    data = await fetchJson(feedUrl);
  } catch {
    return null; // not a Shopify store, or the feed is disabled
  }
  const products = Array.isArray(data?.products) ? data.products : [];
  if (products.length === 0) return null;

  const lines = products.map((p) => {
    const variants = (p.variants || [])
      .map((v) => {
        const label = v.title && v.title !== "Default Title" ? stripHtml(v.title).replace(/\|/g, "/") : "";
        return [label, v.price != null ? `price ${v.price}` : ""].filter(Boolean).join(" = ");
      })
      .filter(Boolean)
      .join("; ");
    const details = stripHtml(p.body_html || "").slice(0, 300);
    return [
      `- ${stripHtml(p.title)}`,
      p.product_type && `type: ${p.product_type}`,
      variants && `variants: ${variants}`,
      details && `details: ${details}`,
    ]
      .filter(Boolean)
      .join(" | ");
  });

  return {
    url: feedUrl,
    text: `SHOP CATALOG (the store's own product feed; prices are in the store's currency):\n${lines
      .join("\n")
      .slice(0, MAX_CATALOG_CHARS)}`,
  };
}

/**
 * Fetch the given URL, a handful of same-site flavor/product-looking links, and the store's product feed
 * if it has one, and return an array of { url, text } page snapshots for the model to read.
 */
export async function crawlSiteForFlavors(startUrl, { maxLinkedPages = MAX_LINKED_PAGES } = {}) {
  const pages = [];
  const errors = [];
  const seenEmbedded = new Set();

  // Pages that share a layout repeat the same app data, so send each embedded item to the model only once.
  function toPageText({ visibleText, structured, embeddedLines }) {
    let text = visibleText;
    if (structured) text += `\n\nSTRUCTURED DATA (from page source):\n${structured}`;
    const fresh = embeddedLines.filter((line) => !seenEmbedded.has(line));
    fresh.forEach((line) => seenEmbedded.add(line));
    if (fresh.length >= 3) {
      text += `\n\nEMBEDDED SITE DATA (from the page's app data):\n${fresh.join("\n").slice(0, MAX_EMBEDDED_CHARS)}`;
    }
    return text;
  }

  const startHtml = await fetchHtml(startUrl);
  const start = extractTextAndLinks(startHtml, startUrl);
  pages.push({ url: startUrl, text: toPageText(start) });

  const toFetch = start.links.slice(0, maxLinkedPages);
  const [catalog, ...results] = await Promise.allSettled([
    fetchShopCatalog(startUrl),
    ...toFetch.map((u) => fetchHtml(u)),
  ]);

  if (catalog.status === "fulfilled" && catalog.value) pages.push(catalog.value);

  results.forEach((r, i) => {
    const u = toFetch[i];
    if (r.status === "fulfilled") {
      const text = toPageText(extractTextAndLinks(r.value, u));
      if (text.length > 50) pages.push({ url: u, text });
    } else {
      errors.push({ url: u, error: String(r.reason?.message || r.reason) });
    }
  });

  return { pages, errors };
}

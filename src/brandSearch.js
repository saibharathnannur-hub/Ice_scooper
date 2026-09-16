// Turns a typed brand name into links (official website + Zomato outlets).
// Tavily (free tier, no card) finds candidate pages; Gemini only picks from those results by number,
// so the app can never show a link that didn't come from a real search result.
import { generateWithFallback } from "./gemini.js";
import { normalizeZomatoOutletUrl } from "./zomato.js";
import { fetchHtml } from "./fetchSite.js";
import { distinctiveWords, mentionsBrand, squash, domainStems } from "./textMatch.js";

export class BrandSearchError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const MAX_NAME_CHARS = 60;
const MAX_OUTLETS = 5;
const MAX_SITES = 3; // the brand's main site plus up to two of its own other sites (e.g. its shop)
const CACHE_MS = 6 * 60 * 60 * 1000; // repeat searches for the same brand don't spend free search credits
const TAVILY_TIMEOUT_MS = 20000;
const cache = new Map();

// Sites that are never a brand's own homepage.
const NOT_A_BRAND_SITE =
  /(^|\.)(zomato|swiggy|zepto|zeptonow|blinkit|bigbasket|amazon|flipkart|jiomart|instagram|facebook|linkedin|twitter|x|youtube|wikipedia|justdial|tripadvisor|google|magicpin|dineout|eazydiner)\.[a-z.]+$/i;

// Free hosting and site builders host lookalike clones, never a real brand's own site.
const FREE_HOSTING =
  /(byethost\d*|great-site\.net|000webhost|infinityfree|epizy|kyte\.site|blogspot|wordpress\.com|weebly|wixsite|godaddysites|business\.site|glitch\.me|netlify\.app|vercel\.app|github\.io|squarespace\.com|myshopify\.com)/i;
const EXCLUDED_DOMAINS = [
  "zomato.com", "swiggy.com", "zeptonow.com", "blinkit.com", "bigbasket.com", "amazon.in", "amazon.com",
  "flipkart.com", "jiomart.com", "instagram.com", "facebook.com", "linkedin.com", "x.com", "twitter.com",
  "youtube.com", "wikipedia.org", "justdial.com", "tripadvisor.in", "tripadvisor.com", "magicpin.in",
  // noise that crowds out the brand's own site
  "reddit.com", "pinterest.com", "quora.com", "scribd.com", "mouthshut.com", "tiktok.com",
  "apps.apple.com", "play.google.com", "franchiseindia.com", "indiafilings.com",
];

function uniqueBy(items, key) {
  const seen = new Set();
  return items.filter((item) => {
    const k = key(item);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function cleanWebsite(value) {
  try {
    const u = new URL(String(value));
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    if (NOT_A_BRAND_SITE.test(u.hostname) || FREE_HOSTING.test(u.hostname)) return null;
    return u.origin + "/";
  } catch {
    return null;
  }
}

// "NIC Ice Creams, Fort, Mumbai | Zomato" / "Menu of NIC Ice Creams, Mira Road, Mumbai" -> name, area, city
function parseOutletTitle(title) {
  const cleaned = String(title || "")
    .replace(/^(Menu|Reviews|Photos) of /i, "")
    .replace(/\s*[|-]\s*Zomato.*$/i, "")
    .replace(/\s+order online$/i, "")
    .trim();
  const parts = cleaned.split(",").map((s) => s.trim()).filter(Boolean);
  return {
    name: parts[0] || null,
    area: parts.length > 2 ? parts.slice(1, -1).join(", ") : parts[1] || null,
    city: parts.length > 2 ? parts[parts.length - 1] : null,
  };
}

async function tavilySearch(body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TAVILY_TIMEOUT_MS);
  let res;
  try {
    res = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.TAVILY_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ search_depth: "basic", ...body }), // basic = 1 credit per search
      signal: controller.signal,
    });
  } catch (err) {
    throw new BrandSearchError(
      `The search service didn't respond (${err.name === "AbortError" ? "timed out" : err.message}).`,
      504
    );
  } finally {
    clearTimeout(timer);
  }

  if (res.status === 401 || res.status === 403) {
    throw new BrandSearchError("The search service rejected its API key. Check TAVILY_API_KEY.", 502);
  }
  if (res.status === 429 || (res.status >= 430 && res.status < 440)) {
    throw new BrandSearchError(
      "Brand search has hit its free search limit for now. You can still paste the brand's website link.",
      503
    );
  }
  if (!res.ok) throw new BrandSearchError(`The search service returned HTTP ${res.status}.`, 502);

  const data = await res.json();
  return Array.isArray(data.results) ? data.results : [];
}

async function pickWithGemini(name, websites, outlets) {
  const list = (items, format) => items.map((c, i) => `${i + 1}. ${format(c)}`).join("\n") || "(none)";
  const prompt = `Match these search results to the ice cream brand "${name}".

WEBSITE CANDIDATES:
${list(websites, (c) => `${c.url} | ${c.title} | ${c.snippet}`)}

ZOMATO CANDIDATES:
${list(outlets, (c) => `${c.url} | ${c.title}`)}

Reply with ONLY JSON: {"brand": string|null, "websiteIndexes": number[], "outletIndexes": number[]}
- brand: the brand's proper name, or null if none of the results are about an ice cream, gelato, kulfi or frozen dessert brand called "${name}".
- websiteIndexes: the numbers of up to ${MAX_SITES} candidates that the brand itself owns, MAIN SITE FIRST, or [] if none qualify. The main site is the brand's own official website; if it has both a global site and a country-specific site and there are Zomato candidates for it (so it operates in India), the India site is the main one. Add a second or third only when it is clearly the SAME brand's own site too (for example its online shop or ordering site, often on the same domain), because those pages often carry prices. Never include resellers, marketplaces, directories, news, blogs, review sites or franchise-enquiry sites.
- outletIndexes: up to ${MAX_OUTLETS} numbers of Zomato candidates that are outlets trading under this brand's own name, including its franchised parlours (e.g. "<brand> Ice Cream Parlour"). Exclude other restaurants and cafes that merely serve the brand's products.`;

  const { response, model } = await generateWithFallback({
    contents: prompt,
    config: { responseMimeType: "application/json", temperature: 0 },
  });
  const data = JSON.parse(response.text);
  const at = (items, i) => (Number.isInteger(i) && i >= 1 && i <= items.length ? items[i - 1] : null);
  return {
    model,
    brand: typeof data.brand === "string" ? data.brand : null,
    websites: (Array.isArray(data.websiteIndexes) ? data.websiteIndexes : []).map((i) => at(websites, i)).filter(Boolean),
    outlets: (Array.isArray(data.outletIndexes) ? data.outletIndexes : []).map((i) => at(outlets, i)).filter(Boolean),
  };
}

// Some brand sites block crawlers (e.g. amul.com), so they never appear in search results at all.
// Try the obvious domains and keep one only if its page TITLE names the brand - a matching domain alone is
// not enough, since lookalike domains exist.
// Sites that sell the business, not the ice cream: they carry a brand's name but never list a flavour.
const FRANCHISE_SITE = /franchise|dealership|distributorship|business opportunit/i;

/** A site counts as the brand's own only if it names the brand and actually sells ice cream, not franchises. */
async function verifyMainSite(site, words) {
  if (!site) return null;
  let title = "";
  try {
    const html = await fetchHtml(site.url);
    title = (html.match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1] || "";
    if (FRANCHISE_SITE.test(title)) return null;
  } catch {
    return null; // unreachable sites can't be vouched for either
  }
  return mentionsBrand(new URL(site.url).hostname, words) || mentionsBrand(title, words) ? site : null;
}

async function guessBrandSite(name) {
  const words = distinctiveWords(name);
  if (words.length === 0) return null;

  // "Get-A-Whey" registered getawhey.com, not getwhey.com, so try the name as written as well.
  const candidates = [...new Set(
    domainStems(name).flatMap((stem) => [
      `https://www.${stem}.com/`,
      `https://www.${stem}.in/`,
      `https://www.${stem}icecream.com/`,
      `https://www.${stem}icecreams.com/`,
      `https://www.${stem}icecream.in/`,
      `https://www.${stem}icecreams.in/`,
    ])
  )];

  // A domain that IS the brand name is evidence in itself - getawhey.com renders its title in JavaScript,
  // so there is nothing to read in the HTML. Short names are excluded: "NIC" must not claim nic.com.
  const stems = new Set(domainStems(name).filter((stem) => stem.length >= 6));

  const checks = await Promise.allSettled(
    candidates.map(async (url) => {
      const host = new URL(url).hostname.replace(/^www\./, "");
      const base = squash(host.split(".")[0]);
      const html = await fetchHtml(url); // must at least load
      const title = (html.match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1] || "";
      if (!mentionsBrand(title, words) && !stems.has(base)) return null;
      return { url, title: title.replace(/\s+/g, " ").trim(), snippet: "" };
    })
  );
  return checks.find((c) => c.status === "fulfilled" && c.value)?.value || null;
}

// Used when Gemini is busy: keep results whose domain or title contains every distinctive word of the brand name.
function pickByName(name, websites, outlets) {
  const words = distinctiveWords(name);
  return {
    model: null,
    brand: null,
    websites: websites.filter((c) => mentionsBrand(new URL(c.url).hostname, words)),
    outlets: outlets.filter((c) => mentionsBrand(c.title, words)),
  };
}

export async function findBrandLinks(rawName) {
  const name = String(rawName || "")
    .replace(/["\n\r\\]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_NAME_CHARS);
  if (name.length < 2) throw new BrandSearchError("Type a brand name to search.");

  const key = name.toLowerCase();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return { ...hit.result, cached: true };

  if (!process.env.TAVILY_API_KEY) {
    throw new BrandSearchError(
      "Brand search isn't set up yet (missing TAVILY_API_KEY). You can still paste the brand's website link.",
      503
    );
  }

  const [websiteResults, zomatoResults] = await Promise.all([
    tavilySearch({ query: `${name} ice cream flavours`, exclude_domains: EXCLUDED_DOMAINS, max_results: 8 }),
    tavilySearch({ query: `${name} ice cream Zomato`, include_domains: ["zomato.com"], max_results: 10 }),
  ]);

  const websites = uniqueBy(
    websiteResults
      .map((r) => ({
        url: cleanWebsite(r.url),
        title: r.title || "",
        snippet: String(r.content || "").replace(/\s+/g, " ").slice(0, 200),
      }))
      .filter((c) => c.url),
    (c) => c.url
  );
  const outlets = uniqueBy(
    zomatoResults.flatMap((r) => {
      try {
        return [{ url: normalizeZomatoOutletUrl(r.url), title: r.title || "", ...parseOutletTitle(r.title) }];
      } catch {
        return []; // listing pages and other non-outlet Zomato links
      }
    }),
    (c) => c.url
  );

  let pick;
  try {
    pick = await pickWithGemini(name, websites, outlets);
  } catch (err) {
    console.warn(`[brand search] Gemini couldn't pick results, using name matching: ${String(err.message).slice(0, 200)}`);
    pick = pickByName(name, websites, outlets);
  }

  // Search results for an odd name can be so polluted that the model picks a plausible but wrong company
  // ("Get-A-Whey" -> getawaydesserts.com), so the main site has to prove it names the brand.
  const verifiedMain = await verifyMainSite(pick.websites[0], distinctiveWords(name));
  if (!verifiedMain) {
    const guessed = await guessBrandSite(name); // free: no search credits
    pick.websites = guessed ? [guessed] : pick.websites.slice(1);
  }

  // The main site is whatever was picked first; any extra site must at least carry a brand word in its hostname,
  // so an unrelated site can't be merged into the brand's table.
  const words = distinctiveWords(name);
  const pickedSites = pick.websites
    .filter((w, i) => {
      if (i === 0) return true;
      const host = squash(new URL(w.url).hostname);
      return words.some((word) => host.includes(word));
    })
    .slice(0, MAX_SITES)
    .map((w) => w.url);
  const result = {
    query: name,
    brand: pick.brand,
    websites: pickedSites,
    website: pickedSites[0] || null, // the main site
    zomatoOutlets: pick.outlets
      .slice(0, MAX_OUTLETS)
      .map((o) => ({ url: o.url, name: o.name, area: o.area, city: o.city })),
    _model: pick.model,
  };
  if (!result.website && result.zomatoOutlets.length === 0) {
    throw new BrandSearchError(
      `Couldn't find an ice cream brand called "${name}". Try the full brand name, or paste its website link.`,
      404
    );
  }

  cache.set(key, { at: Date.now(), result });
  return result;
}

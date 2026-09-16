import { GoogleGenAI } from "@google/genai";

let client = null;
function getClient() {
  if (!client) {
    if (!process.env.GEMINI_API_KEY) {
      throw new Error(
        "GEMINI_API_KEY is not set. Get a free key at https://aistudio.google.com/apikey and put it in your .env file."
      );
    }
    client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  }
  return client;
}

// Free-tier models get overloaded at different times, so try them in order.
// Override with GEMINI_MODELS=model-a,model-b in .env if Google renames things.
const MODELS = (process.env.GEMINI_MODELS || "gemini-3.5-flash,gemini-3.6-flash,gemini-flash-latest,gemini-3.5-flash-lite")
  .split(",")
  .map((m) => m.trim())
  .filter(Boolean);

const ATTEMPT_TIMEOUT_MS = 45000;

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Errors worth moving on to the next model for: overload, rate limit, network drop, timeout, model gone.
function isRetryable(err) {
  return /503|UNAVAILABLE|429|RESOURCE_EXHAUSTED|500|INTERNAL|fetch failed|timed out|ECONNRESET|ETIMEDOUT|404|NOT_FOUND/i.test(
    String(err?.message)
  );
}

export async function generateWithFallback(request) {
  const ai = getClient();
  const failures = [];

  for (const model of MODELS) {
    try {
      const response = await withTimeout(
        ai.models.generateContent({ ...request, model }),
        ATTEMPT_TIMEOUT_MS,
        model
      );
      return { response, model };
    } catch (err) {
      const msg = String(err?.message || err);
      console.warn(`[gemini] ${model} failed: ${msg.slice(0, 160)}`);
      failures.push(`${model}: ${msg.slice(0, 120)}`);
      if (!isRetryable(err)) throw err;
    }
  }

  throw new Error(
    `All Gemini models are busy or unreachable right now (Google free tier). Try again in a minute.\n${failures.join("\n")}`
  );
}

const SYSTEM_PROMPT = `You are a product-data extraction assistant. You will be given the scraped text of one or more pages from an ice cream brand's website (a homepage/listing page and possibly individual flavor or product pages).

Extract every distinct ice cream flavor/product you can find, with as much detail as the pages actually contain. Do not invent data that isn't present - use null or an empty array when something isn't stated.

Respond with ONLY valid JSON matching this exact shape:
{
  "brand": string,               // best guess at the brand/site name
  "sourceUrl": string,            // the main URL that was scanned
  "products": [
    {
      "flavor": string,           // e.g. "Belgian Chocolate"
      "description": string|null,
      "ingredients": string[],    // as listed on the page; [] if not found
      "sizes": [
        { "label": string, "ml": number|null, "price": number|null, "currency": string|null }
        // e.g. {"label":"500 ml tub","ml":500,"price":249,"currency":"INR"}
        // ml is null if the size isn't convertible to ml (e.g. "family pack"); price is null if no price is shown for that size
      ],
      "price": number|null,         // ONLY for a price shown without any size; otherwise null (put prices on sizes)
      "currency": string|null,      // ISO code for "price", e.g. "INR", "USD"
      "sourcePageUrl": string|null
    }
  ],
  "notes": string|null            // anything worth flagging, e.g. "prices not listed on site"
}

Rules:
- Merge duplicate flavors mentioned on multiple pages into one entry. Pages may come from more than one website
  belonging to the same brand (e.g. its main site and its online shop); merge those too, keeping the most complete
  details for each flavor - for example a size from one page and its price from another.
- Convert sizes to milliliters where the unit is given in L, ml, oz, pint, quart, gallon (approx conversions are fine, but prefer exact when stated).
- Prices: use the price the customer actually pays. If both an MRP and a lower sale price are shown, use the sale price. Output a plain number: "₹249", "Rs. 249.00", "INR 249" -> 249 with currency "INR"; "$12.99" -> 12.99 with currency "USD".
- Pages may end with "STRUCTURED DATA (from page source)" or "EMBEDDED SITE DATA" sections, and there may be a "SHOP CATALOG" page. These come from the site's own product data (schema markup, the data the site's JavaScript renders, or the store's product feed) and are reliable for flavors, sizes, ingredients and prices - use them fully and match each detail to the right flavor and size.
- Ingredients: include ingredients the site explicitly names for that flavor, whether in a formal ingredient list or in its description (e.g. "made with Belgian cocoa and real milk" -> ["Belgian cocoa", "milk"]). Never infer ingredients from the flavor name alone.
- In a SHOP CATALOG, a price of 0 means the store doesn't sell it online - treat it as no price.
- A "ZOMATO MENU" page lists what one outlet sells. Use it for flavors, descriptions and pack sizes, which are often
  inside the item name ("Sitaphal Ice Cream 750ml" -> flavor "Sitaphal", size 750 ml). Strip pack sizes and words like
  "Ice Cream", "Tub" or "Pack" out of the flavor name, and merge with the same flavor from the brand's own site.
  Skip items that are not the brand's own ice cream products (toppings, add-ons, cutlery, delivery charges).
  Zomato hides prices from logged-out visitors, so NEVER output a price taken from a ZOMATO MENU page.
- A "PRODUCT LABELS" page lists ingredients printed on the brand's packs. Use it to fill the ingredients of the
  matching flavor, keeping the list short and readable (the main ingredients, not the full legal text).
- A "RETAIL PRICES" page lists what an Indian retailer charges for this brand's packs. Use it to fill in prices and
  pack sizes: attach each pack's selling price (not the MRP) to the matching flavor and size. Match on the flavor name
  only - if a pack doesn't clearly belong to a flavor in the table, add it as its own row rather than guessing.
- Never guess or estimate a price. If a flavor's price isn't shown, leave price null. If the site shows no prices at all, say "Prices not listed on site." in notes.
- If the pages contain no ice cream product data at all, return {"brand": null, "sourceUrl": <url>, "products": [], "notes": "No ice cream product data found on the provided pages."}
- Output raw JSON only - no markdown code fences, no commentary.`;

export async function extractFlavorsWithGemini(startUrl, pages) {
  const pagesBlock = pages
    .map((p, i) => `--- PAGE ${i + 1}: ${p.url} ---\n${p.text}`)
    .join("\n\n");

  const contents = `${SYSTEM_PROMPT}\n\nSITES SCANNED: ${startUrl}\n\n${pagesBlock}`;

  const { response, model } = await generateWithFallback({
    contents,
    config: {
      responseMimeType: "application/json",
      temperature: 0.2,
    },
  });

  const raw = response.text;
  if (!raw) throw new Error(`Empty response from Gemini (${model}).`);

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    // Fallback: strip accidental code fences.
    const cleaned = raw.trim().replace(/^```(json)?/i, "").replace(/```$/, "").trim();
    data = JSON.parse(cleaned);
  }
  return { ...data, _model: model };
}

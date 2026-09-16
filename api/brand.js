// Vercel serverless function for POST /api/brand.
import { findBrandLinks, BrandSearchError } from "../src/brandSearch.js";
import { createRateLimiter, clientIp } from "../src/rateLimit.js";

// Each search uses 2 of the free monthly Tavily search credits (cached searches use none).
const MAX_SEARCHES_PER_WINDOW = 5;
const isRateLimited = createRateLimiter({ windowMs: 10 * 60 * 1000, max: MAX_SEARCHES_PER_WINDOW });

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Use POST." });
  }

  if (isRateLimited(clientIp(req))) {
    return res.status(429).json({
      error: `Brand search limit reached (${MAX_SEARCHES_PER_WINDOW} per 10 minutes). You can still paste a website link.`,
    });
  }

  try {
    res.status(200).json(await findBrandLinks(req.body?.name));
  } catch (err) {
    const status = err instanceof BrandSearchError ? err.status : 500;
    if (status >= 500) console.error(err);
    res.status(status).json({ error: err.message || "Something went wrong searching for that brand." });
  }
}

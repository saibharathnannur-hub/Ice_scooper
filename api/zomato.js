// Vercel serverless function for POST /api/zomato.
import { lookupZomatoOutlets } from "../src/zomatoLookup.js";
import { ZomatoError } from "../src/zomato.js";
import { createRateLimiter, clientIp } from "../src/rateLimit.js";

// Each lookup is a paid Apify run (about $0.002 per outlet).
const MAX_LOOKUPS_PER_WINDOW = 12;
const isRateLimited = createRateLimiter({ windowMs: 10 * 60 * 1000, max: MAX_LOOKUPS_PER_WINDOW });

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Use POST." });
  }

  if (isRateLimited(clientIp(req))) {
    return res.status(429).json({
      error: `Zomato lookup limit reached (${MAX_LOOKUPS_PER_WINDOW} per 10 minutes). Please try again in a few minutes.`,
    });
  }

  try {
    res.status(200).json(await lookupZomatoOutlets(req.body?.urls ?? req.body?.url));
  } catch (err) {
    const status = err instanceof ZomatoError ? err.status : 500;
    if (status >= 500) console.error(err);
    res.status(status).json({ error: err.message || "Something went wrong looking up Zomato ratings." });
  }
}

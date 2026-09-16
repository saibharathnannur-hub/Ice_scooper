// Vercel serverless function for POST /api/sales.
import { fetchCompanySales } from "../src/companySales.js";
import { createRateLimiter, clientIp } from "../src/rateLimit.js";

// One search credit and one Gemini call per lookup, so keep it modest.
const MAX_PER_WINDOW = 12;
const isRateLimited = createRateLimiter({ windowMs: 10 * 60 * 1000, max: MAX_PER_WINDOW });

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Use POST." });
  }
  if (isRateLimited(clientIp(req))) {
    return res.status(429).json({ error: "Revenue lookup limit reached. Try again in a few minutes." });
  }

  try {
    res.status(200).json((await fetchCompanySales(req.body?.brand)) || { figures: [] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Couldn't look up revenue figures." });
  }
}

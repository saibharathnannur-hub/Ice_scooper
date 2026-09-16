// Vercel serverless function for POST /api/scan.
import { scanSite, ScanError } from "../src/scan.js";
import { createRateLimiter, clientIp } from "../src/rateLimit.js";

// Keeps one visitor from burning the whole Gemini free quota.
const MAX_SCANS_PER_WINDOW = 5;
const isRateLimited = createRateLimiter({ windowMs: 10 * 60 * 1000, max: MAX_SCANS_PER_WINDOW });

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Use POST." });
  }

  if (isRateLimited(clientIp(req))) {
    return res
      .status(429)
      .json({ error: `Scan limit reached (${MAX_SCANS_PER_WINDOW} per 10 minutes). Please try again in a few minutes.` });
  }

  try {
    res.status(200).json(await scanSite(req.body?.urls ?? req.body?.url, { zomatoUrls: req.body?.zomatoUrls, brand: req.body?.brand }));
  } catch (err) {
    const status = err instanceof ScanError ? err.status : 500;
    if (status === 500) console.error(err);
    res.status(status).json({ error: err.message || "Something went wrong while scanning that site." });
  }
}

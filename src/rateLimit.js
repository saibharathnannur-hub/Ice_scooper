// Best-effort per-IP limits for the public Vercel functions.
// Serverless instances don't share memory, so this slows abuse rather than fully stopping it.
export function createRateLimiter({ windowMs, max }) {
  const hits = new Map();
  return function isRateLimited(ip) {
    const now = Date.now();
    const recent = (hits.get(ip) || []).filter((t) => now - t < windowMs);
    const limited = recent.length >= max;
    if (!limited) recent.push(now);
    hits.set(ip, recent);
    return limited;
  };
}

export function clientIp(req) {
  return String(req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "unknown")
    .split(",")[0]
    .trim();
}

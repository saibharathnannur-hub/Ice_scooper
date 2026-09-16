// Company-level revenue, gathered from public reporting.
//
// What is NOT available anywhere: per-flavour or per-product sales figures. No company publishes them, and no
// open database carries them. What can be found is company turnover for listed companies and for large private
// ones that get reported in the press, so that is what this returns - always with the source it came from.
import { generateWithFallback } from "./gemini.js";

const CACHE_MS = 24 * 60 * 60 * 1000;
const TAVILY_TIMEOUT_MS = 20000;
const cache = new Map();

async function searchRevenue(brandName) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TAVILY_TIMEOUT_MS);
  try {
    const res = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.TAVILY_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        query: `${brandName} ice cream company annual revenue turnover crore`,
        search_depth: "basic",
        max_results: 8,
      }),
      signal: controller.signal,
    });
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data.results) ? data.results : [];
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchCompanySales(brandName) {
  if (!brandName || !process.env.TAVILY_API_KEY) return null;

  const key = brandName.toLowerCase();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;

  const results = await searchRevenue(brandName);
  if (results.length === 0) return null;

  const sources = results.map((r, i) => `${i + 1}. ${r.url}\n   ${r.title}\n   ${String(r.content || "").slice(0, 400)}`);
  const prompt = `From these search results, list the reported company revenue (turnover) figures for the ice cream company "${brandName}".

SEARCH RESULTS:
${sources.join("\n")}

Reply with ONLY JSON: {"company": string|null, "figures": [{"period": string, "amount": string, "basis": string|null, "sourceIndex": number}], "note": string|null}
- Only use figures that actually appear in the results above. Never estimate, convert or infer a figure.
- "period": the financial year or year the figure is for, exactly as stated (e.g. "FY2025", "CY2024").
- "amount": the figure as written, with its unit (e.g. "₹1,238 crore").
- "basis": "standalone", "consolidated", "group" or similar if the result says so, else null.
- "sourceIndex": the number of the result the figure came from.
- List at most 5 figures, newest first. Use [] if none of the results state a revenue figure for this company.
- "note": mention here if sources disagree, or if the figure covers a parent company rather than the ice cream business alone.`;

  let data;
  try {
    const { response } = await generateWithFallback({
      contents: prompt,
      config: { responseMimeType: "application/json", temperature: 0 },
    });
    data = JSON.parse(response.text);
  } catch {
    return null;
  }

  const figures = (Array.isArray(data.figures) ? data.figures : [])
    .map((f) => {
      const source = results[Number(f.sourceIndex) - 1];
      if (!source || !f.period || !f.amount) return null;
      return {
        period: String(f.period),
        amount: String(f.amount),
        basis: f.basis ? String(f.basis) : null,
        sourceTitle: source.title || null,
        sourceUrl: source.url,
      };
    })
    .filter(Boolean)
    .slice(0, 5);

  const value = figures.length
    ? {
        company: data.company || brandName,
        figures,
        note: data.note || null,
        caveat: "Company-wide turnover from public reporting. Per-flavour sales are not published by anyone.",
      }
    : null;

  cache.set(key, { at: Date.now(), value });
  return value;
}

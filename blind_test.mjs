const base = "https://icecream-scout.vercel.app";
const post = (p, b) => fetch(`${base}${p}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) })
  .then(async (r) => ({ status: r.status, data: await r.json().catch(() => ({})) }));

// brands never tested before: regional, new-age, international
const brands = ["Dinshaw's", "Rollick", "Hangyo", "Dairy Day", "Top n Town", "Get-A-Whey", "Minus 30", "Haagen-Dazs"];

for (const brand of brands) {
  const t = Date.now();
  try {
    const b = await post("/api/brand", { name: brand });
    if (b.data.error) { console.log(`${brand.padEnd(13)} ✗ BRAND SEARCH — ${b.data.error.slice(0, 55)}`); continue; }
    const sites = b.data.websites || [];
    const outlets = (b.data.zomatoOutlets || []).map((o) => o.url);
    const s = await post("/api/scan", { urls: sites, zomatoUrls: outlets, brand: b.data.brand || brand });
    if (s.data.error) { console.log(`${brand.padEnd(13)} ✗ SCAN — site=${sites[0] || "none"} — ${s.data.error.slice(0, 50)}`); continue; }
    const d = s.data, n = (f) => d.products.filter(f).length;
    const priced = n((p) => p.price != null || p.sizes?.some((x) => x.price != null));
    console.log(`${brand.padEnd(13)} ✓ ${String(Math.round((Date.now() - t) / 1000)).padStart(3)}s | site=${(sites[0] || "none").replace(/^https?:\/\/(www\.)?/, "").slice(0, 24).padEnd(24)} | flav=${String(d.products.length).padStart(3)} ingr=${String(n((p) => p.ingredients?.length)).padStart(3)} size=${String(n((p) => p.sizes?.length)).padStart(3)} price=${String(priced).padStart(3)} | outlets=${outlets.length}`);
  } catch (e) { console.log(`${brand.padEnd(13)} ✗ ERROR ${String(e.message).slice(0, 50)}`); }
}

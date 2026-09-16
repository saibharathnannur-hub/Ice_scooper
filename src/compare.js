// Compares a scanned brand against your own catalogue (src/myBrand.json) and returns three blocks for the page.
// Everything here is computed, not generated, so the numbers can be checked by hand.
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const myBrand = require("./myBrand.json");

// Words that say nothing about the flavour itself.
const NOISE = new Set([
  "ice", "cream", "icecream", "creams", "tub", "cup", "pack", "packs", "scoop", "scoops", "cone", "cones",
  "the", "and", "with", "our", "signature", "classic", "premium", "gourmet", "special", "delight", "flavour",
  "flavor", "ml", "litre", "liter", "gm", "gms", "kg", "family", "combo", "sundae", "bar", "stick", "party",
]);

function tokens(name) {
  return new Set(
    String(name || "")
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2 && !NOISE.has(w) && !/^\d+$/.test(w))
  );
}

function matchFlavors(mine, theirs) {
  const matches = [];
  for (const my of mine) {
    const myTokens = tokens(my.flavor);
    if (myTokens.size === 0) continue;

    let best = null;
    for (const their of theirs) {
      const theirTokens = tokens(their.flavor);
      const shared = [...myTokens].filter((t) => theirTokens.has(t));
      if (shared.length === 0) continue;
      // How much of each name the shared words account for; both matter, so use the smaller share.
      const score = shared.length / Math.max(myTokens.size, theirTokens.size);
      if (!best || score > best.score) best = { their, shared, score };
    }
    if (best) matches.push({ mine: my, theirs: best.their, shared: best.shared, exact: best.score === 1 });
  }
  return matches;
}

function pricedSizes(products) {
  return products.flatMap((p) =>
    (p.sizes || [])
      .filter((s) => s.price != null && s.ml)
      .map((s) => ({ flavor: p.flavor, label: s.label, ml: s.ml, price: s.price, per100: (s.price / s.ml) * 100 }))
  );
}

function sizeLabels(products) {
  const seen = new Map();
  for (const p of products) {
    for (const s of p.sizes || []) {
      const key = s.ml != null ? `${s.ml} ml` : s.label;
      if (key && !seen.has(key)) seen.set(key, s.ml ?? null);
    }
  }
  return [...seen.entries()].sort((a, b) => (a[1] ?? 1e9) - (b[1] ?? 1e9)).map(([label]) => label);
}

function round(n) {
  return Math.round(n * 10) / 10;
}

export function compareWithMyBrand(result) {
  const theirs = (result?.products || []).filter((p) => p.flavor);
  const mine = myBrand.products || [];
  if (theirs.length === 0) return null;

  const theirName = result.brand || "This brand";
  const matches = matchFlavors(mine, theirs);
  const matchedTheirs = new Set(matches.map((m) => m.theirs.flavor));

  // 1. Flavours both brands make
  const shared = {
    kind: "shared",
    title: "Flavours you both make",
    headline: matches.length
      ? `${matches.length} of your ${mine.length} flavours have a match at ${theirName}`
      : `No overlap with ${theirName}'s range`,
    rows: matches.map((m) => ({
      mine: m.mine.flavor,
      theirs: m.theirs.flavor,
      exact: m.exact,
      theirSizes: (m.theirs.sizes || []).map((s) => s.label).filter(Boolean),
      theirPrice: (m.theirs.sizes || []).find((s) => s.price != null)?.price ?? m.theirs.price ?? null,
    })),
    note: matches.length
      ? "Matched on the flavour words in each name, so treat close matches as a starting point."
      : `Nothing in ${theirName}'s range shares a flavour word with yours.`,
  };

  // 2. Pack sizes and prices
  const theirPriced = pricedSizes(theirs);
  const myPriced = pricedSizes(mine);
  const theirPer100 = theirPriced.map((s) => s.per100).sort((a, b) => a - b);
  const mySizes = sizeLabels(mine);
  const theirSizes = sizeLabels(theirs);

  const pricing = {
    kind: "pricing",
    title: "Pack sizes and prices",
    headline: theirPriced.length
      ? `${theirName} prices run ₹${round(theirPer100[0])}-${round(theirPer100[theirPer100.length - 1])} per 100 ml`
      : `${theirName} doesn't publish prices`,
    mySizes,
    theirSizes,
    myPricedCount: myPriced.length,
    examples: theirPriced
      .slice()
      .sort((a, b) => a.per100 - b.per100)
      .slice(0, 4)
      .map((s) => ({ flavor: s.flavor, label: s.label, price: s.price, per100: round(s.per100) })),
    note: theirPriced.length
      ? myPriced.length
        ? "Both brands publish prices, so the per-100 ml figures are directly comparable."
        : "Your catalogue has no prices yet, so only their side can be priced. Add prices to src/myBrand.json to compare."
      : "Neither side can be compared on price until one of you publishes it.",
  };

  // 3. Range and gaps
  const unmatchedTheirs = theirs.filter((p) => !matchedTheirs.has(p.flavor));
  const range = {
    kind: "range",
    title: "Range and gaps",
    headline: `${theirName} lists ${theirs.length} flavours to your ${mine.length}`,
    theyHaveYouDont: unmatchedTheirs.slice(0, 6).map((p) => p.flavor),
    youHaveTheyDont: mine.filter((p) => !matches.some((m) => m.mine.flavor === p.flavor)).map((p) => p.flavor),
    theirSizeCount: theirSizes.length,
    mySizeCount: mySizes.length,
    note:
      unmatchedTheirs.length > 6
        ? `${unmatchedTheirs.length - 6} more of their flavours aren't shown here.`
        : "",
  };

  return { myBrand: myBrand.name, theirBrand: theirName, blocks: [shared, pricing, range] };
}

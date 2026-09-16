import "./env.js";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scanSite, ScanError } from "./scan.js";
import { findBrandLinks, BrandSearchError } from "./brandSearch.js";
import { lookupZomatoOutlets } from "./zomatoLookup.js";
import { ZomatoError } from "./zomato.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, "..", "public")));

app.post("/api/scan", async (req, res) => {
  try {
    res.json(await scanSite(req.body?.urls ?? req.body?.url, { zomatoUrls: req.body?.zomatoUrls }));
  } catch (err) {
    const status = err instanceof ScanError ? err.status : 500;
    if (status === 500) console.error(err);
    res.status(status).json({ error: err.message || "Something went wrong while scanning that site." });
  }
});

app.post("/api/brand", async (req, res) => {
  try {
    res.json(await findBrandLinks(req.body?.name));
  } catch (err) {
    const status = err instanceof BrandSearchError ? err.status : 500;
    if (status >= 500) console.error(err);
    res.status(status).json({ error: err.message || "Something went wrong searching for that brand." });
  }
});

app.post("/api/zomato", async (req, res) => {
  try {
    res.json(await lookupZomatoOutlets(req.body?.urls ?? req.body?.url));
  } catch (err) {
    const status = err instanceof ZomatoError ? err.status : 500;
    if (status >= 500) console.error(err);
    res.status(status).json({ error: err.message || "Something went wrong looking up Zomato ratings." });
  }
});

app.listen(PORT, () => {
  console.log(`🍦 Ice Cream Scout running at http://localhost:${PORT}`);
});

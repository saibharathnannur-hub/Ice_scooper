# 🍦 Ice Cream Scout

Type an ice cream brand's name (or paste its website) and get its flavors, ingredients, pack sizes and prices,
plus Zomato ratings for its outlets.

Live: https://icecream-scout.vercel.app

## How it works

A brand name is turned into links, then several sources are read and merged into one table:

| Source | What it provides | Notes |
| --- | --- | --- |
| The brand's own website | flavors, ingredients, sizes, prices | up to 3 of the brand's own sites; the main one first |
| Zomato (via Apify) | outlet ratings and review counts; menu items as a fallback | Zomato hides menu prices from logged-out visitors, so prices never come from here |
| DMart storefront API | selling price, MRP and pack size for packaged brands | blocks cloud servers, so this only fills in when running locally |
| Open Food Facts | ingredients printed on the pack | free and open (ODbL) |

The brand's own site is always preferred. The other sources are only used when the table would otherwise be
half empty, and both extraction passes are merged so a column can only ever gain data.

## Setup

```bash
npm install
cp .env.example .env   # then fill in your keys
npm start              # http://localhost:3000
```

On Windows, `npm.cmd start` works if PowerShell blocks `npm`, or double-click `start.bat`.

### Keys

All three have free tiers that need no credit card. The app degrades gracefully when one is missing.

| Variable | Used for | Free tier |
| --- | --- | --- |
| `GEMINI_API_KEY` | reading pages and building the table | [aistudio.google.com/apikey](https://aistudio.google.com/apikey) |
| `TAVILY_API_KEY` | turning a brand name into links | 1,000 searches a month |
| `APIFY_TOKEN` | fetching Zomato from a server Zomato doesn't block | $5 credit a month |

Without `APIFY_TOKEN` the app reads Zomato directly, which works locally but not from a cloud host.

## Known limits

- **Prices are the weak column.** They appear when the brand's own site publishes them. Delivery apps hide
  prices from logged-out visitors, and DMart blocks cloud servers.
- **Scans take 25-105 seconds**, longer when the fallback sources are needed.
- **Swiggy and Blinkit are not supported.** Both block automated reading, and this app does not try to
  get around that.
- Free Gemini models hit daily limits; the app falls back through several models automatically.

## Layout

```
api/        Vercel serverless endpoints (scan, brand, zomato)
src/        the actual logic, shared by Vercel and the local Express server
public/     the single-page frontend
```

const searchForm = document.getElementById("search-form");
const queryInput = document.getElementById("query-input");
const searchBtn = document.getElementById("search-btn");
const statusEl = document.getElementById("status");

const foundEl = document.getElementById("found");
const foundBrandEl = document.getElementById("found-brand");
const foundWebsitesEl = document.getElementById("found-websites");
const foundWarnEl = document.getElementById("found-warning");
const foundOutletsEl = document.getElementById("found-outlets");
const goBtn = document.getElementById("go-btn");

const zomatoEl = document.getElementById("zomato");
const zomatoErrorEl = document.getElementById("zomato-error");
const zomatoOutletsEl = document.getElementById("zomato-outlets");
const zomatoNoteEl = document.getElementById("zomato-note");

const resultsEl = document.getElementById("results");
const brandNameEl = document.getElementById("brand-name");
const notesEl = document.getElementById("notes");
const bodyEl = document.getElementById("results-body");
const pagesScannedEl = document.getElementById("pages-scanned");

const comparisonEl = document.getElementById("comparison");
const comparisonTitleEl = document.getElementById("comparison-title");
const comparisonSubEl = document.getElementById("comparison-sub");
const compareGridEl = document.getElementById("compare-grid");

const salesEl = document.getElementById("sales");
const salesTitleEl = document.getElementById("sales-title");
const salesListEl = document.getElementById("sales-list");
const salesNoteEl = document.getElementById("sales-note");

const CURRENCY_SYMBOLS = { INR: "₹", USD: "$", EUR: "€", GBP: "£", AUD: "A$", CAD: "C$", SGD: "S$", AED: "AED " };
const MISSING = `<span class="missing">Not found</span>`;

let found = null; // last brand search result

function setStatus(text, isError = false) {
  statusEl.hidden = !text;
  statusEl.textContent = text || "";
  statusEl.classList.toggle("error", isError);
}

function setBusy(busy) {
  searchBtn.disabled = busy;
  goBtn.disabled = busy || !found || ((found.websites || []).length === 0 && found.zomatoOutlets.length === 0);
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function sizeLabel(s) {
  return s.label || (s.ml ? `${s.ml} ml` : "size not stated");
}

function renderSizes(sizes) {
  if (!sizes || sizes.length === 0) return MISSING;
  return sizes
    .map((s) => `<span class="size-chip">${escapeHtml(sizeLabel(s))}</span>`)
    .join("");
}

function formatPrice(price, currency) {
  if (price == null || price === "") return null;
  const n = Number(price);
  if (!Number.isFinite(n)) return String(price);
  const amount = Number.isInteger(n) ? String(n) : n.toFixed(2);
  const cur = (currency || "").toUpperCase();
  if (CURRENCY_SYMBOLS[cur]) return `${CURRENCY_SYMBOLS[cur]}${amount}`;
  return cur ? `${amount} ${cur}` : amount;
}

function renderPrices(p) {
  const sized = (p.sizes || [])
    .map((s) => ({ label: sizeLabel(s), price: formatPrice(s.price, s.currency || p.currency) }))
    .filter((s) => s.price);

  if (sized.length) {
    return sized
      .map(
        (s) =>
          `<div class="price-line"><span class="price-label">${escapeHtml(s.label)}</span> <strong>${escapeHtml(s.price)}</strong></div>`
      )
      .join("");
  }

  const single = formatPrice(p.price, p.currency);
  return single ? `<strong>${escapeHtml(single)}</strong>` : MISSING;
}

function render(data) {
  brandNameEl.textContent = data.brand ? `🏷️ ${data.brand}` : "Results";
  notesEl.textContent = data.notes || "";

  bodyEl.innerHTML = "";
  if (!data.products || data.products.length === 0) {
    bodyEl.innerHTML = `<tr><td colspan="4">No flavors found on the scanned pages.</td></tr>`;
  } else {
    for (const p of data.products) {
      const tr = document.createElement("tr");
      const ingredients = p.ingredients && p.ingredients.length
        ? escapeHtml(p.ingredients.join(", "))
        : MISSING;
      tr.innerHTML = `
        <td><strong>${escapeHtml(p.flavor || "Unknown")}</strong>${p.description ? `<div style="color:var(--muted);font-size:0.85rem;margin-top:4px;">${escapeHtml(p.description)}</div>` : ""}</td>
        <td>${ingredients}</td>
        <td>${renderSizes(p.sizes)}</td>
        <td>${renderPrices(p)}</td>
      `;
      bodyEl.appendChild(tr);
    }
  }

  const sitesScanned = data._meta?.sitesScanned || [];
  notesEl.textContent = [
    data.notes,
    sitesScanned.length > 1 ? `Merged from ${sitesScanned.length} sites.` : "",
    data._meta?.usedZomatoMenu ? "Flavors filled in from the Zomato menu (Zomato doesn't show prices)." : "",
    data._meta?.usedRetailPrices ? "Prices filled in from DMart retail listings." : "",
    data._meta?.usedShoppingPrices ? "Prices filled in from shopping listings." : "",
    data._meta?.usedWebPrices ? "Some prices come from web mentions and may be out of date." : "",
    data._meta?.usedProductLabels ? "Ingredients filled in from Open Food Facts pack labels." : "",
  ]
    .filter(Boolean)
    .join(" ");

  pagesScannedEl.innerHTML = "";
  (data._meta?.pagesScanned || []).forEach((u) => {
    const li = document.createElement("li");
    li.textContent = u;
    pagesScannedEl.appendChild(li);
  });

  resultsEl.hidden = false;
  renderComparison(data.comparison);

  // Revenue is looked up separately so it can never hold up or break the table.
  if (data.brand) {
    postJson("/api/sales", { brand: data.brand }).then(renderSales, () => {});
  }
}

const tags = (items) => items.map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join("") || MISSING;

function compareCard(block) {
  let body = "";
  if (block.kind === "shared") {
    body = block.rows.length
      ? `<ul class="compare-list">${block.rows
          .map(
            (r) => `<li><strong>${escapeHtml(r.mine)}</strong><br /><span class="compare-vs">vs ${escapeHtml(r.theirs)}${
              r.exact ? "" : " (close match)"
            }${r.theirPrice != null ? ` · ₹${escapeHtml(r.theirPrice)}` : ""}</span></li>`
          )
          .join("")}</ul>`
      : `<p class="compare-note">${MISSING}</p>`;
  } else if (block.kind === "pricing") {
    body = `<ul class="compare-list">
        <li>Your sizes: ${tags(block.mySizes)}</li>
        <li>Their sizes: ${tags(block.theirSizes)}</li>
        ${block.examples
          .map(
            (e) =>
              `<li>${escapeHtml(e.flavor)} <span class="compare-vs">${escapeHtml(e.label)} · ₹${escapeHtml(
                e.price
              )} · ₹${escapeHtml(e.per100)}/100ml</span></li>`
          )
          .join("")}
      </ul>`;
  } else {
    body = `<ul class="compare-list">
        <li>They make, you don't: ${tags(block.theyHaveYouDont)}</li>
        <li>You make, they don't: ${tags(block.youHaveTheyDont)}</li>
      </ul>`;
  }

  return `<article class="compare-card">
      <h3>${escapeHtml(block.title)}</h3>
      <p class="compare-headline">${escapeHtml(block.headline)}</p>
      ${body}
      ${block.note ? `<p class="compare-note">${escapeHtml(block.note)}</p>` : ""}
    </article>`;
}

function renderComparison(comparison) {
  if (!comparison) {
    comparisonEl.hidden = true;
    return;
  }
  comparisonTitleEl.textContent = `⚖️ ${comparison.myBrand} vs ${comparison.theirBrand}`;
  comparisonSubEl.textContent = "Worked out from the table above";
  compareGridEl.innerHTML = comparison.blocks.map(compareCard).join("");
  comparisonEl.hidden = false;
}

function renderSales(sales) {
  if (!sales || !sales.figures?.length) {
    salesEl.hidden = true;
    return;
  }
  salesTitleEl.textContent = `📈 ${sales.company}: reported revenue`;
  salesListEl.innerHTML = sales.figures
    .map(
      (f) => `<li><strong>${escapeHtml(f.period)}</strong> — ${escapeHtml(f.amount)}${
        f.basis ? ` <span class="compare-vs">(${escapeHtml(f.basis)})</span>` : ""
      } <a href="${escapeHtml(f.sourceUrl)}" target="_blank" rel="noopener">source ↗</a></li>`
    )
    .join("");
  salesNoteEl.textContent = [sales.note, sales.caveat].filter(Boolean).join(" ");
  salesEl.hidden = false;
}

function placeLabel(o) {
  return [o.area, o.city].filter(Boolean).join(", ") || o.address || "";
}

function outletLink(url) {
  return url ? ` <a href="${escapeHtml(url)}" target="_blank" rel="noopener" title="Open on Zomato">↗</a>` : "";
}

function renderFound(r) {
  // brand is null when the search couldn't confirm the results really belong to this brand.
  foundBrandEl.textContent = r.brand ? `🔎 ${r.brand}` : `🔎 ${r.query} (unconfirmed)`;
  foundWarnEl.textContent = r.brand
    ? ""
    : "Couldn't confirm these belong to that brand — check the website link before trusting the results.";
  foundWarnEl.hidden = Boolean(r.brand);

  const sites = r.websites || (r.website ? [r.website] : []);
  foundWebsitesEl.innerHTML = sites.length
    ? sites
        .map(
          (url, i) => `<li><label>
            <input type="checkbox" value="${escapeHtml(url)}" checked />
            <span><strong>${escapeHtml(url)}</strong> <span class="outlet-place">${i === 0 ? "main site" : "also scanned"}</span></span>
          </label></li>`
        )
        .join("")
    : `<li>${MISSING}</li>`;

  foundOutletsEl.innerHTML = r.zomatoOutlets.length
    ? r.zomatoOutlets
        .map(
          (o) => `<li><label>
            <input type="checkbox" value="${escapeHtml(o.url)}" checked />
            <span><strong>${escapeHtml(o.name || "Outlet")}</strong> <span class="outlet-place">${escapeHtml(placeLabel(o))}</span>${outletLink(o.url)}</span>
          </label></li>`
        )
        .join("")
    : `<li>${MISSING}</li>`;

  foundEl.hidden = false;
}

function ratingPill(r) {
  const n = Number(r.rating);
  const count = Number(String(r.reviewCount ?? "").replace(/[^0-9.]/g, ""));
  const reviews = r.reviewCount && count !== 0 ? ` · ${escapeHtml(r.reviewCount)} reviews` : "";
  return `<span class="rating-pill"><strong>${escapeHtml(Number.isFinite(n) ? n.toFixed(1) : r.rating)} ★</strong> ${escapeHtml(r.type)}${reviews}</span>`;
}

function renderZomato(data) {
  const outlets = data.outlets || [];
  zomatoErrorEl.hidden = true;
  zomatoOutletsEl.innerHTML = outlets.length
    ? outlets
        .map(
          (o) => `<li>
            <strong>${escapeHtml(o.name || "Outlet")}</strong> <span class="outlet-place">${escapeHtml(placeLabel(o))}</span>${outletLink(o.url)}
            <div class="zomato-ratings">${o.ratings.length ? o.ratings.map(ratingPill).join("") : MISSING}</div>
          </li>`
        )
        .join("")
    : `<li>${MISSING}</li>`;

  const failed = (data.errors || []).length;
  zomatoNoteEl.textContent = [failed ? `Couldn't read ${failed} outlet${failed > 1 ? "s" : ""}.` : "", data.note || ""]
    .filter(Boolean)
    .join(" ");
  zomatoEl.hidden = false;
}

function renderZomatoError(message) {
  zomatoOutletsEl.innerHTML = "";
  zomatoNoteEl.textContent = "";
  zomatoErrorEl.textContent = message;
  zomatoErrorEl.hidden = false;
  zomatoEl.hidden = false;
}

async function postJson(path, body) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  let data;
  try {
    data = await res.json();
  } catch {
    throw new Error(`Unexpected response from the server (HTTP ${res.status}). Please try again.`);
  }
  if (!res.ok) throw new Error(data.error || "Something went wrong.");
  return data;
}

// Runs the flavor scan and the Zomato lookup side by side; each card shows as soon as it's ready.
async function runLookups(siteUrls, outletUrls, brand = null) {
  setBusy(true);
  resultsEl.hidden = true;
  comparisonEl.hidden = true;
  salesEl.hidden = true;
  zomatoEl.hidden = true;
  const siteLabel = siteUrls.map((u) => new URL(u).hostname).join(", ");
  setStatus(
    siteUrls.length
      ? `Scanning ${siteLabel} for flavors… this usually takes 30-90 seconds.`
      : "Looking up Zomato ratings…"
  );

  const tasks = [];
  if (outletUrls.length) {
    tasks.push(postJson("/api/zomato", { urls: outletUrls }).then(renderZomato, (err) => renderZomatoError(err.message)));
  }
  if (siteUrls.length || outletUrls.length) {
    tasks.push(
      postJson("/api/scan", { urls: siteUrls, zomatoUrls: outletUrls, brand }).then(
        (data) => {
          setStatus("");
          render(data);
        },
        (err) => setStatus(err.message, true)
      )
    );
  }

  try {
    await Promise.all(tasks);
    if (!siteUrls.length) setStatus("");
  } catch (err) {
    setStatus("Something went wrong showing the results: " + err.message, true);
  } finally {
    setBusy(false);
  }
}

function looksLikeUrl(text) {
  return /^https?:\/\//i.test(text) || /^[^\s]+\.[a-z]{2,}(\/|$)/i.test(text);
}

searchForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const q = queryInput.value.trim();
  if (!q) return;

  found = null;
  foundEl.hidden = true;
  resultsEl.hidden = true;
  comparisonEl.hidden = true;
  salesEl.hidden = true;
  zomatoEl.hidden = true;

  if (looksLikeUrl(q)) {
    let url;
    try {
      url = new URL(/^https?:\/\//i.test(q) ? q : `https://${q}`).toString();
    } catch {
      setStatus("That link doesn't look right.", true);
      return;
    }
    runLookups([url], []);
    return;
  }

  setBusy(true);
  setStatus(`Searching for “${q}”…`);
  try {
    found = await postJson("/api/brand", { name: q });
    setStatus("");
    renderFound(found);
  } catch (err) {
    setStatus(err.message, true);
  } finally {
    setBusy(false);
  }
});

const checkedValues = (listEl) => [...listEl.querySelectorAll("input[type=checkbox]:checked")].map((c) => c.value);

goBtn.addEventListener("click", () => {
  if (!found) return;
  runLookups(checkedValues(foundWebsitesEl), checkedValues(foundOutletsEl), found.brand || found.query);
});

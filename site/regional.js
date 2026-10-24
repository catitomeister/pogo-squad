// Regional Pokémon: which region-locked Pokémon you can find in the place you pick.
// Data is a hand-made list (regional.json). Each Pokémon lists the place tags where it is found;
// each place lists the tags that clearly apply to it ("t") and the ones that might ("m").
const section = document.getElementById("view-rank");        // the Tools tab
const view = document.getElementById("tool-regional");

const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : v; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
};
const plain = s => String(s).normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

let data = null;
let placeId = store.get("pogo.regional.place", "chino");
let filter = store.get("pogo.regional.filter", "all");
let query = "";
const opened = new Set();

const LABEL = { here: "Here", check: "Check", not: "Not here", env: "Environment", special: "Varies" };
const ORDER = { here: 0, check: 1, not: 2, env: 3, special: 4 };

const place = () => data.places.find(p => p.id === placeId) || data.places[0];
const shortName = p => p.n.replace(/ \(home\)$/, "");
function statusOf(m, p) {
  if (m.k) return m.k;                                        // "env" or "special": not about where you are
  if (m.y.some(t => p.t.includes(t))) return "here";
  if (m.y.some(t => p.m.includes(t))) return "check";
  return "not";
}
function moreHtml(m, st, p) {
  const lines = [];
  if (st === "here") lines.push(`Found around ${shortName(p)}.`);
  else if (st === "check") lines.push(`Not clear for ${shortName(p)}. The list says: ${m.w}.`);
  else if (st === "not") lines.push(`Found in: ${m.w}.`, "To get one from here: trade with a friend who lives there, or wait for an event that opens regionals worldwide for a while.");
  if (m.r) lines.push("It's a regional raid boss: it only shows up while it's in the raid rotation.");
  if (m.x) lines.push(m.x);
  return lines.map(l => `<span>${esc(l)}</span>`).join("");
}

function skeleton() {
  const groups = [...new Set(data.places.map(p => p.g))];
  view.innerHTML = `
    <h2 class="sec">Regional Pokémon</h2>
    <p class="sec-sub">These only spawn in parts of the world. Pick where you are, or where you're going, to see what you can catch there.</p>
    <div class="rg-bar">
      <label class="rk-lab" for="rg-place">Where</label>
      <select id="rg-place" class="rk-in">${groups.map(g => `<optgroup label="${esc(g)}">${data.places.filter(p => p.g === g).map(p =>
        `<option value="${esc(p.id)}">${esc(p.n)}</option>`).join("")}</optgroup>`).join("")}</select>
      <input id="rg-q" class="rk-in" type="search" placeholder="Search a Pokémon" autocomplete="off" autocapitalize="off" spellcheck="false">
      <div id="rg-chips" class="rk-seg" role="group" aria-label="Filter"></div>
    </div>
    <div id="rg-list"></div>
    <p class="rk-legend">Source: <a href="${esc(data.source)}" target="_blank" rel="noopener">Pokémon GO Hub</a> (list updated ${esc(data.updated)}). It is put together by the community, so treat it as a guide. “Check” means the wording doesn't clearly include or exclude your place. Events can open regionals worldwide for a while.</p>`;
  view.querySelector("#rg-place").value = place().id;
}

function render() {
  const p = place();
  const rows = data.mons.map(m => ({ m, st: statusOf(m, p) }));
  const count = { all: rows.length, here: 0, check: 0, not: 0, other: 0 };
  for (const r of rows) count[r.st === "env" || r.st === "special" ? "other" : r.st]++;
  if (filter === "check" && !count.check) filter = "all";
  const chips = [["all", "All"], ["here", "Here"], ["check", "Check"], ["not", "Not here"], ["other", "Other"]].filter(([k]) => k !== "check" || count.check);
  view.querySelector("#rg-chips").innerHTML = chips.map(([k, l]) =>
    `<button type="button" data-f="${k}" aria-pressed="${k === filter}">${l} ${count[k]}</button>`).join("");
  const q = plain(query.trim());
  const shown = rows.filter(r => {
    const key = r.st === "env" || r.st === "special" ? "other" : r.st;
    return (filter === "all" || filter === key) && (!q || plain(r.m.n).includes(q) || plain(r.m.w).includes(q));
  }).sort((a, b) => ORDER[a.st] - ORDER[b.st] || a.m.n.localeCompare(b.m.n));
  view.querySelector("#rg-list").innerHTML = shown.length ? shown.map(({ m, st }) => `
    <details class="rg-row" data-n="${esc(m.n)}" data-st="${st}"${opened.has(m.n) ? " open" : ""}>
      <summary><img class="rk-pic rg-pic" src="dex/${encodeURIComponent(m.i)}.webp" alt="" loading="lazy" onerror="this.style.visibility='hidden'">
        <span class="rg-t"><b>${esc(m.n)}</b><span>${esc(m.w)}</span></span><i class="rg-pill ${st}">${LABEL[st]}</i></summary>
      <div class="rg-more">${moreHtml(m, st, p)}</div>
    </details>`).join("") : `<p class="rk-hint">Nothing matches.</p>`;
}

function init() {
  skeleton();
  view.addEventListener("change", e => {
    if (e.target.id === "rg-place") { placeId = e.target.value; store.set("pogo.regional.place", placeId); render(); }
  });
  view.addEventListener("input", e => { if (e.target.id === "rg-q") { query = e.target.value; render(); } });
  view.addEventListener("click", e => {
    const b = e.target.closest("[data-f]");
    if (b) { filter = b.dataset.f; store.set("pogo.regional.filter", filter); render(); }
  });
  view.addEventListener("toggle", e => {
    const n = e.target.dataset && e.target.dataset.n;
    if (n && e.target.classList.contains("rg-row")) { if (e.target.open) opened.add(n); else opened.delete(n); }
  }, true);
  render();
}

// load the list the first time the Regional tool is shown
let started = false;
async function start() {
  if (started) return;
  started = true;
  view.innerHTML = `<p class="quiet">Loading…</p>`;
  try {
    const r = await fetch("regional.json");
    if (!r.ok) throw new Error(r.status);
    data = await r.json();
  } catch {
    view.innerHTML = `<p class="quiet">Couldn't load the list. Check your connection, then open this again.</p>`;
    started = false;
    return;
  }
  init();
}
if (section && view) {
  const check = () => { if (!section.hidden && !view.hidden) start(); };
  const mo = new MutationObserver(check);
  mo.observe(section, { attributes: true, attributeFilter: ["hidden"] });
  mo.observe(view, { attributes: true, attributeFilter: ["hidden"] });
  check();
}

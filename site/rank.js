// Rank checker: where a Pokémon's IVs rank for Great / Ultra / Master League (PvP).
// Everything is calculated in the browser from base stats (pokedex.json); nothing is sent anywhere.
const view = document.getElementById("view-rank");

const LEAGUES = [{ name: "Great", cap: 1500 }, { name: "Ultra", cap: 2500 }, { name: "Master", cap: 99999 }];
// minimum IV per stat depending on where the Pokémon came from
const SOURCES = [
  ["Wild or other", 0], ["Weather boosted", 4], ["Raid, egg or research", 10],
  ["Trade: Good friends", 1], ["Trade: Great friends", 2], ["Trade: Ultra friends", 3], ["Trade: Best friends", 5], ["Lucky", 12],
];
const MAX_LIST = 60;

const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

let dex = null, cpm = null, names = [];
let settings = { cap: 50, src: 0, ...store.get("pogo.rank.settings", {}) };
let list = store.get("pogo.rank.list", []);          // [{k, a, d, s, cap}]
let sel = null;                                       // key of the Pokémon you typed, e.g. "570:Normal"
let iv = { a: "", d: "", s: "" };
let sortLeague = 0, searchLeague = 0, searchTop = 25, target = null;
const openState = {};                                 // result card key -> open?
const added = new Set();                              // "k|a|d|s|cap" just added to the compare list

// ---------- the maths
const cache = new Map();
// Every IV combination (0-15 x3 = 4096) for one species in one league: the best level that stays under the CP cap,
// the resulting CP and stat product, and the rank by stat product.
function table(key, league, cap) {
  const ck = `${key}|${league}|${cap}`;
  if (cache.has(ck)) return cache.get(ck);
  const [, ba, bd, bs] = dex.m[key];
  const maxIdx = (cap - 1) * 2, cpCap = LEAGUES[league].cap;
  const prod = new Float64Array(4096), lvl = new Uint8Array(4096), cp = new Uint16Array(4096);
  for (let a = 0; a < 16; a++) for (let d = 0; d < 16; d++) for (let s = 0; s < 16; s++) {
    const i = a * 256 + d * 16 + s;
    const A = ba + a, D = bd + d, S = bs + s;
    const x = A * Math.sqrt(D) * Math.sqrt(S) / 10;
    const cpAt = j => Math.max(10, Math.floor(x * cpm[j] * cpm[j]));
    let lo = 0, hi = maxIdx;
    if (cpAt(hi) <= cpCap) lo = hi;
    else while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (cpAt(mid) <= cpCap) lo = mid; else hi = mid; }
    const m = cpm[lo];
    prod[i] = A * m * D * m * Math.max(10, Math.floor(S * m));
    lvl[i] = lo; cp[i] = cpAt(lo);
  }
  const order = Array.from({ length: 4096 }, (_, i) => i).sort((p, q) => prod[q] - prod[p]);
  const rank = new Uint16Array(4096);
  for (let r = 0; r < 4096; r++) rank[order[r]] = r > 0 && prod[order[r]] === prod[order[r - 1]] ? rank[order[r - 1]] : r + 1;
  const t = { prod, lvl, cp, rank, order, best: prod[order[0]] };
  cache.set(ck, t);
  return t;
}
const picFile = k => `dex/${encodeURIComponent(k.replace(":", "-"))}.webp`;
const pic = k => `<img class="rk-pic" src="${picFile(k)}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">`;
const ivOf = i => `${i >> 8}/${(i >> 4) & 15}/${i & 15}`;
// rank among only the IVs that are possible from the chosen source (every IV >= floor)
function rankFrom(t, i, floor) {
  let better = 0, total = 0;
  for (let j = 0; j < 4096; j++) {
    if ((j >> 8) >= floor && ((j >> 4) & 15) >= floor && (j & 15) >= floor) { total++; if (t.prod[j] > t.prod[i]) better++; }
  }
  return [better + 1, total];
}
const family = key => {
  const out = [], q = [key];
  while (q.length) for (const c of dex.m[q.shift()][4]) if (c !== key && !out.includes(c)) { out.push(c); q.push(c); }
  return out;
};
const dotClass = r => (r <= 100 ? "g" : r <= 1000 ? "y" : "r");
const validIV = () => ["a", "d", "s"].every(k => iv[k] !== "" && +iv[k] >= 0 && +iv[k] <= 15);
const ivIndex = () => +iv.a * 256 + +iv.d * 16 + +iv.s;
const cards = () => (sel ? [...new Set([...family(sel), sel])] : []);   // evolutions first, then the Pokémon you typed

// ---------- in-game search string (Pokémon GO's appraisal buckets: 0 = IV 0, 1 = 1-5, 2 = 6-10, 3 = 11-14, 4 = 15)
const bucket = v => (v === 0 ? 0 : v <= 5 ? 1 : v <= 10 ? 2 : v <= 14 ? 3 : 4);
function nameTokens(key) {
  const label = dex.m[key][0];
  for (const [p, tag] of [["Alolan ", "alola"], ["Galarian ", "galar"], ["Hisuian ", "hisui"], ["Paldean ", "paldea"]]) {
    if (label.startsWith(p)) return `${label.slice(p.length).toLowerCase()}&${tag}`;
  }
  return label.replace(/ \(.*\)$/, "").toLowerCase();
}
function searchString(heldKey, rankKey, league, topN) {
  const t = table(rankKey, league, settings.cap);
  const lo = [4, 4, 4], hi = [0, 0, 0];
  for (const i of t.order.slice(0, topN)) {
    const b = [bucket(i >> 8), bucket((i >> 4) & 15), bucket(i & 15)];
    for (let x = 0; x < 3; x++) { lo[x] = Math.min(lo[x], b[x]); hi[x] = Math.max(hi[x], b[x]); }
  }
  const part = (x, word) => (lo[x] === 0 && hi[x] === 4 ? "" : `&${lo[x] === hi[x] ? lo[x] : lo[x] + "-" + hi[x]}${word}`);
  let keep = 0;
  for (let i = 0; i < 4096; i++) {
    const b = [bucket(i >> 8), bucket((i >> 4) & 15), bucket(i & 15)];
    if (b.every((v, x) => v >= lo[x] && v <= hi[x])) keep++;
  }
  return { str: nameTokens(heldKey) + part(0, "attack") + part(1, "defense") + part(2, "hp"), keep };
}

// ---------- rendering
function skeleton() {
  view.innerHTML = `
    <h2 class="sec">Rank checker</h2>
    <p class="sec-sub">Where a Pokémon's IVs rank in Great, Ultra and Master League. Worked out on your phone; nothing is sent anywhere.</p>
    <div class="rk-card">
      <label class="rk-lab" for="rk-q">Pokémon</label>
      <input id="rk-q" class="rk-in" type="search" placeholder="Type a name, e.g. Zorua" autocomplete="off" autocapitalize="off" spellcheck="false" enterkeyhint="search">
      <div id="rk-sugg" class="rk-sugg"></div>
      <div class="rk-lab">IVs</div>
      <div class="rk-iv">
        <label>Attack<input id="rk-a" class="rk-in" inputmode="numeric" maxlength="2" placeholder="0–15"></label>
        <label>Defense<input id="rk-d" class="rk-in" inputmode="numeric" maxlength="2" placeholder="0–15"></label>
        <label>HP<input id="rk-s" class="rk-in" inputmode="numeric" maxlength="2" placeholder="0–15"></label>
      </div>
      <details class="rk-set"><summary id="rk-setsum"></summary>
        <label class="rk-lab" for="rk-cap">Level cap</label>
        <select id="rk-cap" class="rk-in"><option value="50">50 (normal)</option><option value="51">51 (Best Buddy)</option></select>
        <label class="rk-lab" for="rk-src">Where did it come from?</label>
        <select id="rk-src" class="rk-in">${SOURCES.map(([n, f]) => `<option value="${f}">${esc(n)} (min IV ${f})</option>`).join("")}</select>
      </details>
    </div>
    <div id="rk-out"></div>
    <h3 class="rk-h">Compare list</h3>
    <div id="rk-list"></div>
    <h3 class="rk-h">Find them in Pokémon GO</h3>
    <div id="rk-search"></div>`;
  const $ = id => view.querySelector("#" + id);
  $("rk-cap").value = String(settings.cap);
  $("rk-src").value = String(settings.src);
  const lastKey = store.get("pogo.rank.last", null);
  if (lastKey && dex.m[lastKey]) { sel = lastKey; $("rk-q").value = dex.m[lastKey][0]; }
}

function renderSettingsSummary() {
  const src = SOURCES.find(([, f]) => f === +settings.src) || SOURCES[0];
  view.querySelector("#rk-setsum").textContent = `Settings · Lv cap ${settings.cap} · ${src[0]} (min IV ${src[1]})`;
}

function renderSuggest(q) {
  const box = view.querySelector("#rk-sugg");
  q = q.trim().toLowerCase();
  if (!q || (sel && dex.m[sel][0].toLowerCase() === q)) { box.innerHTML = ""; return; }
  const hits = names.filter(n => n.lc.includes(q)).sort((a, b) => (b.lc.startsWith(q) - a.lc.startsWith(q)) || a.id - b.id).slice(0, 8);
  box.innerHTML = hits.length
    ? hits.map(h => `<button type="button" class="rk-pick" data-act="pick" data-k="${esc(h.k)}">${pic(h.k)}<em>${esc(h.label)}</em><span>#${h.id}</span></button>`).join("")
    : `<div class="rk-none">No Pokémon called “${esc(q)}”.</div>`;
}

function cardHtml(key, a, d, s, cap, floor, open) {
  const m = dex.m[key], i = a * 256 + d * 16 + s;
  const res = LEAGUES.map((L, li) => {
    const t = table(key, li, cap), r = t.rank[i], lv = 1 + t.lvl[i] / 2;
    return { L, r, pct: t.prod[i] / t.best * 100, cp: t.cp[i], lv, xl: lv > 40, best: ivOf(t.order[0]), from: floor > 0 ? rankFrom(t, i, floor) : null };
  });
  const sig = `${key}|${a}|${d}|${s}|${cap}`;
  const same = table(key, 0, cap).lvl.every(l => l === (cap - 1) * 2);   // never reaches 1500 CP: every league ranks it the same
  return `<details class="rk-mon" data-k="${esc(key)}"${open ? " open" : ""}>
    <summary>${pic(key)}<span class="rk-t"><b>${esc(m[0])}</b><span class="rk-sum">${res.map(x => `${x.L.name} #${x.r}`).join(" · ")}</span></span></summary>
    ${res.map(x => `<div class="rk-row">
      <b>${x.L.name}</b>
      <span>#${x.r} <small>of 4096</small> · ${x.pct.toFixed(1)}%<br><small>CP ${x.cp} · Lv ${x.lv}${x.xl ? " · needs XL" : ""} · best ${x.best}${x.from ? ` · #${x.from[0]} of ${x.from[1]} from this source` : ""}</small></span>
      <i class="rk-dot ${dotClass(x.r)}"></i></div>`).join("")}
    ${same ? `<p class="rk-legend">Stays under 1500 CP even at level ${cap}, so all three leagues rank it the same.</p>` : ""}
    <div class="rk-acts"><button type="button" class="rk-btn${added.has(sig) ? " on" : ""}" data-act="add" data-k="${esc(key)}">${added.has(sig) ? "✓ In compare list" : "+ Compare"}</button></div>
  </details>`;
}

function renderOut() {
  const out = view.querySelector("#rk-out");
  if (!sel) { out.innerHTML = `<p class="rk-hint">Pick a Pokémon to start.</p>`; return; }
  if (!validIV()) { out.innerHTML = `<p class="rk-hint">Enter its three IVs (0–15 each) to see the ranks.</p>`; return; }
  const [a, d, s] = [+iv.a, +iv.d, +iv.s], floor = +settings.src, cap = +settings.cap;
  const src = SOURCES.find(([, f]) => f === floor) || SOURCES[0];
  const warn = Math.min(a, d, s) < floor ? `<p class="rk-warn">These IVs are below the minimum (${floor}) for “${esc(src[0])}”. Check the IVs or the source in Settings.</p>` : "";
  const cs = cards();
  out.innerHTML = warn + cs.map((k, n) => cardHtml(k, a, d, s, cap, floor, k in openState ? openState[k] : n === 0)).join("")
    + `<p class="rk-legend"><i class="rk-dot g"></i> top 100 <i class="rk-dot y"></i> top 1000 <i class="rk-dot r"></i> below. Ranked among all 4096 IV combinations at level cap ${cap}.</p>`;
}

function entryRanks(e) {
  const i = e.a * 256 + e.d * 16 + e.s;
  return LEAGUES.map((L, li) => table(e.k, li, e.cap).rank[i]);
}
function renderList() {
  const box = view.querySelector("#rk-list");
  if (!list.length) { box.innerHTML = `<p class="rk-hint">Nothing yet. Check a Pokémon, then tap “+ Compare” to keep it here and line it up against the others.</p>`; return; }
  const groups = new Map();
  list.forEach((e, idx) => { if (!groups.has(e.k)) groups.set(e.k, []); groups.get(e.k).push({ ...e, idx, r: entryRanks(e) }); });
  box.innerHTML = `<div class="rk-seg" role="group" aria-label="Sort by league">Sort by ${LEAGUES.map((L, li) =>
      `<button type="button" data-act="sort" data-l="${li}" aria-pressed="${li === sortLeague}">${L.name}</button>`).join("")}</div>`
    + [...groups].map(([k, rows]) => {
      rows.sort((p, q) => p.r[sortLeague] - q.r[sortLeague]);
      const text = [`${dex.m[k][0]} IVs (Great / Ultra / Master rank)`, ...rows.slice(0, 8).map(e => `${e.a}/${e.d}/${e.s} · #${e.r[0]} / #${e.r[1]} / #${e.r[2]}`),
        `👉 ${location.origin}${location.pathname}`].join("\n");
      return `<div class="rk-grp"><div class="rk-gh">${pic(k)}<b>${esc(dex.m[k][0])}</b> <span>${rows.length} checked</span>
        <a class="rk-btn" href="https://wa.me/?text=${encodeURIComponent(text)}" target="_blank" rel="noopener">Share</a></div>
        <table class="rk-tb"><tr><th>IVs</th>${LEAGUES.map((L, li) => `<th${li === sortLeague ? ' class="on"' : ""}>${L.name}</th>`).join("")}<th></th><th></th></tr>
        ${rows.map(e => `<tr><td>${e.a}/${e.d}/${e.s}</td>${e.r.map((r, li) => `<td${li === sortLeague ? ' class="on"' : ""}>#${r}</td>`).join("")}
          <td><i class="rk-dot ${dotClass(e.r[sortLeague])}"></i></td><td><button type="button" class="rk-x" data-act="rm" data-i="${e.idx}" aria-label="Remove">✕</button></td></tr>`).join("")}</table></div>`;
    }).join("")
    + `<button type="button" class="rk-link" data-act="clear">Clear list</button><p class="rk-legend">Saved on this phone only.</p>`;
}

function renderSearch() {
  const box = view.querySelector("#rk-search");
  if (!sel) { box.innerHTML = `<p class="rk-hint">Pick a Pokémon above to get a search you can paste into Pokémon GO.</p>`; return; }
  const cs = cards();
  if (!target || !cs.includes(target)) target = cs[0];
  const { str, keep } = searchString(sel, target, searchLeague, searchTop);
  box.innerHTML = `<p class="rk-hint">Paste this into the search bar in Pokémon GO. It lists your ${esc(dex.m[sel][0])} that could rank well, so you only have to check those.</p>
    <div class="rk-seg" role="group" aria-label="League">${LEAGUES.map((L, li) =>
      `<button type="button" data-act="ssl" data-l="${li}" aria-pressed="${li === searchLeague}">${L.name}</button>`).join("")}</div>
    <div class="rk-seg" role="group" aria-label="How many">Keep the best ${[25, 100].map(n =>
      `<button type="button" data-act="sst" data-n="${n}" aria-pressed="${n === searchTop}">Top ${n}</button>`).join("")}</div>
    ${cs.length > 1 ? `<label class="rk-lab" for="rk-target">Rank it as</label><select id="rk-target" class="rk-in">${cs.map(k =>
      `<option value="${esc(k)}"${k === target ? " selected" : ""}>${esc(dex.m[k][0])}</option>`).join("")}</select>` : ""}
    <code class="rk-code" id="rk-code">${esc(str)}</code>
    <div class="rk-acts"><button type="button" class="rk-btn" data-act="cpy">Copy</button></div>
    <p class="rk-legend">Keeps ${keep} of 4096 possible IV combinations (${Math.round(keep / 40.96)}%), including the top ${searchTop} for ${LEAGUES[searchLeague].name} League. The game only sorts IVs into rough bands, so this is a first filter, not an exact rank.</p>`;
}

// ---------- events
function setSel(k) {
  sel = k;
  store.set("pogo.rank.last", k);
  view.querySelector("#rk-q").value = dex.m[k][0];
  view.querySelector("#rk-sugg").innerHTML = "";
  target = null;
  renderOut(); renderSearch();
  view.querySelector("#rk-a").focus();
}
async function copy(text, btn) {
  try { await navigator.clipboard.writeText(text); btn.textContent = "Copied ✓"; }
  catch {
    const r = document.createRange(); r.selectNodeContents(view.querySelector("#rk-code"));
    const sl = getSelection(); sl.removeAllRanges(); sl.addRange(r);
    btn.textContent = "Press and hold to copy";
  }
  setTimeout(() => { btn.textContent = "Copy"; }, 2000);
}

function bind() {
  view.addEventListener("input", e => {
    const t = e.target;
    if (t.id === "rk-q") {
      if (sel && t.value.trim().toLowerCase() !== dex.m[sel][0].toLowerCase()) { sel = null; renderOut(); renderSearch(); }
      renderSuggest(t.value);
    } else if (["rk-a", "rk-d", "rk-s"].includes(t.id)) {
      let v = t.value.replace(/\D/g, "").slice(0, 2);
      if (v !== "" && +v > 15) v = "15";
      t.value = v;
      iv[t.id.slice(3)] = v;
      renderOut();
      if (v.length === 2 || (v !== "" && +v >= 2)) {          // 2-9 or two digits can't grow into another IV: jump ahead
        const next = { "rk-a": "rk-d", "rk-d": "rk-s" }[t.id];
        if (next) { const n = view.querySelector("#" + next); n.focus(); n.select(); } else t.blur();
      }
    }
  });
  view.addEventListener("keydown", e => {
    if (e.key === "Enter" && e.target.id === "rk-q") { const first = view.querySelector(".rk-pick"); if (first) { e.preventDefault(); setSel(first.dataset.k); } }
  });
  view.addEventListener("change", e => {
    const t = e.target;
    if (t.id === "rk-cap" || t.id === "rk-src") {
      settings = { cap: +view.querySelector("#rk-cap").value, src: +view.querySelector("#rk-src").value };
      store.set("pogo.rank.settings", settings);
      renderSettingsSummary(); renderOut(); renderSearch();
    } else if (t.id === "rk-target") { target = t.value; renderSearch(); }
  });
  view.addEventListener("toggle", e => { const k = e.target.dataset && e.target.dataset.k; if (k && e.target.classList.contains("rk-mon")) openState[k] = e.target.open; }, true);
  view.addEventListener("click", e => {
    const b = e.target.closest("[data-act]");
    if (!b) return;
    const act = b.dataset.act;
    if (act === "pick") setSel(b.dataset.k);
    else if (act === "add" && validIV()) {
      const entry = { k: b.dataset.k, a: +iv.a, d: +iv.d, s: +iv.s, cap: +settings.cap };
      const sig = `${entry.k}|${entry.a}|${entry.d}|${entry.s}|${entry.cap}`;
      if (!list.some(x => `${x.k}|${x.a}|${x.d}|${x.s}|${x.cap}` === sig)) {
        list.unshift(entry); list = list.slice(0, MAX_LIST);
        store.set("pogo.rank.list", list);
      }
      added.add(sig);
      renderOut(); renderList();
    } else if (act === "rm") { list.splice(+b.dataset.i, 1); store.set("pogo.rank.list", list); added.clear(); renderOut(); renderList(); }
    else if (act === "sort") { sortLeague = +b.dataset.l; renderList(); }
    else if (act === "ssl") { searchLeague = +b.dataset.l; renderSearch(); }
    else if (act === "sst") { searchTop = +b.dataset.n; renderSearch(); }
    else if (act === "clear") { list = []; store.set("pogo.rank.list", list); added.clear(); renderOut(); renderList(); }
    else if (act === "cpy") copy(view.querySelector("#rk-code").textContent, b);
  });
}

function init() {
  cpm = dex.cpm;
  names = Object.entries(dex.m).map(([k, v]) => ({ k, label: v[0], lc: v[0].toLowerCase(), id: parseInt(k) }));
  skeleton(); bind();
  renderSettingsSummary(); renderOut(); renderList(); renderSearch();
}

// load the Pokémon table the first time the Rank tab is opened
let started = false;
async function start() {
  if (started) return;
  started = true;
  view.innerHTML = `<p class="quiet">Loading…</p>`;
  try {
    const r = await fetch("pokedex.json");
    if (!r.ok) throw new Error(r.status);
    dex = await r.json();
  } catch {
    view.innerHTML = `<p class="quiet">Couldn't load the Pokémon table. Check your connection, then open this tab again.</p>`;
    started = false;
    return;
  }
  init();
}
if (view) {
  new MutationObserver(() => { if (!view.hidden) start(); }).observe(view, { attributes: true, attributeFilter: ["hidden"] });
  if (!view.hidden) start();
}

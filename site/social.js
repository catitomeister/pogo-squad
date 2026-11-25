// Social layer for the website: "who's going" on each event card.
// Data lives in Firestore (rules in firestore.rules). People pick a display name once; no accounts.
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, signInAnonymously, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore, collection, onSnapshot, doc, setDoc, deleteDoc, addDoc, updateDoc,
  arrayUnion, arrayRemove, serverTimestamp, query, where, Timestamp,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const NAME_KEY = "pogo.name";
// The squad. People pick their name from this list (no typing), so names can't drift or duplicate.
const FRIENDS = ["ShoBaoBao", "Bonkechu", "Brian", "Jen", "Eric", "Ethan", "Jackie", "Karina", "Alice"];
const LABELS = { ShoBaoBao: "ShoBaoBao (Cat)" };
const ALIASES = { cat: "ShoBaoBao" };  // old free-typed names -> list name (case-insensitive)
const canonical = n => {
  const k = String(n || "").trim().toLowerCase();
  return FRIENDS.find(f => f.toLowerCase() === k) || ALIASES[k] || "";
};
let me = (() => { try { return canonical(localStorage.getItem(NAME_KEY)); } catch { return ""; } })();
let ready = false, failed = false, failCode = "";
const going = new Map();   // eventId -> [names]
let pending = null;        // action to run after the name is set

// ---------- name chip in the header + name dialog
const header = document.querySelector(".top-inner");
const chip = document.createElement("button");
chip.className = "mechip";
header.insertBefore(chip, header.querySelector(".tabs"));
const dlg = document.createElement("dialog");
dlg.className = "namedlg";
dlg.innerHTML = `<form method="dialog" id="nameform">
  <h3>Who are you?</h3>
  <p></p>
  <div class="pickgrid">${FRIENDS.map(f => `<button type="button" class="pick" data-pick="${esc(f)}">${esc(LABELS[f] || f)}</button>`).join("")}</div>
  <p class="soc-note">Not on the list? Ask Cat to add you.</p>
  <div class="dlgbtns"><button type="button" id="namecancel">Cancel</button></div>
</form>`;
document.body.appendChild(dlg);
function paintChip() { chip.textContent = me ? me : "Set name"; chip.title = me ? "Change your name" : "Set your name"; }
paintChip();
function askName(then) {
  pending = then || null;
  dlg.querySelector("p").textContent = me
    ? `You're ${LABELS[me] || me}. Pick a different name only if this isn't you.`
    : "Tap your name. Friends will see it when you mark an event.";
  dlg.querySelectorAll(".pick").forEach(b => b.classList.toggle("on", b.dataset.pick === me));
  dlg.showModal();
}
chip.onclick = () => askName();
dlg.querySelector("#namecancel").onclick = () => { pending = null; dlg.close(); };
dlg.addEventListener("click", async ev => {
  const b = ev.target.closest("[data-pick]");
  if (!b) return;
  me = b.dataset.pick;
  try { localStorage.setItem(NAME_KEY, me); } catch {}
  paintChip();
  dlg.close();
  const p = pending; pending = null;
  if (p) p(); else fill();
});

// One-time tidy-up: entries saved under names that aren't exactly on the list (e.g. "CAT", "bonkechu")
// are merged into the matching list name. Safe to run from any device; it's a no-op once clean.
let tidied = false;
async function tidyNames() {
  if (tidied) return;
  tidied = true;
  const seen = new Set([...going.values(), ...wishes.values()].flat());
  for (const n of seen) {
    const c = canonical(n);
    if (c && c !== n) await moveName(n, c).catch(e => console.error("tidy", e));
  }
}

// Move everything recorded under one name to another (merging, never duplicating)
async function moveName(from, to) {
  const jobs = [];
  const moveRsvp = (eventId, names) => {
    if (!names.includes(from)) return;
    if (!names.includes(to)) jobs.push(setDoc(doc(db, "rsvps", rsvpId(eventId, to)), { eventId, name: to, ts: serverTimestamp() }));
    jobs.push(deleteDoc(doc(db, "rsvps", rsvpId(eventId, from))));
  };
  for (const [ev, ns] of going) moveRsvp(ev, ns);
  for (const [mon, ns] of wishes) moveRsvp(WISH + mon, ns);
  await Promise.all(jobs);
}
const needName = fn => (me ? fn() : askName(fn));

// Wishlist entries (rsvps with eventId "wish__<Pokémon>") came from a removed feature; keep them out of "going".
const WISH = "wish__";
const wishes = new Map();  // Pokémon name -> [people]
// ---------- calendar: one event as an .ics file, or subscribe to the whole feed
function icsFor(e) {
  const f = s => s.slice(0, 19).replace(/[-:]/g, "") + (s.endsWith("Z") ? "Z" : "");
  const t = s => s.replace(/[\\;,]/g, c => "\\" + c);
  return ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//POGO Squad//EN", "BEGIN:VEVENT",
    `UID:${e.id}@pogo-squad`, `DTSTAMP:${new Date().toISOString().replace(/[-:]/g, "").slice(0, 15)}Z`,
    `DTSTART:${f(e.start)}`, `DTEND:${f(e.end)}`, `SUMMARY:${t(e.name)}`, `LOCATION:${t("The Shoppes at Chino Hills, 13920 City Center Dr, Chino Hills, CA 91709")}`, `DESCRIPTION:${t(location.origin + location.pathname)}`,
    "END:VEVENT", "END:VCALENDAR"].join("\r\n");
}
document.addEventListener("click", ev => {
  const a = ev.target.closest("[data-cal]");
  if (!a) return;
  ev.preventDefault();
  const e = (window.DATA_EVENTS || []).find(x => x.id === a.dataset.cal);
  if (!e) return;
  const url = URL.createObjectURL(new Blob([icsFor(e)], { type: "text/calendar" }));
  const link = Object.assign(document.createElement("a"), { href: url, download: `${e.id}.ics` });
  document.body.appendChild(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
});
const feed = new URL("pogo.ics", location.href);
const sub = document.createElement("div");
sub.className = "calsub";
sub.innerHTML = `<b>📅 Add every event to your calendar</b> (updates itself):
  <a href="webcal://${feed.host}${feed.pathname}">iPhone / Mac</a> ·
  <a href="https://calendar.google.com/calendar/r?cid=${encodeURIComponent("webcal://" + feed.host + feed.pathname)}" target="_blank" rel="noopener">Google Calendar</a>`;
document.getElementById("foot")?.before(sub);

// ---------- WhatsApp share text
const EMOJI = {
  "community-day": "🌟", "pokemon-spotlight-hour": "🔦", "raid-hour": "⚔️", "raid-day": "⚔️",
  "max-battles": "💥", "max-mondays": "💥", "event": "🎉", "wild-area": "🗺️", "pokemon-go-tour": "🎫",
};
const fmtWhen = (s, e) => {
  const a = new Date(s), b = new Date(e);
  const day = d => d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
  const tm = d => d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }).replace(":00", "");
  return a.toDateString() === new Date(b - 1).toDateString() ? `${day(a)}, ${tm(a)}–${tm(b)}` : `${day(a)} – ${day(b)}`;
};
// Short WhatsApp message: what, when, who, link (details live on the site)
function shareText(id) {
  const e = (window.DATA_EVENTS || []).find(x => x.id === id);
  if (!e) return location.href;
  const a = new Date(e.start), z = new Date(e.end);
  const md = d => `${d.toLocaleDateString("en-US", { weekday: "short" })} ${d.getMonth() + 1}/${d.getDate()}`;
  const tm = d => d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }).replace(":00", "");
  const when = a.toDateString() === new Date(z - 1).toDateString()
    ? `${md(a)} · ${tm(a).replace(/\s(AM|PM)$/,(m, p) => (tm(z).endsWith(p) ? "" : " " + p))}–${tm(z)}`
    : `${md(a)} – ${md(z)}`;
  const lines = [`${EMOJI[e.type] || "📅"} ${e.name.replace(/^Gigantamax /, "G-Max ")}`, when];
  const names = going.get(id) || [];
  if (names.length) lines.push(`Going: ${names.join(", ")}`);
  lines.push(`Who's in? 👉 ${location.origin}${location.pathname}`);
  return lines.join("\n");
}
const waLink = id => "https://wa.me/?text=" + encodeURIComponent(shareText(id));

// ---------- render into every .social slot
// noFood (really "long-running"): events of more than 3 days have nobody "going": no "I'm going", calendar or Share
function socialHtml(id, noFood = false) {
  if (noFood) return "";
  if (failed) return `<div class="soc-note">Can't load who's going right now${failCode ? ` (${esc(failCode)})` : ""}.
    <button class="linkish" data-act="retry">Retry</button></div>`;
  if (!ready) return `<div class="soc-note">Loading…</div>`;
  const names = going.get(id) || [];
  const mine = names.includes(me);
  let h = `<div class="goingrow">
    <button class="gobtn${mine ? " on" : ""}" data-act="go" data-ev="${esc(id)}" aria-pressed="${mine}">${mine ? "✓ Going" : "I'm going"}</button>
    <span class="who">${names.length ? names.map(n => n === me ? `<b>${esc(n)}</b>` : esc(n)).join(", ") : "No one yet"}</span>
    <span class="acts"><a class="calbtn" href="#" data-cal="${esc(id)}" aria-label="Add to calendar" title="Add to calendar">📅</a>
    <a class="wabtn" href="${esc(waLink(id))}" target="_blank" rel="noopener" aria-label="Share to WhatsApp">Share</a></span>
  </div>`;
  return h;
}
function fill() {
  document.querySelectorAll(".social[data-ev]").forEach(el => {
    if (el.contains(document.activeElement) && document.activeElement.closest("form")) return; // don't wipe typing
    el.innerHTML = socialHtml(el.dataset.ev, el.dataset.nofood === "1");
  });
}
window.addEventListener("pogo:render", fill);

// ---------- actions
const rsvpId = (ev, name) => `${ev}__${name}`.replace(/\//g, "_").slice(0, 300);
document.addEventListener("click", ev => {
  const b = ev.target.closest("[data-act]");
  if (!b || !b.closest(".social")) return;
  const act = b.dataset.act, id = b.dataset.ev, mid = b.dataset.id;
  if (act === "go") needName(async () => {
    const names = going.get(id) || [];
    const ref = doc(db, "rsvps", rsvpId(id, me));
    try {
      if (names.includes(me)) await deleteDoc(ref);
      else await setDoc(ref, { eventId: id, name: me, ts: serverTimestamp() });
    } catch (e) { report(e); }
  });
  if (act === "retry") location.reload();
});
function fail(where, e) {
  console.error(where, e);
  failed = true;
  failCode = `${where}: ${e && (e.code || e.name) || "error"}`;
  fill();
}
function report(e) {
  console.error(e);
  alert("Couldn't save that. Check your connection and try again.");
}

// ---------- live data
onAuthStateChanged(auth, user => {
  if (!user) return;
  // only recent entries: old events never show, and this keeps daily reads far below the free quota.
  // 150 days so a mark made today for an event ~5 months away (e.g. GO Tour) is still there on the day.
  const since = Timestamp.fromMillis(Date.now() - 150 * 864e5);
  onSnapshot(query(collection(db, "rsvps"), where("ts", ">=", since)), snap => {
    going.clear(); wishes.clear();
    snap.forEach(d => {
      const { eventId, name } = d.data();
      const [map, key] = eventId.startsWith(WISH) ? [wishes, eventId.slice(WISH.length)] : [going, eventId];
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(name);
    });
    for (const v of [...going.values(), ...wishes.values()]) v.sort((a, b) => a.localeCompare(b));
    ready = true; fill();
    tidyNames();
  }, e => fail("rsvps", e));
});
signInAnonymously(auth).catch(e => fail("sign-in", e));
fill();

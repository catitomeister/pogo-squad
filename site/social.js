// Social layer for the website: "who's going" + meetup suggestions on each event card.
// Data lives in Firestore (rules in firestore.rules). People pick a display name once; no accounts.
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, signInAnonymously, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore, collection, onSnapshot, doc, setDoc, deleteDoc, addDoc, updateDoc,
  arrayUnion, arrayRemove, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const NAME_KEY = "pogo.name";
let me = (() => { try { return localStorage.getItem(NAME_KEY) || ""; } catch { return ""; } })();
let ready = false, failed = false, failCode = "";
const going = new Map();   // eventId -> [names]
let meetups = [];          // {id, eventId, when, place, by, plus: []}
let openForm = null;       // eventId whose "suggest meetup" form is open
const drafts = {};         // eventId -> {when, place}
let pending = null;        // action to run after the name is set

// ---------- name chip in the header + name dialog
const header = document.querySelector(".top-inner");
const chip = document.createElement("button");
chip.className = "mechip";
header.insertBefore(chip, header.querySelector(".tabs"));
const dlg = document.createElement("dialog");
dlg.className = "namedlg";
dlg.innerHTML = `<form method="dialog" id="nameform">
  <h3>What's your name?</h3>
  <p>Friends will see it when you mark an event or suggest a meetup.</p>
  <input id="namein" maxlength="24" autocomplete="nickname" placeholder="e.g. Cathy" required>
  <div class="dlgbtns"><button type="button" id="namecancel">Cancel</button><button type="submit" class="primary">Save</button></div>
</form>`;
document.body.appendChild(dlg);
function paintChip() { chip.textContent = me ? me : "Set name"; chip.title = me ? "Change your name" : "Set your name"; }
paintChip();
function askName(then) {
  pending = then || null;
  dlg.querySelector("#namein").value = me;
  dlg.showModal();
}
chip.onclick = () => askName();
dlg.querySelector("#namecancel").onclick = () => { pending = null; dlg.close(); };
dlg.querySelector("#nameform").addEventListener("submit", ev => {
  ev.preventDefault();
  const v = dlg.querySelector("#namein").value.trim().slice(0, 24);
  if (!v) return;
  me = v;
  try { localStorage.setItem(NAME_KEY, me); } catch {}
  paintChip();
  dlg.close();
  const p = pending; pending = null;
  if (p) p(); else fill();
});
const needName = fn => (me ? fn() : askName(fn));

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
function shareText(id) {
  const e = (window.DATA_EVENTS || []).find(x => x.id === id);
  if (!e) return location.href;
  const lines = [`${EMOJI[e.type] || "📅"} ${e.name}`, fmtWhen(e.start, e.end)];
  for (const m of (e.mons || []).slice(0, 3)) {
    lines.push(`${m.name}${m.cp20 ? ` · 100% ${m.cp20}${m.cp25 ? ` / boosted ${m.cp25}` : ""}` : ""}${m.shiny ? " ✨" : ""}`);
  }
  const names = going.get(id) || [];
  if (names.length) lines.push(`Going: ${names.join(", ")}`);
  for (const m of meetups.filter(x => x.eventId === id)) {
    const n = (m.plus || []).length;
    lines.push(`📍 Meetup: ${m.when}${m.place ? " @ " + m.place : ""} (${m.by}${n ? " +" + n : ""})`);
  }
  lines.push("", `Who's in? 👉 ${location.origin}${location.pathname}`);
  return lines.join("\n");
}
const waLink = id => "https://wa.me/?text=" + encodeURIComponent(shareText(id));

// ---------- render into every .social slot
function socialHtml(id) {
  if (failed) return `<div class="soc-note">Can't load who's going right now${failCode ? ` (${esc(failCode)})` : ""}.
    <button class="linkish" data-act="retry">Retry</button></div>`;
  if (!ready) return `<div class="soc-note">Loading…</div>`;
  const names = going.get(id) || [];
  const mine = names.includes(me);
  const ms = meetups.filter(m => m.eventId === id).sort((a, b) => (b.plus?.length || 0) - (a.plus?.length || 0));
  let h = `<div class="goingrow">
    <button class="gobtn${mine ? " on" : ""}" data-act="go" data-ev="${esc(id)}" aria-pressed="${mine}">${mine ? "✓ Going" : "I'm going"}</button>
    <span class="who">${names.length ? names.map(n => n === me ? `<b>${esc(n)}</b>` : esc(n)).join(", ") : "No one yet"}</span>
    <a class="wabtn" href="${esc(waLink(id))}" target="_blank" rel="noopener" aria-label="Share to WhatsApp">Share</a>
  </div>`;
  for (const m of ms) {
    const plus = m.plus || [];
    const iPlus = plus.includes(me);
    h += `<div class="meet">
      <div class="mwhat"><b>${esc(m.when)}</b>${m.place ? ` · ${esc(m.place)}` : ""}</div>
      <div class="mmeta">by ${esc(m.by)}${plus.length ? ` · +1 ${plus.map(esc).join(", ")}` : ""}</div>
      <div class="mbtns">
        ${m.by === me ? `<button data-act="del" data-id="${esc(m.id)}">Remove</button>`
          : `<button class="${iPlus ? "on" : ""}" data-act="plus" data-id="${esc(m.id)}" aria-pressed="${iPlus}">${iPlus ? "✓ +1" : "+1"}</button>`}
      </div>
    </div>`;
  }
  if (openForm === id) {
    const d = drafts[id] || {};
    h += `<form class="meetform" data-ev="${esc(id)}">
      <input name="when" maxlength="40" placeholder="When, e.g. Sat 2pm" value="${esc(d.when || "")}" required>
      <input name="place" maxlength="60" placeholder="Where, e.g. Library Waterfall Wall" value="${esc(d.place || "")}">
      <div class="dlgbtns"><button type="button" data-act="cancelform" data-ev="${esc(id)}">Cancel</button><button type="submit" class="primary">Post</button></div>
    </form>`;
  } else {
    h += `<button class="linkish" data-act="openform" data-ev="${esc(id)}">+ Suggest a meetup</button>`;
  }
  return h;
}
function fill() {
  document.querySelectorAll(".social[data-ev]").forEach(el => {
    if (el.contains(document.activeElement) && document.activeElement.closest("form")) return; // don't wipe typing
    el.innerHTML = socialHtml(el.dataset.ev);
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
  if (act === "openform") needName(() => { openForm = id; fill(); document.querySelector(`.meetform[data-ev="${CSS.escape(id)}"] input`)?.focus(); });
  if (act === "cancelform") { openForm = null; fill(); }
  if (act === "retry") location.reload();
  if (act === "plus") needName(async () => {
    const m = meetups.find(x => x.id === mid); if (!m) return;
    try { await updateDoc(doc(db, "meetups", mid), { plus: (m.plus || []).includes(me) ? arrayRemove(me) : arrayUnion(me) }); }
    catch (e) { report(e); }
  });
  if (act === "del") deleteDoc(doc(db, "meetups", mid)).catch(report);
});
document.addEventListener("input", ev => {
  const f = ev.target.closest(".meetform"); if (!f) return;
  drafts[f.dataset.ev] = { when: f.when.value, place: f.place.value };
});
document.addEventListener("submit", async ev => {
  const f = ev.target.closest(".meetform"); if (!f) return;
  ev.preventDefault();
  const when = f.when.value.trim(), place = f.place.value.trim();
  if (!when) return;
  const id = f.dataset.ev;
  try {
    await addDoc(collection(db, "meetups"), { eventId: id, when, place, by: me, plus: [], ts: serverTimestamp() });
    openForm = null; delete drafts[id];
    document.activeElement?.blur();
    fill();
  } catch (e) { report(e); }
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
  onSnapshot(collection(db, "rsvps"), snap => {
    going.clear();
    snap.forEach(d => {
      const { eventId, name } = d.data();
      if (!going.has(eventId)) going.set(eventId, []);
      going.get(eventId).push(name);
    });
    for (const v of going.values()) v.sort((a, b) => a.localeCompare(b));
    ready = true; fill();
  }, e => fail("rsvps", e));
  onSnapshot(collection(db, "meetups"), snap => {
    meetups = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    fill();
  }, e => fail("meetups", e));
});
signInAnonymously(auth).catch(e => fail("sign-in", e));
fill();

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
// The squad. People pick their name from this list (no typing), so names can't drift or duplicate.
const FRIENDS = ["ShoBaoBao", "Bonkechu", "Brian", "Jen", "Eric", "Ethan", "Jackie", "Karina"];
const LABELS = { ShoBaoBao: "ShoBaoBao (Cat)" };
const ALIASES = { cat: "ShoBaoBao" };  // old free-typed names -> list name (case-insensitive)
const canonical = n => {
  const k = String(n || "").trim().toLowerCase();
  return FRIENDS.find(f => f.toLowerCase() === k) || ALIASES[k] || "";
};
let me = (() => { try { return canonical(localStorage.getItem(NAME_KEY)); } catch { return ""; } })();
let ready = false, failed = false, failCode = "";
const going = new Map();   // eventId -> [names]
let meetups = [];          // {id, eventId, when, place, by, plus: []}
let openForm = null;       // eventId whose food-plan form is open
let editing = null;        // id of the food plan being edited (null = posting a new one)
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
    : "Tap your name. Friends will see it when you mark an event or join a meetup.";
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
let tidied = false, meetupsLoaded = false;
async function tidyNames() {
  if (tidied) return;
  tidied = true;
  const seen = new Set([...going.values(), ...wishes.values()].flat());
  meetups.forEach(m => { seen.add(m.by); (m.plus || []).forEach(n => seen.add(n)); });
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
  for (const m of meetups) {
    const plus = m.plus || [];
    if (m.by === from) {
      // the author can't be edited under the rules, so re-post it under the new name with the same people
      const others = plus.filter(n => n !== from && n !== to);
      jobs.push(addDoc(collection(db, "meetups"), { eventId: m.eventId, when: m.when, place: m.place || "", by: to, plus: [], ts: serverTimestamp() })
        .then(ref => others.length ? updateDoc(ref, { plus: others }) : null)
        .then(() => deleteDoc(doc(db, "meetups", m.id))));
    } else if (plus.includes(from)) {
      const next = [...new Set(plus.map(n => (n === from ? to : n)))].filter(n => n !== m.by);
      jobs.push(updateDoc(doc(db, "meetups", m.id), { plus: next }));
    }
  }
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
    `DTSTART:${f(e.start)}`, `DTEND:${f(e.end)}`, `SUMMARY:${t(e.name)}`, `LOCATION:${t("The Shoppes at Chino Hills, 13920 City Center Dr, Chino Hills, CA 91709")}`, `URL:${e.link}`,
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
    lines.push(`🍜 ${m.when}${m.place ? " · " + m.place : ""} (${m.by}${n ? " +" + n : ""})`);
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
    <span class="acts"><a class="calbtn" href="#" data-cal="${esc(id)}" aria-label="Add to calendar" title="Add to calendar">📅</a>
    <a class="wabtn" href="${esc(waLink(id))}" target="_blank" rel="noopener" aria-label="Share to WhatsApp">Share</a></span>
  </div>`;
  for (const m of ms) {
    const people = [m.by, ...(m.plus || []).filter(n => n !== m.by)];
    const joined = people.includes(me);
    h += `<div class="meet">
      <div class="mwhat">🍜 <b>${esc(m.when)}</b>${m.place ? ` · ${esc(m.place)}` : ""}</div>
      <div class="mmeta">👥 ${people.length} · ${people.map(n => n === me ? `<b>${esc(n)}</b>` : esc(n)).join(", ")}</div>
      <div class="mbtns">
        ${m.by === me ? `<button data-act="edit" data-id="${esc(m.id)}" data-ev="${esc(id)}">Edit</button><button data-act="del" data-id="${esc(m.id)}">Remove</button>`
          : `<button class="${joined ? "on" : "join"}" data-act="plus" data-id="${esc(m.id)}" data-ev="${esc(id)}" aria-pressed="${joined}">${joined ? "✓ Joined" : "Join"}</button>`}
      </div>
    </div>`;
  }
  if (openForm === id) {
    const d = drafts[id] || {};
    const phase = d.phase || "After";
    h += `<form class="meetform" data-ev="${esc(id)}">
      <div class="phase" role="radiogroup" aria-label="Before or after the event">${["Before", "After"].map(p =>
        `<label><input type="radio" name="phase" value="${p}"${p === phase ? " checked" : ""}><span>${p} the event</span></label>`).join("")}</div>
      <input name="place" maxlength="60" placeholder="Where to eat, e.g. Dago Shave Ice" value="${esc(d.place || "")}" required>
      <input name="when" maxlength="28" placeholder="Time (optional), e.g. 5:30pm" value="${esc(d.when || "")}">
      <div class="dlgbtns"><button type="button" data-act="cancelform" data-ev="${esc(id)}">Cancel</button><button type="submit" class="primary">${editing ? "Save" : "Post"}</button></div>
    </form>`;
  } else {
    h += `<button class="linkish" data-act="openform" data-ev="${esc(id)}">🍜 Food before / after?</button>`;
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
  if (act === "openform") needName(() => { openForm = id; editing = null; delete drafts[id]; fill(); document.querySelector(`.meetform[data-ev="${CSS.escape(id)}"] input[name=place]`)?.focus(); });
  if (act === "cancelform") { openForm = null; editing = null; delete drafts[id]; fill(); }
  if (act === "edit") {
    const m = meetups.find(x => x.id === mid); if (!m) return;
    const mm = String(m.when).match(/^(Before|After)(?:\s*·\s*)?(.*)$/);
    const rest = mm ? mm[2].trim() : "";
    drafts[id] = { phase: mm ? mm[1] : "After", when: mm ? (rest === "event" ? "" : rest) : m.when, place: m.place || "" };
    openForm = id; editing = mid; fill();
    document.querySelector(`.meetform[data-ev="${CSS.escape(id)}"] input[name=place]`)?.focus();
  }
  if (act === "retry") location.reload();
  if (act === "plus") needName(async () => {
    const m = meetups.find(x => x.id === mid); if (!m) return;
    const joining = !(m.plus || []).includes(me);
    try {
      await updateDoc(doc(db, "meetups", mid), { plus: joining ? arrayUnion(me) : arrayRemove(me) });
    } catch (e) { report(e); }
  });
  if (act === "del") deleteDoc(doc(db, "meetups", mid)).catch(report);
});
document.addEventListener("input", ev => {
  const f = ev.target.closest(".meetform"); if (!f) return;
  drafts[f.dataset.ev] = { when: f.when.value, place: f.place.value, phase: f.phase.value };
});
document.addEventListener("submit", async ev => {
  const f = ev.target.closest(".meetform"); if (!f) return;
  ev.preventDefault();
  const time = f.when.value.trim(), place = f.place.value.trim();
  if (!place) return;
  const when = (f.phase.value || "After") + (time ? " · " + time : "");
  const id = f.dataset.ev;
  try {
    const old = editing && meetups.find(x => x.id === editing);
    const ref = await addDoc(collection(db, "meetups"), { eventId: id, when, place, by: me, plus: [], ts: serverTimestamp() });
    if (old) {
      // rules only allow changing the join list, so an edit re-posts the plan, keeps who joined, and removes the old one
      const keep = (old.plus || []).filter(n => n !== me);
      if (keep.length) await updateDoc(ref, { plus: keep });
      await deleteDoc(doc(db, "meetups", old.id));
    }
    openForm = null; editing = null; delete drafts[id];
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
    going.clear(); wishes.clear();
    snap.forEach(d => {
      const { eventId, name } = d.data();
      const [map, key] = eventId.startsWith(WISH) ? [wishes, eventId.slice(WISH.length)] : [going, eventId];
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(name);
    });
    for (const v of [...going.values(), ...wishes.values()]) v.sort((a, b) => a.localeCompare(b));
    ready = true; fill();
    if (meetupsLoaded) tidyNames();
  }, e => fail("rsvps", e));
  onSnapshot(collection(db, "meetups"), snap => {
    meetups = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    meetupsLoaded = true;
    fill();
    if (ready) tidyNames();
  }, e => fail("meetups", e));
});
signInAnonymously(auth).catch(e => fail("sign-in", e));
fill();

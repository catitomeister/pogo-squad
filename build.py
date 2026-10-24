"""Build POGO Squad data.

Fetches event + raid data from ScrapedDuck (LeekDuck) and base stats from
pogoapi.net, scrapes key facts from LeekDuck event pages, and computes raid
boss weaknesses and hundo CPs.

Usage:
  python build.py          # artifact: dist/pogo-squad.html with images inlined as data URIs
  python build.py --site   # website: site/data.json + site/img/*.webp (GitHub Pages)
"""
import base64
import collections
import concurrent.futures
import hashlib
import html
import io
import json
import math
import re
import sys
import os
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).parent
SD = "https://raw.githubusercontent.com/bigfoott/ScrapedDuck/data/{}.min.json"
PA = "https://pogoapi.net/api/v1/{}.json"
CPM = {20: 0.5974, 25: 0.667934}
SITE = "--site" in sys.argv
IMG_DIR = ROOT / "site" / "img"


def emit(img, url, quality):
    """Return a reference to a webp image: a file path for the site, a data URI for the artifact."""
    buf = io.BytesIO()
    img.save(buf, "WEBP", quality=quality)
    if SITE:
        name = hashlib.sha1(url.encode()).hexdigest()[:16] + ".webp"
        IMG_DIR.mkdir(parents=True, exist_ok=True)
        (IMG_DIR / name).write_bytes(buf.getvalue())
        return "img/" + name
    return "data:image/webp;base64," + base64.b64encode(buf.getvalue()).decode()


def urlopen(req, timeout=30, tries=3):
    """urllib urlopen with retries for flaky connections."""
    for i in range(tries):
        try:
            return urllib.request.urlopen(req, timeout=timeout)
        except urllib.error.HTTPError:
            raise
        except Exception:
            if i == tries - 1:
                raise
            time.sleep(2 * (i + 1))


def get_json(url):
    req = urllib.request.Request(url, headers={"User-Agent": "pogo-squad-build"})
    with urlopen(req, timeout=45) as r:
        return json.loads(r.read().decode("utf-8"))


_icon_cache = {}


def icon(url):
    """Download a Pokémon icon and return a small webp data URI (or None)."""
    if not url:
        return None
    if url in _icon_cache:
        return _icon_cache[url]
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "pogo-squad-build"})
        with urlopen(req, timeout=45) as r:
            img = Image.open(io.BytesIO(r.read())).convert("RGBA")
        bbox = img.getbbox()
        if bbox:
            img = img.crop(bbox)
        img.thumbnail((104, 104))
        uri = emit(img, url, 82)
    except Exception as e:  # icon is optional
        print("  icon failed:", url, e)
        uri = None
    _icon_cache[url] = uri
    return uri


def banner(url):
    """Download an event banner and return a 640px-wide webp data URI (or None)."""
    if not url:
        return None
    key = "banner:" + url
    if key in _icon_cache:
        return _icon_cache[key]
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "pogo-squad-build"})
        with urlopen(req, timeout=45) as r:
            img = Image.open(io.BytesIO(r.read())).convert("RGB")
        img.thumbnail((720, 720))
        uri = emit(img, "banner:" + url, 66)
    except Exception as e:
        print("  banner failed:", url, e)
        uri = None
    _icon_cache[key] = uri
    return uri


def page_extras(url):
    """Scrape key facts from a LeekDuck event page: bonuses, shiny debuts, CD evolve move."""
    out = {"bonuses": [], "newShiny": [], "evolve": None}
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 pogo-squad-build"})
        with urlopen(req, timeout=45) as r:
            t = r.read().decode("utf-8", "replace")
    except Exception as e:
        print("  page failed:", url, e)
        return out
    clean = lambda s: html.unescape(re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", s))).strip()
    out["bonuses"] = [clean(m) for m in re.findall(r'class="bonus-text">(.*?)</div>', t, re.S)]
    i = t.find('id="shiny-debut"')
    if i >= 0:
        j = t.find("<h2", i + 10)
        out["newShiny"] = [clean(n) for n in re.findall(r'class="pkmn-name">([^<]+)', t[i:j if j > 0 else None])]
    body = clean(re.sub(r"<(script|style)[^>]*>.*?</\1>", "", t, flags=re.S))
    m = re.search(r"(Evolve [^.]{0,160}? knows the [^.]{0,120}?)\.", body)
    if m:
        out["evolve"] = m.group(1)
    # Remote Raid rules (e.g. passes disabled, higher daily limit)
    remote = []
    m = re.search(r"Remote Raid limit (?:will )?(?:be )?(?:increase[sd]?|raised) from (\d+) to (\d+)", body, re.I)
    if m:
        remote.append(f"Remote raid limit {m.group(2)}/day (normally {m.group(1)})")
    if re.search(r"Remote Raid Passes? (?:cannot|can't|can not|will not|won't) be used|(?:cannot|can't|unable to) (?:use|join)[^.]{0,60}Remote Raid", body, re.I):
        remote.append("No Remote Raid Passes")
    out["remote"] = remote
    # Region-locked events: LeekDuck labels them "Location-specific Event"
    if "Location-specific" in body:
        m = re.search(r"available only (?:in|to Trainers in) ([^.]{2,80}?)\.", body)
        out["region"] = m.group(1).strip() if m else "Location-specific"
    return out


def region_label(region, name):
    """'Location-specific' -> place taken from the event title (e.g. 'Wild Area 2026: Mexico City')."""
    if region != "Location-specific":
        return region
    place = re.split(r":| - ", name)[-1]
    place = re.sub(r"\b20\d\d\b", "", place).strip(" •-")
    return place or region


HUB = "https://db.pokemongohub.net"


def hub_slug(name, pid):
    """Pokémon GO Hub DB slug: 'Mega Charizard X' -> '6-Mega_X', 'Giratina (Origin)' -> '487-Origin'."""
    n = re.sub(r"^Shadow\s+", "", name)
    m = re.match(r"(Mega|Primal)\s+.+?(?:\s+([XY]))?$", n)
    if m:
        return f"{pid}-{m.group(1)}" + (f"_{m.group(2)}" if m.group(2) else "")
    m = re.search(r"\((\w+)", n)
    if m:
        return f"{pid}-{m.group(1)}"
    for prefix, f in (("Alolan ", "Alola"), ("Galarian ", "Galarian"), ("Hisuian ", "Hisuian"), ("Paldean ", "Paldea")):
        if n.startswith(prefix):
            return f"{pid}-{f}"
    return str(pid)


_counter_cache = {}


def hub_counters(name, pid, keep=6, slug=None, page="counters"):
    """Top counters, in Pokémon GO Hub's own ranking order (page="counters-max-battles" for Max Battles)."""
    if not pid:
        return []
    slug = slug or hub_slug(name, pid)
    key = slug + "/" + page
    if key in _counter_cache:
        return _counter_cache[key]
    out = []
    try:
        req = urllib.request.Request(f"{HUB}/pokemon/{slug}/{page}", headers={"User-Agent": "Mozilla/5.0 pogo-squad-build"})
        with urlopen(req, timeout=45) as r:
            t = r.read().decode("utf-8", "replace")
        # Rows look like <tr><td class=..>1.</td><td ..><a title="Name stats, best moves ..">..</a></td><td>fast move</td>..
        for _, row in re.findall(r"<tr[^>]*>\s*<td[^>]*>\s*(\d+)\.\s*</td>(.*?)</tr>", t, re.S):
            nm = re.search(r'<a title="(.*?) stats, best moves', row) or re.search(r'<img alt="(.*?) Pok', row)
            moves = re.findall(r'title="Opens (.*?) page with details', row)
            if not nm or len(moves) < 2:
                continue
            new = re.search(r'url=(%2Fimages%2Fpokemon%2F[^%&"]+\.webp)', row)      # current markup
            old = re.search(r'src="(/images/official/thumb/[^"]+)"', row)              # previous markup
            icon_path = urllib.parse.unquote(new.group(1)) if new else (old.group(1) if old else None)
            cname = html.unescape(nm.group(1))
            out.append({"name": cname.replace(" Forme)", ")"), "fast": html.unescape(moves[0]).rstrip("+* "),
                        "charged": html.unescape(moves[1]).rstrip("+* "),
                        "icon": icon(HUB + icon_path) if icon_path else None})
            if len(out) >= keep:
                break
    except Exception as e:
        print("  counters failed:", slug, e)
    _counter_cache[key] = out
    return out


def form_label(name, form):
    prefix = {"Alola": "Alolan ", "Galarian": "Galarian ", "Hisuian": "Hisuian ", "Paldea": "Paldean "}.get(form)
    if form == "Normal":
        return name
    return prefix + name if prefix else f"{name} ({form.replace('_', ' ')})"


DEX_IMG = ROOT / "site" / "dex"
LEEK_ICONS = "https://cdn.leekduck.com/assets/img/pokemon_icons/"


def dex_file(key):
    return key.replace(":", "-") + ".webp"


# pictures for specific forms that the Regional tool shows (file stem in site/dex -> LeekDuck icon name);
# these forms share stats with the base Pokémon, so they are not in the Rank table
EXTRA_ICONS = {
    "741-Pompom": "pm741.fPOMPOM", "741-Pau": "pm741.fPAU", "741-Sensu": "pm741.fSENSU",
    "676-Diamond": "pm676.fDIAMOND", "676-Debutante": "pm676.fDEBUTANTE", "676-Star": "pm676.fSTAR", "676-La_reine": "pm676.fLA_REINE",
    "978-Droopy": "pm978.fDROOPY", "978-Stretchy": "pm978.fSTRETCHY",
    "669-Red": "pm669.fRED", "669-Yellow": "pm669.fYELLOW",
    "422-West_sea": "pm422.fWEST_SEA",
    "550-Red_striped": "pm550.fRED_STRIPED",
    "128-Paldea_combat": "pm128.fPALDEA_COMBAT", "128-Paldea_blaze": "pm128.fPALDEA_BLAZE",
    "931-Green": "pm931.fGREEN", "931-Blue": "pm931.fBLUE",
    "843-Normal": "pm843",
}


def save_icon(names, target):
    """Download the first icon that exists, crop the empty border, shrink it and save it as webp."""
    for n in names:
        try:
            req = urllib.request.Request(LEEK_ICONS + n + ".icon.png", headers={"User-Agent": "Mozilla/5.0 pogo-squad-build"})
            with urlopen(req, timeout=30) as r:
                img = Image.open(io.BytesIO(r.read())).convert("RGBA")
        except Exception:
            continue
        bbox = img.getbbox()
        if bbox:
            img = img.crop(bbox)
        img.thumbnail((96, 96))
        img.save(target, "WEBP", quality=80)
        return "new"
    return "missing"


def fetch_dex_images(dex):
    """One small icon per Pokémon for the Rank tab, plus EXTRA_ICONS. Downloaded once; existing files are kept."""
    DEX_IMG.mkdir(parents=True, exist_ok=True)

    def get(item):
        stem, names = item
        target = DEX_IMG / (stem + ".webp")
        return "have" if target.exists() else save_icon(names, target)

    jobs = []
    for key in dex:
        pid, form = key.split(":")
        jobs.append((dex_file(key)[:-5], ([f"pm{pid}.f{form.upper()}"] if form != "Normal" else []) + [f"pm{pid}", f"pm{pid}.fNORMAL"]))
    jobs += [(stem, [name]) for stem, name in EXTRA_ICONS.items()]
    with concurrent.futures.ThreadPoolExecutor(8) as ex:
        c = collections.Counter(ex.map(get, jobs))
    print(f"dex icons: {c['have']} kept, {c['new']} downloaded, {c['missing']} without a picture")


def write_pokedex(stats):
    """site/pokedex.json for the Rank tab: base stats, evolutions and CP multipliers (levels 1-51)."""
    try:
        released = {int(k) for k in get_json(PA.format("released_pokemon"))}
        evolutions = get_json(PA.format("pokemon_evolutions"))
        raw = {float(x["level"]): x["multiplier"] for x in get_json(PA.format("cp_multiplier"))}
    except Exception as e:
        print("  pokedex skipped (keeping the previous file):", e)
        return
    cpm = []
    for i in range(101):                      # levels 1, 1.5 ... 51; above level 45 each half level adds 0.0025
        lv = 1 + i / 2
        cpm.append(round(raw[lv], 8) if lv in raw else round(cpm[-1] + 0.0025, 8))
    by_id = {}
    for r in stats:
        if r["pokemon_id"] in released:
            by_id.setdefault(r["pokemon_id"], []).append(r)
    dex = {}
    for pid in sorted(by_id):                 # Normal form first; other forms only if their stats differ (skips costumes)
        seen = set()
        for r in sorted(by_id[pid], key=lambda r: (r["form"] != "Normal", r["form"])):
            tri = (r["base_attack"], r["base_defense"], r["base_stamina"])
            if tri not in seen:
                seen.add(tri)
                dex[f'{pid}:{r["form"]}'] = [form_label(r["pokemon_name"], r["form"]), *tri, []]

    def child_key(pid, form):
        for f in (form, "Normal"):
            if f"{pid}:{f}" in dex:
                return f"{pid}:{f}"
        return next((k for k in dex if k.startswith(f"{pid}:")), None)

    for e in evolutions:
        parent = f'{e["pokemon_id"]}:{e["form"]}'
        if parent not in dex:
            continue
        for c in e["evolutions"]:
            child = child_key(c["pokemon_id"], c.get("form", "Normal"))
            if child and child != parent and child not in dex[parent][4]:
                dex[parent][4].append(child)
    out = ROOT / "site" / "pokedex.json"
    out.write_text(json.dumps({"v": 1, "cpm": cpm, "m": dex}, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"pokedex: {len(dex)} Pokémon, {out.stat().st_size // 1024} KB")
    fetch_dex_images(dex)


HEALTH = {"want": 0, "fresh": 0}   # how many counter lists we tried to scrape / actually got


def with_fallback(fetched, key, prev):
    """Use freshly scraped counters; if the scrape came back empty, keep the last good ones."""
    HEALTH["want"] += 1
    if fetched:
        HEALTH["fresh"] += 1
        return fetched
    if key in prev:
        print("  WARNING: no counters scraped for", key[1:], "- kept the previous ones")
        return prev[key]
    print("  WARNING: no counters scraped for", key[1:])
    return []


def load_previous_counters():
    prev = {}
    try:
        d = json.loads((ROOT / "site" / "data.json").read_text(encoding="utf-8"))
        for b in d.get("bosses", []):
            if b.get("counters"):
                prev[("boss", b["name"])] = b["counters"]
        for e in d.get("events", []):
            for m in e.get("mons", []):
                if m.get("counters"):
                    prev[("mon", e["id"], m["name"])] = m["counters"]
    except Exception:
        pass
    return prev


def leek_research_shinies():
    """Names of research encounters LeekDuck marks 'Can be Shiny' (ScrapedDuck's flag is unreliable)."""
    try:
        req = urllib.request.Request("https://leekduck.com/research/", headers={"User-Agent": "Mozilla/5.0 pogo-squad-build"})
        with urlopen(req, timeout=45) as r:
            t = r.read().decode("utf-8", "replace")
    except Exception as e:
        print("  research page failed:", e)
        return set()
    names = set()
    for li in re.findall(r'<li class="reward"[^>]*>(.*?)</li>', t, re.S):
        if "shiny-badge" in li:
            m = re.search(r'class="reward-label"><span>(.*?)</span>', li)
            if m:
                names.add(html.unescape(m.group(1)).strip())
    return names


ICS_LOCATION = "The Shoppes at Chino Hills, 13920 City Center Dr, Chino Hills, CA 91709"


def ics_text(events):
    """iCalendar feed. LeekDuck local times become floating times (same clock time in every time zone)."""
    skip = {"go-battle-league", "go-pass", "season", "research", "twitch-drops"}
    now = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    esc = lambda s: s.replace("\\", "\\\\").replace(";", "\\;").replace(",", "\\,").replace("\n", "\\n")
    def stamp(s):
        if s.endswith("Z"):
            return datetime.fromisoformat(s[:19]).strftime("%Y%m%dT%H%M%S") + "Z"
        return datetime.fromisoformat(s[:19]).strftime("%Y%m%dT%H%M%S")
    lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//POGO Squad//EN", "CALSCALE:GREGORIAN",
             "X-WR-CALNAME:POGO Squad", "REFRESH-INTERVAL;VALUE=DURATION:PT12H", "X-PUBLISHED-TTL:PT12H"]
    for e in events:
        if not e["start"] or not e["end"] or e["type"] in skip or e.get("region"):
            continue
        desc = [", ".join(m["name"] + (f" (100% {m['cp20']})" if m.get("cp20") else "") for m in e["mons"][:3])] if e["mons"] else []
        desc += [e["evolve"]] if e.get("evolve") else []
        desc += e.get("remote", []) + e["bonuses"][:3] + [SITE_URL]
        lines += ["BEGIN:VEVENT", f"UID:{e['id']}@pogo-squad", f"DTSTAMP:{now}",
                  f"DTSTART:{stamp(e['start'])}", f"DTEND:{stamp(e['end'])}",
                  f"SUMMARY:{esc(e['name'])}", f"LOCATION:{esc(ICS_LOCATION)}", f"DESCRIPTION:{esc(chr(10).join(d for d in desc if d))}",
                  "END:VEVENT"]  # no URL field: iOS shows it under Location; the link is in DESCRIPTION
    lines.append("END:VCALENDAR")
    folded = []
    for ln in lines:  # RFC 5545 line folding at 75 octets
        b = ln.encode("utf-8")
        while len(b) > 75:
            cut = 75
            while (b[cut] & 0xC0) == 0x80:
                cut -= 1
            folded.append(b[:cut].decode("utf-8"))
            b = b" " + b[cut:]
        folded.append(b.decode("utf-8"))
    return "\r\n".join(folded) + "\r\n"


SITE_URL = "https://catitomeister.github.io/pogo-squad/"
OG_DESC = "Pokémon GO events, hundo CPs and meetups for our squad."


def _font(size, bold=True):
    for f in (["C:/Windows/Fonts/segoeuib.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"] if bold else
              ["C:/Windows/Fonts/segoeui.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"]):
        try:
            return ImageFont.truetype(f, size)
        except OSError:
            pass
    return ImageFont.load_default()


def make_og(events, path):
    """1200x630 link-preview image: brand + this week's highlights (Mon–Sun, local build date)."""
    today = datetime.now().date()
    ws = today - timedelta(days=today.weekday())
    we = ws + timedelta(days=7)
    skip = {"go-battle-league", "go-pass", "season", "research", "twitch-drops"}
    picks = []
    for e in sorted(events, key=lambda x: x["start"] or ""):
        if not e["start"] or e["type"] in skip or e.get("region"):
            continue
        d = datetime.fromisoformat(e["start"][:19]).date()
        if ws <= d < we:
            picks.append((d, e["name"]))
    im = Image.new("RGB", (1200, 630), "#d93a1e")
    dr = ImageDraw.Draw(im)
    mark = ROOT / "site" / "logo-256.png"
    x = 70
    if mark.exists():
        m = Image.open(mark).convert("RGBA").resize((112, 112), Image.LANCZOS)
        ring = Image.new("RGBA", (124, 124), (0, 0, 0, 0))
        ImageDraw.Draw(ring).ellipse((0, 0, 123, 123), fill="white")
        im.paste(ring, (64, 58), ring)
        im.paste(m, (70, 64), m)
        x = 210
    dr.text((x, 60), "POGO Squad", font=_font(92), fill="white")
    dr.text((74, 175), f"This week · {ws:%b} {ws.day} – {(we - timedelta(days=1)):%b} {(we - timedelta(days=1)).day}",
            font=_font(40, False), fill="#ffe3db")
    y = 260
    for d, name in picks[:5]:
        name = name if len(name) <= 40 else name[:38] + "…"
        dr.text((74, y), f"{d:%a}", font=_font(38), fill="#ffe3db")
        dr.text((190, y), name, font=_font(38), fill="white")
        y += 64
    if not picks:
        dr.text((74, y), "Events, hundo CPs, raid weaknesses", font=_font(38), fill="white")
    im.save(path, "PNG", optimize=True)


def icon_quiet(url):
    """Like icon() but for guessed URLs: no log on 404."""
    if url in _icon_cache:
        return _icon_cache[url]
    try:
        req = urllib.request.Request(url, method="HEAD", headers={"User-Agent": "pogo-squad-build"})
        urlopen(req, timeout=15, tries=2)
    except Exception:
        _icon_cache[url] = None
        return None
    return icon(url)


def hundo(stats, level):
    a, d, s = (stats["base_attack"] + 15, stats["base_defense"] + 15, stats["base_stamina"] + 15)
    return max(10, math.floor(a * math.sqrt(d) * math.sqrt(s) * CPM[level] ** 2 / 10))


def main():
    print("Fetching ScrapedDuck…")
    events = get_json(SD.format("events"))
    raids = get_json(SD.format("raids"))
    print("Fetching pogoapi stats…")
    stats = get_json(PA.format("pokemon_stats"))
    types = get_json(PA.format("pokemon_types"))
    megas = get_json(PA.format("mega_pokemon"))

    stat_ix = {(x["pokemon_name"].lower(), x["form"].lower()): x for x in stats}
    type_ix = {(x["pokemon_name"].lower(), x["form"].lower()): [t.lower() for t in x["type"]] for x in types}
    mega_ix = {x["mega_name"].lower(): x for x in megas}

    def lookup(name):
        """'Thundurus (Incarnate)' -> (stats, types, catchName) for the caught form."""
        n = name.strip()
        mega_types = None
        if n.lower().startswith("mega ") or n.lower().startswith("primal "):
            m = mega_ix.get(n.lower())
            if m:
                mega_types = [t.lower() for t in m["type"]]
            n = re.sub(r"^(Mega|Primal)\s+", "", n)
            n = re.sub(r"\s+[XY]$", "", n)
        n = re.sub(r"^Shadow\s+", "", n)
        form = "normal"
        mm = re.match(r"(.+?)\s*\((.+)\)$", n)
        if mm:
            n, form = mm.group(1), mm.group(2).replace(" Forme", "").replace(" ", "_")
        for prefix, f in (("Alolan ", "alola"), ("Galarian ", "galarian"), ("Hisuian ", "hisuian"), ("Paldean ", "paldea")):
            if n.startswith(prefix):
                n, form = n[len(prefix):], f
        key = (n.lower(), form.lower())
        st = stat_ix.get(key) or stat_ix.get((n.lower(), "normal"))
        ty = type_ix.get(key) or type_ix.get((n.lower(), "normal"))
        return st, (mega_types or ty), n

    # Featured Pokémon for events whose data has none: find species names in the title
    dex = {}
    for x in stats:
        dex.setdefault(x["pokemon_name"], x["pokemon_id"])
    names = sorted(dex, key=len, reverse=True)
    name_re = re.compile(r"\b(" + "|".join(re.escape(n) for n in names) + r")\b")

    def mons_from_name(title):
        found = []
        for n in name_re.findall(title):
            if n in [m["name"] for m in found]:
                continue
            pid = dex[n]
            ic = None
            for url in (f"https://cdn.leekduck.com/assets/img/pokemon_icons/pokemon_icon_{pid:03d}_00.png",
                        f"https://cdn.leekduck.com/assets/img/pokemon_icons/pm{pid}.icon.png"):
                ic = icon_quiet(url)
                if ic:
                    break
            fm = re.search(re.escape(n) + r"\s*\((\w+) Forme?\)", title)
            found.append({"name": f"{n} ({fm.group(1)})" if fm else n, "shiny": False, "icon": ic})
        return found

    # ---- Raid bosses: current (raids.json) + upcoming from raid-battle events
    bosses = []
    seen = set()
    for r in raids:
        st, _, _ = lookup(r["name"])
        bosses.append({
            "name": r["name"],
            "tier": r["tier"].replace(" Raids", ""),
            "types": [t["name"] for t in r["types"]],
            "shiny": r["canBeShiny"],
            "cp20": r["combatPower"]["normal"]["max"],
            "cp25": r["combatPower"]["boosted"]["max"],
            "weather": [w["name"] for w in r["boostedWeather"]],
            "icon": icon(r["image"]),
            "start": None, "end": None, "current": True, "pid": st["pokemon_id"] if st else None,
        })
        seen.add(r["name"].lower())

    for e in events:
        rb = (e.get("extraData") or {}).get("raidbattles")
        if not rb:
            continue
        shadow = "Shadow Raids" in e["name"]
        tier = "Mega" if "Mega Raids" in e["name"] else ("5-Star" if ("5-star" in e["name"] or shadow) else "Raid")
        for b in rb["bosses"]:
            name = ("Shadow " if shadow and not b["name"].startswith("Shadow") else "") + b["name"]
            key = name.lower()
            st, ty, _ = lookup(b["name"])
            entry = {
                "name": name, "tier": tier, "types": ty or [], "shiny": b.get("canBeShiny", False),
                "cp20": hundo(st, 20) if st else None, "cp25": hundo(st, 25) if st else None,
                "weather": None, "icon": icon(b.get("image")),
                "start": e["start"], "end": e["end"], "current": False, "pid": st["pokemon_id"] if st else None,
            }
            if key in seen:  # already in current list: just attach the window
                for x in bosses:
                    if x["name"].lower() == key and x["start"] is None:
                        x["start"], x["end"] = e["start"], e["end"]
                continue
            if st is None:
                print("  no stats for", b["name"])
            seen.add(key)
            bosses.append(entry)

    # Top counters (Pokémon GO Hub) for the bosses people plan around: 5-star, Shadow 5-star, Mega
    prev = load_previous_counters()
    for b in bosses:
        pid = b.pop("pid", None)
        if b["tier"] in ("5-Star", "Mega") and pid:
            b["counters"] = with_fallback(hub_counters(b["name"], pid), ("boss", b["name"]), prev)

    # ---- Current field research, grouped by task type
    research = []
    shinies = leek_research_shinies()
    for r in get_json(SD.format("research")):
        rewards = [{"name": w["name"], "shiny": w.get("canBeShiny", False) or w["name"] in shinies, "icon": icon(w.get("image")),
                    "cp": (w.get("combatPower") or {}).get("max")} for w in r["rewards"]]
        research.append({"task": re.sub(r"<[^>]+>", "", r["text"]).strip(), "type": r.get("type") or "event",
                         "rewards": rewards})

    # ---- Events: keep anything that hasn't ended more than a day ago
    out_events = []
    cutoff = (datetime.now() - timedelta(days=14)).strftime("%Y-%m-%d")
    for e in events:
        ed = e.get("extraData") or {}
        mons, bonuses = [], []
        if e["end"] and e["end"][:10] < cutoff:
            continue
        if "raidbattles" in ed:
            mons = [{"name": b["name"], "shiny": b.get("canBeShiny", False), "icon": icon(b.get("image"))} for b in ed["raidbattles"]["bosses"]]
        if "spotlight" in ed:
            sp = ed["spotlight"]
            mons = [{"name": m["name"], "shiny": m.get("canBeShiny", False), "icon": icon(m.get("image"))} for m in sp.get("list", [])]
            if sp.get("bonus"):
                bonuses = [sp["bonus"]]
        if "communityday" in ed:
            cd = ed["communityday"]
            mons = [{"name": m["name"], "shiny": True, "icon": icon(m.get("image"))} for m in cd.get("spawns", [])]
            bonuses = [b["text"] for b in cd.get("bonuses", [])]
            if cd.get("specialresearch"):
                pass
        if not mons:
            mons = mons_from_name(e["name"])
        for m in mons:  # hundo CP + types for the card
            st, ty, _ = lookup(m["name"])
            m["types"] = ty or []
            m["cp20"] = hundo(st, 20) if st else None
            m["cp25"] = hundo(st, 25) if st else None
            # Max Battle Day bosses: Hub's Max Battle counters (Gigantamax / Dynamax form)
            if e["eventType"] == "max-battles" and st:
                form = "Gigantamax" if "Gigantamax" in e["name"] else "Dynamax"
                m["counters"] = with_fallback(
                    hub_counters(m["name"], st["pokemon_id"], slug=f"{st['pokemon_id']}-{form}", page="counters-max-battles"),
                    ("mon", e["eventID"], m["name"]), prev)
        extras = {"bonuses": [], "newShiny": [], "evolve": None}
        if e["eventType"] not in ("go-battle-league", "go-pass", "season", "raid-battles", "twitch-drops"):
            extras = page_extras(e["link"])
        if not bonuses:
            bonuses = extras["bonuses"]
        out_events.append({
            "id": e["eventID"], "name": e["name"], "type": e["eventType"], "heading": e["heading"],
            "link": e["link"], "start": e["start"], "end": e["end"], "image": banner(e.get("image")),
            "mons": mons, "bonuses": bonuses, "newShiny": extras["newShiny"], "evolve": extras["evolve"],
            "region": region_label(extras.get("region"), e["name"]), "remote": extras.get("remote", []),
        })

    data = {
        "built": datetime.now(timezone.utc).isoformat(timespec="minutes"),
        "events": out_events,
        "bosses": bosses,
        "research": research,
    }
    ok = HEALTH["want"] == 0 or HEALTH["fresh"] * 2 >= HEALTH["want"]
    print(f"counters: {HEALTH['fresh']}/{HEALTH['want']} scraped fresh -> {'ok' if ok else 'FAILED (Pokémon GO Hub page format may have changed)'}")
    if os.environ.get("GITHUB_OUTPUT"):
        with open(os.environ["GITHUB_OUTPUT"], "a", encoding="utf-8") as f:
            f.write(f"counters_ok={'true' if ok else 'false'}\n")
    if SITE:
        write_pokedex(stats)
        out = ROOT / "site" / "data.json"
        out.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        used = {Path(x).name for x in re.findall(r'"img/([0-9a-f]+\.webp)"', out.read_text(encoding="utf-8"))}
        for f in IMG_DIR.glob("*.webp"):  # drop images no longer referenced
            if f.name not in used:
                f.unlink()
        tpl = (ROOT / "template.html").read_text(encoding="utf-8")
        page = tpl.replace("/*__DATA__*/null", json.dumps(data, ensure_ascii=False, separators=(",", ":")))
        # Full document around the template (the artifact host adds this skeleton itself)
        index = ('<!doctype html><html lang="en"><head><meta charset="utf-8">'
                 '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">'
                 '<meta name="theme-color" content="#d93a1e"><link rel="manifest" href="manifest.json">'
                 '<link rel="icon" href="icon.svg"><link rel="apple-touch-icon" href="icon-180.png">'
                 # Link preview (WhatsApp, iMessage, etc.)
                 f'<meta name="description" content="{OG_DESC}">'
                 '<meta property="og:type" content="website"><meta property="og:site_name" content="POGO Squad">'
                 '<meta property="og:title" content="POGO Squad">'
                 f'<meta property="og:description" content="{OG_DESC}">'
                 f'<meta property="og:url" content="{SITE_URL}">'
                 # small square image -> WhatsApp shows a compact preview instead of a big banner
                 f'<meta property="og:image" content="{SITE_URL}icon-192.png">'
                 '<meta property="og:image:width" content="192"><meta property="og:image:height" content="192">'
                 '<meta name="twitter:card" content="summary">'
                 '<style>body{margin:0}img{max-width:100%}[hidden]{display:none!important}</style>'
                 '<link rel="stylesheet" href="social.css"><link rel="stylesheet" href="rank.css"><link rel="stylesheet" href="regional.css"></head><body>'
                 + page + '<script type="module" src="social.js"></script><script type="module" src="rank.js"></script><script type="module" src="regional.js"></script></body></html>')
        (ROOT / "site" / "index.html").write_text(index, encoding="utf-8")
        (ROOT / "site" / "pogo.ics").write_bytes(ics_text(out_events).encode("utf-8"))
        print(f"Wrote site/index.html + {out.name} ({out.stat().st_size // 1024} KB) + {len(used)} images: {len(out_events)} events, {len(bosses)} bosses")
        return
    tpl = (ROOT / "template.html").read_text(encoding="utf-8")
    html = tpl.replace("/*__DATA__*/null", json.dumps(data, ensure_ascii=False, separators=(",", ":")))
    out = ROOT / "dist" / "pogo-squad.html"
    out.parent.mkdir(exist_ok=True)
    out.write_text(html, encoding="utf-8")
    print(f"Wrote {out} ({out.stat().st_size // 1024} KB): {len(out_events)} events, {len(bosses)} bosses")


if __name__ == "__main__":
    main()

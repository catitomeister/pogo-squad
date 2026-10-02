"""Build POGO Squad data.

Fetches event + raid data from ScrapedDuck (LeekDuck) and base stats from
pogoapi.net, scrapes key facts from LeekDuck event pages, and computes raid
boss weaknesses and hundo CPs.

Usage:
  python build.py          # artifact: dist/pogo-squad.html with images inlined as data URIs
  python build.py --site   # website: site/data.json + site/img/*.webp (GitHub Pages)
"""
import base64
import hashlib
import html
import io
import json
import math
import re
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

from PIL import Image

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
            "start": None, "end": None, "current": True,
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
                "start": e["start"], "end": e["end"], "current": False,
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
    }
    if SITE:
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
                 '<style>body{margin:0}img{max-width:100%}[hidden]{display:none!important}</style>'
                 '<link rel="stylesheet" href="social.css"></head><body>'
                 + page + '<script type="module" src="social.js"></script></body></html>')
        (ROOT / "site" / "index.html").write_text(index, encoding="utf-8")
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

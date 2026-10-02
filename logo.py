"""Draw the POGO Squad mark (black disc, white P, three red dots) as SVG + PNG icons.

Geometry is on a 512x512 canvas, traced from the chosen AI concept and cleaned up.
Usage:  python logo.py            # writes site/logo.svg, site/icon.svg, site/icon-{180,192,512}.png
        python logo.py preview    # also writes a preview sheet to dist/logo-preview.png
"""
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).parent
INK, PAPER, RED = "#1b1b1b", "#ffffff", "#d93a1e"

# P: stem + bowl (outer/inner rounded on the right), with a small slit where the bowl meets the stem
STEM = (163, 109, 205, 414)
BOWL_OUT = (163, 109, 397, 316)   # right side is a half-circle
BOWL_IN = (205, 150, 353, 273)
SLIT = (205, 273, 221, 316)
DOTS = [(303, 188), (277, 222), (319, 228)]
DOT_R = 17


def svg(size=512, bg=None):
    ox, oy, ox2, oy2 = BOWL_OUT
    ix, iy, ix2, iy2 = BOWL_IN
    ro, ri = (oy2 - oy) / 2, (iy2 - iy) / 2
    bowl = (f"M{ox} {oy}H{ox2 - ro}A{ro} {ro} 0 0 1 {ox2 - ro} {oy2}H{ox}Z"
            f"M{ix} {iy}V{iy2}H{ix2 - ri}A{ri} {ri} 0 0 0 {ix2 - ri} {iy}Z")
    dots = "".join(f'<circle cx="{x}" cy="{y}" r="{DOT_R}" fill="{RED}"/>' for x, y in DOTS)
    back = f'<rect width="512" height="512" fill="{bg}"/>' if bg else ""
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="{size}" height="{size}">'
            f'{back}<circle cx="256" cy="256" r="256" fill="{INK}"/>'
            f'<rect x="{STEM[0]}" y="{STEM[1]}" width="{STEM[2] - STEM[0]}" height="{STEM[3] - STEM[1]}" fill="{PAPER}"/>'
            f'<path d="{bowl}" fill="{PAPER}" fill-rule="evenodd"/>'
            f'<rect x="{SLIT[0]}" y="{SLIT[1]}" width="{SLIT[2] - SLIT[0]}" height="{SLIT[3] - SLIT[1]}" fill="{INK}"/>'
            f'{dots}</svg>')


def png(size, bg=None, pad=0.0):
    """Raster version (4x supersampled). bg fills the square; pad shrinks the disc inside it."""
    S = 4 * size
    im = Image.new("RGBA", (S, S), bg or (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    k = S * (1 - 2 * pad) / 512
    o = S * pad
    T = lambda x, y: (o + x * k, o + y * k)
    box = lambda b: [*T(b[0], b[1]), *T(b[2], b[3])]
    d.ellipse(box((0, 0, 512, 512)), fill=INK)
    d.rectangle(box(STEM), fill=PAPER)
    ox, oy, ox2, oy2 = BOWL_OUT
    ro = (oy2 - oy) / 2
    d.rectangle(box((ox, oy, ox2 - ro, oy2)), fill=PAPER)
    d.ellipse(box((ox2 - 2 * ro, oy, ox2, oy2)), fill=PAPER)
    ix, iy, ix2, iy2 = BOWL_IN
    ri = (iy2 - iy) / 2
    d.rectangle(box((ix, iy, ix2 - ri, iy2)), fill=INK)
    d.ellipse(box((ix2 - 2 * ri, iy, ix2, iy2)), fill=INK)
    d.rectangle(box(SLIT), fill=INK)
    for x, y in DOTS:
        d.ellipse(box((x - DOT_R, y - DOT_R, x + DOT_R, y + DOT_R)), fill=RED)
    return im.resize((size, size), Image.LANCZOS)


def main():
    site = ROOT / "site"
    (site / "logo.svg").write_text(svg(), encoding="utf-8")
    (site / "icon.svg").write_text(svg(), encoding="utf-8")
    # Home-screen icons are square tiles: disc on white with a little breathing room
    for s in (180, 192, 512):
        png(s, bg=PAPER, pad=0.06).convert("RGB").save(site / f"icon-{s}.png")
    png(256).save(site / "logo-256.png")  # transparent, used on the link-preview image
    print("wrote site/logo.svg, icon.svg, icon-180/192/512.png")
    if "preview" in sys.argv:
        preview()


def preview():
    W, H = 1400, 760
    sheet = Image.new("RGB", (W, H), "#eef2ef")
    d = ImageDraw.Draw(sheet)
    try:
        f = lambda n, b=True: ImageFont.truetype("C:/Windows/Fonts/segoeuib.ttf" if b else "C:/Windows/Fonts/segoeui.ttf", n)
        f(10)
    except OSError:
        f = lambda n, b=True: ImageFont.load_default()
    d.text((40, 30), "Full size", font=f(26), fill="#5a6963")
    sheet.paste(png(420), (40, 80), png(420))
    # home screen tile (iOS rounds the corners itself)
    d.text((520, 30), "Home screen icon", font=f(26), fill="#5a6963")
    tile = png(180, bg=PAPER, pad=0.06).convert("RGB")
    mask = Image.new("L", (180, 180), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, 179, 179), 40, fill=255)
    sheet.paste(tile, (520, 80), mask)
    d.text((540, 270), "POGO Squad", font=f(24, False), fill="#15201c")
    # browser tab favicon
    d.text((520, 340), "Browser tab", font=f(26), fill="#5a6963")
    d.rounded_rectangle((520, 385, 900, 435), 12, fill="#ffffff")
    sheet.paste(png(32), (536, 394), png(32))
    d.text((580, 396), "POGO Squad", font=f(22, False), fill="#15201c")
    # site header
    d.text((520, 480), "Website header", font=f(26), fill="#5a6963")
    d.rounded_rectangle((520, 525, 1360, 610), 14, fill="#eef2ef", outline="#d5ddd8")
    sheet.paste(png(52), (540, 541), png(52))
    d.text((608, 545), "POGO", font=f(40), fill="#15201c")
    d.text((734, 545), "Squad", font=f(40), fill=RED)
    d.text((1150, 556), "Week   Raids", font=f(24), fill="#5a6963")
    # dark mode check
    d.text((960, 30), "On dark background", font=f(26), fill="#5a6963")
    d.rounded_rectangle((960, 80, 1360, 300), 16, fill="#101614")
    sheet.paste(png(160), (1080, 110), png(160))
    out = ROOT / "dist" / "logo-preview.png"
    out.parent.mkdir(exist_ok=True)
    sheet.save(out)
    print("wrote", out)


if __name__ == "__main__":
    if "preview" in sys.argv:
        preview()
    else:
        main()

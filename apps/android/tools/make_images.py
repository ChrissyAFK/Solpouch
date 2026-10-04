"""Draws the launcher fallback icons and the splash image from the logo in apps/web/src/app/icon.svg."""
from pathlib import Path
from PIL import Image, ImageDraw

RES = Path(__file__).resolve().parent.parent / "app" / "src" / "main" / "res"
SURFACE, MINT, VIOLET = "#101014", "#14F195", "#A78BFA"
# The three bars of the mark, in the 512 box of the SVG.
BARS = [
    (MINT, [(164, 150), (382, 150), (348, 198), (130, 198)]),
    (VIOLET, [(130, 232), (348, 232), (382, 280), (164, 280)]),
    (MINT, [(164, 314), (382, 314), (348, 362), (130, 362)]),
]
SS = 4  # supersample, then downscale for clean edges


def draw(size, scale, background):
    big = size * SS
    img = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    if background:
        d.rounded_rectangle([0, 0, big - 1, big - 1], radius=big * 112 // 512, fill=SURFACE)
    k = big / 512 * scale
    off = big / 2 - 256 * k
    for colour, pts in BARS:
        d.polygon([(off + x * k, off + y * k) for x, y in pts], fill=colour)
    return img.resize((size, size), Image.LANCZOS)


def save(img, folder, name):
    out = RES / folder
    out.mkdir(parents=True, exist_ok=True)
    img.save(out / name, optimize=True)


for density, px in {"mdpi": 48, "hdpi": 72, "xhdpi": 96, "xxhdpi": 144, "xxxhdpi": 192}.items():
    save(draw(px, 1.0, True), f"mipmap-{density}", "ic_launcher.png")
for density, px in {"mdpi": 300, "hdpi": 450, "xhdpi": 600, "xxhdpi": 900, "xxxhdpi": 1200}.items():
    save(draw(px, 0.62, False), f"drawable-{density}", "splash.png")
print("images written")

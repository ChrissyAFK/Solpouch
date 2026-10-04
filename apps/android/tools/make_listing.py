"""Draws the Play listing icon (512) and feature graphic (1024x500) into docs/android/graphics."""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

OUT = Path(__file__).resolve().parents[3] / "docs" / "android" / "graphics"
SURFACE, MINT, VIOLET, INK = "#101014", "#14F195", "#A78BFA", "#F4F1EA"
BARS = [
    (MINT, [(164, 150), (382, 150), (348, 198), (130, 198)]),
    (VIOLET, [(130, 232), (348, 232), (382, 280), (164, 280)]),
    (MINT, [(164, 314), (382, 314), (348, 362), (130, 362)]),
]
SS = 4


def mark(d, cx, cy, k):
    for colour, pts in BARS:
        d.polygon([(cx + (x - 256) * k, cy + (y - 256) * k) for x, y in pts], fill=colour)


# Play masks the icon itself, so the square is full bleed.
icon = Image.new("RGB", (512 * SS, 512 * SS), SURFACE)
mark(ImageDraw.Draw(icon), 256 * SS, 256 * SS, SS * 0.9)
icon.resize((512, 512), Image.LANCZOS).save(OUT / "icon-512.png", optimize=True)

W, H = 1024 * SS, 500 * SS
feature = Image.new("RGB", (W, H), SURFACE)
d = ImageDraw.Draw(feature)
mark(d, 250 * SS, 250 * SS, SS * 0.8)
bold = ImageFont.truetype("C:/Windows/Fonts/segoeuib.ttf", 104 * SS)
regular = ImageFont.truetype("C:/Windows/Fonts/segoeui.ttf", 40 * SS)
d.text((400 * SS, 150 * SS), "Solpouch", font=bold, fill=INK)
d.text((406 * SS, 290 * SS), "Spending with limits", font=regular, fill=MINT)
feature.resize((1024, 500), Image.LANCZOS).save(OUT / "feature-1024x500.png", optimize=True)
print("listing graphics written")

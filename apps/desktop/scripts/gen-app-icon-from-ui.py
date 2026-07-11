"""
Bake the in-app logo (src/assets/zelari-logo.png) into a 1024 app-icon master
that matches the UI brand-mark look: rounded square, dark fill, cyan ring.

Does NOT modify the in-app asset. Writes src-tauri/app-icon-source.png and
runs nothing else — call `npx tauri icon` after.
"""
from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

DESKTOP = Path(__file__).resolve().parents[1]
LOGO = DESKTOP / "src" / "assets" / "zelari-logo.png"
OUT = DESKTOP / "src-tauri" / "app-icon-source.png"
SIZE = 1024

# brand-mark.lg: 56px, radius 14px → ~25% of edge
RADIUS = int(SIZE * 0.25)
# logo inset similar to full-bleed contain with a little padding
PAD = int(SIZE * 0.08)
# Match brand-mark.lg: box-shadow 0 0 0 1px rgba(34, 211, 238, 0.2)
RING = (34, 211, 238, 70)
BG = (8, 12, 18, 255)  # near-black elevated surface
GLOW = (0, 180, 220, 28)


def rounded_mask(size: int, radius: int) -> Image.Image:
    m = Image.new("L", (size, size), 0)
    d = ImageDraw.Draw(m)
    d.rounded_rectangle((0, 0, size - 1, size - 1), radius=radius, fill=255)
    return m


def main() -> None:
    logo = Image.open(LOGO).convert("RGBA")
    # Square canvas
    canvas = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))

    # Soft glow behind the mark (like brand-mark.lg box-shadow)
    glow_layer = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow_layer)
    margin = int(SIZE * 0.04)
    gd.rounded_rectangle(
        (margin, margin, SIZE - 1 - margin, SIZE - 1 - margin),
        radius=RADIUS,
        fill=GLOW,
    )
    glow_layer = glow_layer.filter(ImageFilter.GaussianBlur(radius=SIZE // 40))
    canvas = Image.alpha_composite(canvas, glow_layer)

    # Filled rounded plate
    plate = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    pd = ImageDraw.Draw(plate)
    pd.rounded_rectangle((0, 0, SIZE - 1, SIZE - 1), radius=RADIUS, fill=BG)
    # Thin cyan ring (~1px at 56 → ~18 at 1024); keep readable at small sizes
    ring_w = max(3, SIZE // 64)
    inset = ring_w
    pd.rounded_rectangle(
        (inset, inset, SIZE - 1 - inset, SIZE - 1 - inset),
        radius=max(1, RADIUS - inset // 2),
        outline=RING,
        width=ring_w,
    )
    canvas = Image.alpha_composite(canvas, plate)

    # Logo: fit inside pad, preserve aspect
    inner = SIZE - 2 * PAD
    logo_r = logo.copy()
    logo_r.thumbnail((inner, inner), Image.Resampling.LANCZOS)
    ox = (SIZE - logo_r.width) // 2
    oy = (SIZE - logo_r.height) // 2
    canvas.paste(logo_r, (ox, oy), logo_r)

    # Clip to rounded square so Windows doesn't show square black corners oddly
    mask = rounded_mask(SIZE, RADIUS)
    out = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    out.paste(canvas, (0, 0))
    out.putalpha(mask)

    OUT.parent.mkdir(parents=True, exist_ok=True)
    out.save(OUT, "PNG")
    print(f"wrote {OUT} {out.size} mode={out.mode}")


if __name__ == "__main__":
    main()

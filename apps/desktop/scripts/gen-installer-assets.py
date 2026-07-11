"""Generate app icon master PNG + NSIS BMP assets from installer/source/."""
from __future__ import annotations

from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[1] / "src-tauri"
SRC = ROOT / "installer" / "source"
OUT = ROOT / "installer"


def fit_letterbox(img: Image.Image, tw: int, th: int, fill=(0, 0, 0)) -> Image.Image:
    img = img.convert("RGB")
    ratio = img.width / img.height
    target = tw / th
    canvas = Image.new("RGB", (tw, th), fill)
    if ratio > target:
        new_w = tw
        new_h = max(1, int(tw / ratio))
    else:
        new_h = th
        new_w = max(1, int(th * ratio))
    resized = img.resize((new_w, new_h), Image.Resampling.LANCZOS)
    canvas.paste(resized, ((tw - new_w) // 2, (th - new_h) // 2))
    return canvas


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)

    logo = Image.open(SRC / "logonsis.jpg").convert("RGBA")
    logo = logo.resize((1024, 1024), Image.Resampling.LANCZOS)

    master = ROOT / "app-icon-source.png"
    logo.save(master, "PNG")
    logo.save(OUT / "app-icon-master.png", "PNG")
    print(f"wrote {master} {logo.size}")

    sidebar = fit_letterbox(Image.open(SRC / "lateralnsis.jpg"), 164, 314)
    side_path = OUT / "nsis-sidebar.bmp"
    sidebar.save(side_path, "BMP")
    print(f"wrote {side_path} {sidebar.size}")

    # Header 150x57: monogram centered on black
    header_w, header_h = 150, 57
    header = Image.new("RGB", (header_w, header_h), (0, 0, 0))
    pad = 4
    icon_h = header_h - pad * 2
    icon = logo.convert("RGB").resize((icon_h, icon_h), Image.Resampling.LANCZOS)
    header.paste(icon, ((header_w - icon_h) // 2, pad))
    header_path = OUT / "nsis-header.bmp"
    header.save(header_path, "BMP")
    print(f"wrote {header_path} {header.size}")

    print("done")


if __name__ == "__main__":
    main()

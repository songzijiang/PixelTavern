"""Generate PixelTavern UI icons and sitting animation templates.

The output is deterministic and intentionally pixel-styled so UI assets can be
recreated without relying on external services.
"""
from __future__ import annotations

from pathlib import Path

try:
    from PIL import Image, ImageDraw
except ImportError as exc:  # pragma: no cover - local tool guard
    raise SystemExit("需要 Pillow: pip install Pillow") from exc


ROOT = Path(__file__).resolve().parent.parent
WEB_UI = ROOT / "apps" / "web" / "public" / "assets" / "ui"
ICON_DIR = WEB_UI / "icons"
TEMPLATE_DIR = ROOT / "assets" / "template"

S = 4

PALETTE = {
    "gold": (201, 169, 110, 255),
    "gold_hi": (236, 213, 153, 255),
    "purple": (104, 85, 160, 255),
    "purple_hi": (139, 124, 197, 255),
    "ink": (18, 17, 31, 255),
    "panel": (38, 34, 56, 255),
    "green": (90, 170, 130, 255),
    "red": (196, 104, 104, 255),
    "steel": (162, 164, 176, 255),
    "paper": (224, 216, 200, 255),
}


def px(draw: ImageDraw.ImageDraw, x: int, y: int, color: tuple[int, int, int, int], scale: int = S) -> None:
    draw.rectangle((x * scale, y * scale, (x + 1) * scale - 1, (y + 1) * scale - 1), fill=color)


def rect(draw: ImageDraw.ImageDraw, xy: tuple[int, int, int, int], color: tuple[int, int, int, int], scale: int = S) -> None:
    x0, y0, x1, y1 = xy
    draw.rectangle((x0 * scale, y0 * scale, (x1 + 1) * scale - 1, (y1 + 1) * scale - 1), fill=color)


def line(draw: ImageDraw.ImageDraw, points: list[tuple[int, int]], color: tuple[int, int, int, int], scale: int = S) -> None:
    draw.line([(x * scale + scale // 2, y * scale + scale // 2) for x, y in points], fill=color, width=scale)


def icon_base(size: int = 24) -> tuple[Image.Image, ImageDraw.ImageDraw]:
    img = Image.new("RGBA", (size * S, size * S), (0, 0, 0, 0))
    return img, ImageDraw.Draw(img)


def save_icon(name: str, painter) -> None:
    img, draw = icon_base()
    painter(draw)
    ICON_DIR.mkdir(parents=True, exist_ok=True)
    img.save(ICON_DIR / f"{name}.png", optimize=True)


def draw_mug(draw: ImageDraw.ImageDraw, x: int, y: int, color=PALETTE["gold"]) -> None:
    rect(draw, (x, y + 4, x + 9, y + 14), color)
    rect(draw, (x + 1, y + 3, x + 8, y + 3), PALETTE["gold_hi"])
    rect(draw, (x + 10, y + 7, x + 12, y + 11), color)
    rect(draw, (x + 11, y + 8, x + 11, y + 10), (0, 0, 0, 0))
    rect(draw, (x + 2, y + 14, x + 8, y + 15), PALETTE["ink"])


def draw_gear(draw: ImageDraw.ImageDraw, cx: int = 12, cy: int = 12) -> None:
    for x, y in [(cx, cy - 8), (cx, cy + 8), (cx - 8, cy), (cx + 8, cy), (cx - 6, cy - 6), (cx + 6, cy - 6), (cx - 6, cy + 6), (cx + 6, cy + 6)]:
        rect(draw, (x - 1, y - 1, x + 1, y + 1), PALETTE["gold"])
    rect(draw, (cx - 5, cy - 5, cx + 5, cy + 5), PALETTE["steel"])
    rect(draw, (cx - 2, cy - 2, cx + 2, cy + 2), PALETTE["ink"])


def generate_icons() -> None:
    def logo_icon(draw: ImageDraw.ImageDraw) -> None:
        rect(draw, (4, 5, 19, 18), PALETTE["panel"])
        rect(draw, (5, 4, 18, 5), PALETTE["gold"])
        rect(draw, (3, 7, 20, 8), PALETTE["gold"])
        draw_mug(draw, 7, 6)
        px(draw, 17, 5, PALETTE["purple_hi"])
        rect(draw, (16, 6, 18, 7), PALETTE["purple"])
        rect(draw, (6, 18, 17, 19), PALETTE["ink"])

    save_icon("logo", logo_icon)
    save_icon("world", lambda d: (rect(d, (5, 5, 18, 17), PALETTE["panel"]), rect(d, (7, 7, 16, 9), PALETTE["gold"]), rect(d, (8, 10, 9, 15), PALETTE["purple_hi"]), rect(d, (14, 10, 15, 15), PALETTE["green"]), rect(d, (6, 18, 17, 19), PALETTE["ink"])))
    save_icon("memory", lambda d: (rect(d, (6, 4, 18, 18), PALETTE["paper"]), rect(d, (8, 6, 16, 7), PALETTE["gold"]), line(d, [(8, 10), (15, 10)], PALETTE["purple"]), line(d, [(8, 13), (16, 13)], PALETTE["purple"]), line(d, [(8, 16), (14, 16)], PALETTE["purple"])))
    save_icon("status", lambda d: (rect(d, (10, 4, 13, 7), PALETTE["gold_hi"]), rect(d, (8, 8, 15, 14), PALETTE["purple_hi"]), rect(d, (7, 15, 16, 18), PALETTE["gold"]), rect(d, (5, 19, 18, 20), PALETTE["ink"])))
    save_icon("settings", draw_gear)
    save_icon("prompt", lambda d: (rect(d, (4, 5, 19, 17), PALETTE["panel"]), rect(d, (6, 7, 17, 8), PALETTE["paper"]), rect(d, (6, 11, 14, 12), PALETTE["gold"]), rect(d, (8, 17, 11, 20), PALETTE["panel"]), px(d, 12, 18, PALETTE["panel"])))
    save_icon("characters", lambda d: (rect(d, (5, 8, 10, 14), PALETTE["purple_hi"]), rect(d, (14, 7, 18, 13), PALETTE["gold"]), rect(d, (4, 15, 11, 18), PALETTE["purple"]), rect(d, (13, 14, 19, 17), PALETTE["gold_hi"])))
    save_icon("assets", lambda d: (rect(d, (5, 5, 11, 11), PALETTE["gold"]), rect(d, (13, 5, 18, 11), PALETTE["purple_hi"]), rect(d, (5, 13, 11, 18), PALETTE["green"]), rect(d, (13, 13, 18, 18), PALETTE["steel"])))
    save_icon("collision", lambda d: (rect(d, (5, 6, 18, 17), PALETTE["panel"]), line(d, [(5, 6), (18, 17)], PALETTE["red"]), line(d, [(18, 6), (5, 17)], PALETTE["red"])))
    save_icon("play", lambda d: [line(d, [(8, y), (16, 12)], PALETTE["gold"]) for y in range(7, 18, 2)])
    save_icon("pause", lambda d: (rect(d, (7, 6, 10, 18), PALETTE["gold"]), rect(d, (14, 6, 17, 18), PALETTE["gold"])))
    save_icon("stop", lambda d: rect(d, (7, 7, 17, 17), PALETTE["red"]))
    save_icon("latest", lambda d: (line(d, [(6, 12), (16, 12)], PALETTE["green"]), line(d, [(12, 8), (16, 12), (12, 16)], PALETTE["green"]), rect(d, (18, 7, 19, 17), PALETTE["green"])))
    save_icon("send", lambda d: (line(d, [(5, 6), (19, 12), (5, 18), (8, 13), (13, 12), (8, 11), (5, 6)], PALETTE["purple_hi"])))
    save_icon("export", lambda d: (rect(d, (6, 15, 18, 18), PALETTE["panel"]), line(d, [(12, 5), (12, 13)], PALETTE["green"]), line(d, [(8, 10), (12, 14), (16, 10)], PALETTE["green"])))
    save_icon("import", lambda d: (rect(d, (6, 15, 18, 18), PALETTE["panel"]), line(d, [(12, 14), (12, 6)], PALETTE["gold"]), line(d, [(8, 10), (12, 6), (16, 10)], PALETTE["gold"])))
    save_icon("share", lambda d: (rect(d, (5, 12, 8, 15), PALETTE["gold"]), rect(d, (16, 6, 19, 9), PALETTE["purple_hi"]), rect(d, (16, 17, 19, 20), PALETTE["green"]), line(d, [(8, 13), (16, 8)], PALETTE["steel"]), line(d, [(8, 14), (16, 18)], PALETTE["steel"])))
    save_icon("trash", lambda d: (rect(d, (7, 8, 17, 18), PALETTE["red"]), rect(d, (6, 6, 18, 7), PALETTE["red"]), rect(d, (10, 4, 15, 5), PALETTE["red"]), line(d, [(10, 10), (10, 16)], PALETTE["ink"]), line(d, [(14, 10), (14, 16)], PALETTE["ink"])))
    save_icon("save", lambda d: (rect(d, (5, 5, 18, 18), PALETTE["purple"]), rect(d, (8, 6, 15, 9), PALETTE["paper"]), rect(d, (8, 13, 16, 18), PALETTE["ink"]), px(d, 15, 7, PALETTE["purple"])))
    save_icon("test", lambda d: (rect(d, (8, 4, 15, 6), PALETTE["steel"]), rect(d, (7, 7, 16, 18), PALETTE["panel"]), rect(d, (8, 14, 15, 17), PALETTE["green"]), px(d, 11, 10, PALETTE["gold_hi"]), px(d, 13, 11, PALETTE["purple_hi"])))
    save_icon("reset", lambda d: (line(d, [(17, 7), (12, 5), (7, 8), (6, 13), (9, 17), (14, 18), (18, 15)], PALETTE["red"]), line(d, [(17, 7), (17, 12), (12, 9)], PALETTE["red"])))
    save_icon("add", lambda d: (rect(d, (11, 5, 13, 19), PALETTE["green"]), rect(d, (5, 11, 19, 13), PALETTE["green"])))


def make_logo_files() -> None:
    WEB_UI.mkdir(parents=True, exist_ok=True)
    img = Image.new("RGBA", (128, 128), PALETTE["ink"])
    draw = ImageDraw.Draw(img)
    draw.rectangle((20, 34, 108, 100), fill=PALETTE["panel"])
    draw.rectangle((28, 24, 100, 38), fill=PALETTE["gold"])
    draw.rectangle((18, 40, 110, 48), fill=(96, 63, 44, 255))
    draw.rectangle((44, 54, 78, 94), fill=PALETTE["gold"])
    draw.rectangle((50, 48, 72, 56), fill=PALETTE["gold_hi"])
    draw.rectangle((80, 64, 96, 84), fill=PALETTE["gold"])
    draw.rectangle((84, 68, 90, 80), fill=PALETTE["panel"])
    draw.rectangle((36, 98, 92, 106), fill=(8, 7, 14, 255))
    draw.rectangle((90, 26, 104, 34), fill=PALETTE["purple_hi"])
    draw.rectangle((94, 20, 98, 40), fill=PALETTE["purple"])
    img.save(WEB_UI / "pixel-tavern-logo.png", optimize=True)
    img.resize((32, 32), Image.Resampling.NEAREST).save(WEB_UI / "favicon.png", optimize=True)


def draw_sitting_template_frame(offset: int) -> Image.Image:
    img = Image.new("RGBA", (96, 96), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    scale = 3

    def r(x0: int, y0: int, x1: int, y1: int, c: tuple[int, int, int, int]) -> None:
        d.rectangle((x0 * scale, y0 * scale, (x1 + 1) * scale - 1, (y1 + 1) * scale - 1), fill=c)

    y = offset
    r(9, 25, 23, 28, (91, 58, 38, 255))
    r(11, 17 + y, 20, 24 + y, (88, 67, 132, 255))
    r(13, 9 + y, 18, 15 + y, (214, 170, 121, 255))
    r(12, 7 + y, 19, 9 + y, (55, 43, 78, 255))
    r(8, 19 + y, 11, 22 + y, (214, 170, 121, 255))
    r(20, 19 + y, 23, 22 + y, (214, 170, 121, 255))
    r(10, 25, 15, 27, (41, 38, 58, 255))
    r(17, 25, 22, 27, (41, 38, 58, 255))
    r(7, 28, 24, 30, (67, 42, 30, 255))
    r(9, 31, 11, 31, (67, 42, 30, 255))
    r(21, 31, 23, 31, (67, 42, 30, 255))
    return img


def generate_sitting_templates() -> None:
    TEMPLATE_DIR.mkdir(parents=True, exist_ok=True)
    offsets = [1, 0, -1, 0, 1]
    frames = [draw_sitting_template_frame(o) for o in offsets]
    frames[1].save(TEMPLATE_DIR / "sit_template.png", optimize=True)
    for idx, frame in enumerate(frames):
        frame.save(TEMPLATE_DIR / f"sit_template_{idx}.png", optimize=True)

    sheet = Image.new("RGBA", (96 * 5, 96), (0, 0, 0, 0))
    for idx, frame in enumerate(frames):
        sheet.alpha_composite(frame, dest=(idx * 96, 0))
    sheet.save(TEMPLATE_DIR / "sit_template_5frames.png", optimize=True)


def main() -> None:
    generate_icons()
    make_logo_files()
    generate_sitting_templates()
    print(f"UI assets: {WEB_UI}")
    print(f"Sitting templates: {TEMPLATE_DIR}")


if __name__ == "__main__":
    main()

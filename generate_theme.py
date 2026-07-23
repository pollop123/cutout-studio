#!/usr/bin/env python3
"""Generate a LINE Creators Market theme from the photos in this folder.

The output intentionally includes both the legacy 128x150 menu assets and the
iOS 26 80x56 menu assets listed in LINE's detailed creation guide.
"""

from __future__ import annotations

import shutil
import sys
import zipfile
from pathlib import Path

from PIL import Image, ImageDraw, ImageEnhance, ImageFilter, ImageOps


ROOT = Path(__file__).resolve().parent
OUTPUT = ROOT / "line_theme"
ZIP_PATH = ROOT / "line_theme_scripted.zip"
PALE = (235, 232, 246, 255)
NAVY = (30, 39, 67, 255)
LAVENDER = (150, 119, 203, 255)


def source(name: str) -> Image.Image:
    path = ROOT / name
    if not path.exists():
        raise FileNotFoundError(path)
    return ImageOps.exif_transpose(Image.open(path)).convert("RGBA")


def cover_crop(image: Image.Image, size: tuple[int, int], focus=(0.5, 0.5)) -> Image.Image:
    """Aspect-fill without distortion, then crop around a normalized focal point."""
    width, height = size
    scale = max(width / image.width, height / image.height)
    resized = image.resize(
        (round(image.width * scale), round(image.height * scale)),
        Image.Resampling.LANCZOS,
    )
    left = round(focus[0] * resized.width - width / 2)
    top = round(focus[1] * resized.height - height / 2)
    left = max(0, min(left, resized.width - width))
    top = max(0, min(top, resized.height - height))
    return resized.crop((left, top, left + width, top + height))


def save(image: Image.Image, name: str, *, optimize=True) -> None:
    path = OUTPUT / name
    image.save(path, "PNG", optimize=optimize)
    if path.stat().st_size > 1_000_000 and name in {"i_22.png", "a_22.png"}:
        # Palette conversion is visually harmless after the strong chat wash.
        image.convert("RGB").quantize(colors=192).save(path, "PNG", optimize=True)


def make_cover(name: str, size: tuple[int, int]) -> None:
    image = cover_crop(source("100039_0.jpg"), size, focus=(0.5, 0.43)).convert("RGB")
    save(image, name)


def menu_face_icon(
    face_name: str,
    canvas_size: tuple[int, int],
    *,
    selected: bool,
) -> Image.Image:
    width, height = canvas_size
    # Resize the whole transparent square so hair/chin stay visible. The face
    # itself occupies roughly 70% of these boxes, leaving badge-safe margins.
    box = 54 if width <= 80 else 112
    face = source(face_name).resize((box, box), Image.Resampling.LANCZOS)
    if not selected:
        alpha = face.getchannel("A").point(lambda value: round(value * 0.58))
        gray = ImageEnhance.Brightness(ImageOps.grayscale(face.convert("RGB"))).enhance(0.88)
        face = gray.convert("RGBA")
        face.putalpha(alpha)
    canvas = Image.new("RGBA", canvas_size, (0, 0, 0, 0))
    x = (width - box) // 2
    y = (height - box) // 2
    canvas.alpha_composite(face, (x, y))
    return canvas


MENU = [
    ("i_29", "i_30", "generated_assets/passcode_face4.png"),  # Home
    ("i_03", "i_04", "generated_assets/passcode_face1.png"),  # Chats
    ("i_33", "i_34", "generated_assets/passcode_face2.png"),  # VOOM
    ("i_35", "i_36", "generated_assets/passcode_face5.png"),  # Shopping
    ("i_07", "i_08", "generated_assets/passcode_face7.png"),  # Calls
    ("i_25", "i_26", "generated_assets/passcode_face8.png"),  # News
    ("i_31", "i_32", "generated_assets/passcode_face6.png"),  # TODAY
    ("i_27", "i_28", "generated_assets/passcode_face9.png"),  # Wallet
    ("i_37", "i_38", "generated_assets/passcode_face3.png"),  # Apps/MINI
]


def make_menu_icons() -> None:
    for off, on, face in MENU:
        save(menu_face_icon(face, (128, 150), selected=False), f"{off}.png")
        save(menu_face_icon(face, (128, 150), selected=True), f"{on}.png")
        save(menu_face_icon(face, (80, 56), selected=False), f"{off}_g.png")
        save(menu_face_icon(face, (80, 56), selected=True), f"{on}_g.png")


def make_menu_background() -> None:
    # Keep the menu background deliberately plain so the face icons remain
    # readable. RGB guarantees the required bottom 100 rows are fully opaque.
    image = Image.new("RGB", (1472, 150), PALE[:3])
    save(image, "i_11.png")


PASSCODE = [
    ("generated_assets/passcode_face1.png", (0.5, 0.5)),
    ("generated_assets/passcode_face2.png", (0.5, 0.5)),
    ("generated_assets/passcode_face3.png", (0.5, 0.5)),
    ("generated_assets/passcode_face4.png", (0.5, 0.5)),
]


def passcode_icon(photo_name: str, size: int, selected: bool, focus) -> Image.Image:
    image = cover_crop(source(photo_name), (size, size), focus=focus).convert("RGBA")
    if not selected:
        alpha = image.getchannel("A").point(lambda value: round(value * 0.58))
        gray = ImageEnhance.Brightness(ImageOps.grayscale(image.convert("RGB"))).enhance(0.88)
        image = gray.convert("RGBA")
        image.putalpha(alpha)
    return image


def make_passcode() -> None:
    for index, (photo, focus) in enumerate(PASSCODE):
        ios_off = 12 + index * 2
        android_off = 12 + index * 2
        save(passcode_icon(photo, 120, False, focus), f"i_{ios_off:02d}.png")
        save(passcode_icon(photo, 120, True, focus), f"i_{ios_off + 1:02d}.png")
        save(passcode_icon(photo, 116, False, focus), f"a_{android_off:02d}.png")
        save(passcode_icon(photo, 116, True, focus), f"a_{android_off + 1:02d}.png")


def make_profiles() -> None:
    single = source("generated_assets/profile_single.png")
    group = source("generated_assets/profile_group.png")
    # Group portraits need extra breathing room because LINE masks this square
    # into a circle. Add a 5% border per side without changing output pixels.
    group_border = round(group.width * 0.05)
    group = ImageOps.expand(group, border=group_border, fill=group.getpixel((0, 0)))
    for name, image, size in [
        ("i_20.png", single, 240),
        ("a_20.png", single, 247),
        ("i_21.png", group, 240),
        ("a_21.png", group, 247),
    ]:
        save(cover_crop(image, (size, size)), name)


def chat_background(photo_name: str, size: tuple[int, int]) -> Image.Image:
    photo = source(photo_name)
    # Use a blurred full-canvas copy behind a contained copy. This preserves
    # the complete portrait while avoiding empty side bars on wider devices.
    backdrop = cover_crop(photo, size, focus=(0.55, 0.58)).filter(
        ImageFilter.GaussianBlur(radius=18)
    )
    backdrop = Image.alpha_composite(backdrop, Image.new("RGBA", size, (244, 241, 248, 205)))
    foreground = ImageOps.contain(photo, size, method=Image.Resampling.LANCZOS)
    foreground = Image.alpha_composite(
        foreground,
        Image.new("RGBA", foreground.size, (244, 241, 248, 165)),
    )
    image = backdrop.copy()
    image.alpha_composite(
        foreground,
        ((size[0] - foreground.width) // 2, (size[1] - foreground.height) // 2),
    )
    # Slightly stronger top wash keeps incoming/outgoing messages readable.
    top = Image.new("RGBA", size, (0, 0, 0, 0))
    top_draw = ImageDraw.Draw(top)
    for y in range(size[1]):
        alpha = round(38 * (1 - y / max(1, size[1] - 1)))
        top_draw.line((0, y, size[0], y), fill=(255, 255, 255, alpha))
    return Image.alpha_composite(image, top)


def make_chat_backgrounds() -> None:
    save(chat_background("100041_0.jpg", (1482, 1334)), "i_22.png")
    save(chat_background("100041_0.jpg", (1300, 1300)), "a_22.png")


def validate() -> None:
    expected = {
        "ios_thumbnail.png": (200, 284),
        "android_thumbnail.png": (136, 202),
        "store_thumbnail.png": (198, 278),
        "i_11.png": (1472, 150),
        "i_20.png": (240, 240),
        "i_21.png": (240, 240),
        "a_20.png": (247, 247),
        "a_21.png": (247, 247),
        "i_22.png": (1482, 1334),
        "a_22.png": (1300, 1300),
    }
    for off, on, _ in MENU:
        expected[f"{off}.png"] = (128, 150)
        expected[f"{on}.png"] = (128, 150)
        expected[f"{off}_g.png"] = (80, 56)
        expected[f"{on}_g.png"] = (80, 56)
    for index in range(4):
        off = 12 + index * 2
        expected[f"i_{off:02d}.png"] = (120, 120)
        expected[f"i_{off + 1:02d}.png"] = (120, 120)
        expected[f"a_{off:02d}.png"] = (116, 116)
        expected[f"a_{off + 1:02d}.png"] = (116, 116)

    actual = {path.name for path in OUTPUT.glob("*.png")}
    if actual != set(expected):
        missing = sorted(set(expected) - actual)
        extra = sorted(actual - set(expected))
        raise RuntimeError(f"asset set mismatch; missing={missing}, extra={extra}")
    for name, size in expected.items():
        with Image.open(OUTPUT / name) as image:
            if image.size != size or image.format != "PNG":
                raise RuntimeError(f"invalid {name}: {image.size}, {image.format}")
    with Image.open(OUTPUT / "i_11.png").convert("RGBA") as menu_background:
        bottom_alpha = menu_background.getchannel("A").crop((0, 50, 1472, 150))
        if bottom_alpha.getextrema() != (255, 255):
            raise RuntimeError("i_11.png bottom 100 rows must be fully opaque")
    for name in ("i_22.png", "a_22.png"):
        if (OUTPUT / name).stat().st_size > 1_000_000:
            raise RuntimeError(f"{name} exceeds LINE's 1 MB chat-background limit")


def build_zip() -> None:
    with zipfile.ZipFile(ZIP_PATH, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for path in sorted(OUTPUT.glob("*.png")):
            archive.write(path, arcname=path.name)


def main() -> int:
    shutil.rmtree(OUTPUT, ignore_errors=True)
    OUTPUT.mkdir()
    make_cover("ios_thumbnail.png", (200, 284))
    make_cover("android_thumbnail.png", (136, 202))
    make_cover("store_thumbnail.png", (198, 278))
    make_menu_icons()
    make_menu_background()
    make_passcode()
    make_profiles()
    make_chat_backgrounds()
    validate()
    build_zip()
    print(f"Generated {len(list(OUTPUT.glob('*.png')))} PNG assets")
    print(f"Theme folder: {OUTPUT}")
    print(f"Upload ZIP: {ZIP_PATH}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

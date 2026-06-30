#!/usr/bin/env python3
"""Local-only server for the creator background-removal workspace."""

from __future__ import annotations

import argparse
import base64
import io
import json
import mimetypes
import re
import zipfile
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse

from PIL import Image, ImageFilter, UnidentifiedImageError


ROOT = Path(__file__).resolve().parent
MAX_BODY = 30 * 1024 * 1024
_session = None
IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp"}
PRESETS = {
    "line-icons": [(120, 120), (116, 116), (240, 240), (247, 247), (128, 150), (80, 56)],
}
CLEANUP_PRESETS = {
    "off": {"alpha": 10, "shrink": 0, "feather": 0.0, "min_area": 0.0},
    "photo": {"alpha": 22, "shrink": 1, "feather": 1.0, "min_area": 0.00025},
    "drawing": {"alpha": 36, "shrink": 1, "feather": 0.7, "min_area": 0.00018},
    "cartoon": {"alpha": 62, "shrink": 2, "feather": 0.5, "min_area": 0.00045},
}


def rembg_status() -> tuple[bool, str]:
    try:
        import rembg  # noqa: F401
    except ImportError:
        return False, "rembg is not installed"
    return True, "u2netp"


def decode_data_url(value: str) -> bytes:
    if not value.startswith("data:image/") or "," not in value:
        raise ValueError("Expected an image data URL")
    return base64.b64decode(value.split(",", 1)[1], validate=True)


def remove_background(data: bytes) -> bytes:
    global _session
    from rembg import new_session, remove

    with Image.open(io.BytesIO(data)) as image:
        image = image.convert("RGBA")
        if image.width * image.height > 25_000_000:
            raise ValueError("Image is too large; maximum is 25 megapixels")
        source = io.BytesIO()
        image.save(source, "PNG")
    if _session is None:
        _session = new_session("u2netp")
    result = remove(source.getvalue(), session=_session, alpha_matting=False)
    with Image.open(io.BytesIO(result)) as output:
        output = output.convert("RGBA")
        encoded = io.BytesIO()
        output.save(encoded, "PNG", optimize=True)
        return encoded.getvalue()


def parse_size(value: str) -> tuple[int, int]:
    match = re.fullmatch(r"(\d{2,4})x(\d{2,4})", value.lower())
    if not match:
        raise argparse.ArgumentTypeError("Use WIDTHxHEIGHT, for example 240x240")
    width, height = int(match.group(1)), int(match.group(2))
    if width < 16 or height < 16 or width > 4096 or height > 4096:
        raise argparse.ArgumentTypeError("Size must be between 16 and 4096 pixels")
    return width, height


def alpha_components(image: Image.Image, alpha_threshold: int = 10) -> list[dict]:
    image = image.convert("RGBA")
    width, height = image.size
    alpha = image.getchannel("A").tobytes()
    total = width * height
    visited = bytearray(total)
    min_area = max(20, round(total * 0.00035))
    components = []

    for start in range(total):
        if visited[start] or alpha[start] <= alpha_threshold:
            continue
        queue = deque([start])
        visited[start] = 1
        min_x, min_y, max_x, max_y = width, height, -1, -1
        area = 0
        sum_x = 0
        sum_y = 0
        while queue:
            index = queue.pop()
            x = index % width
            y = index // width
            area += 1
            sum_x += x
            sum_y += y
            min_x = min(min_x, x)
            min_y = min(min_y, y)
            max_x = max(max_x, x)
            max_y = max(max_y, y)
            for next_index in (index - 1, index + 1, index - width, index + width):
                if next_index < 0 or next_index >= total or visited[next_index]:
                    continue
                if (next_index == index - 1 and x == 0) or (next_index == index + 1 and x == width - 1):
                    continue
                if alpha[next_index] <= alpha_threshold:
                    continue
                visited[next_index] = 1
                queue.append(next_index)
        if area >= min_area:
            components.append({
                "x": min_x,
                "y": min_y,
                "width": max_x - min_x + 1,
                "height": max_y - min_y + 1,
                "area": area,
                "cx": sum_x / area,
                "cy": sum_y / area,
            })
    return sorted(components, key=lambda item: item["area"], reverse=True)


def select_subject_bounds(image: Image.Image, mode: str) -> tuple[int, int, int, int] | None:
    components = alpha_components(image)
    if not components:
        return None
    selected = components
    if mode == "largest":
        selected = components[:1]
    elif mode == "top2":
        selected = components[:2]
    elif mode == "center":
        center_x, center_y = image.width / 2, image.height / 2
        selected = [min(components, key=lambda item: ((item["cx"] - center_x) ** 2 + (item["cy"] - center_y) ** 2) ** 0.5)]
    min_x = min(item["x"] for item in selected)
    min_y = min(item["y"] for item in selected)
    max_x = max(item["x"] + item["width"] for item in selected)
    max_y = max(item["y"] + item["height"] for item in selected)
    return min_x, min_y, max_x, max_y


def cleanup_values(preset: str, strength: int) -> dict:
    base = CLEANUP_PRESETS[preset]
    if preset == "off":
        return base
    factor = 0.45 + max(0, min(100, strength)) / 100 * 1.1
    return {
        "alpha": round(10 + (base["alpha"] - 10) * factor),
        "shrink": round(base["shrink"] * (0.5 + max(0, min(100, strength)) / 100)),
        "feather": base["feather"] * (0.45 + max(0, min(100, strength)) / 100 * 0.9),
        "min_area": base["min_area"] * factor,
    }


def clean_mask(image: Image.Image, preset: str, strength: int) -> Image.Image:
    image = image.convert("RGBA")
    if preset == "off":
        return image
    settings = cleanup_values(preset, strength)
    alpha = image.getchannel("A").point(lambda value: 255 if value > settings["alpha"] else 0)
    mask_image = Image.new("RGBA", image.size, (255, 255, 255, 0))
    mask_image.putalpha(alpha)
    components = alpha_components(mask_image, alpha_threshold=10)
    min_area = max(12, round(image.width * image.height * settings["min_area"]))
    kept_alpha = Image.new("L", image.size, 0)
    for component in components:
        if component["area"] < min_area:
            continue
        component_mask = alpha.crop((
            component["x"],
            component["y"],
            component["x"] + component["width"],
            component["y"] + component["height"],
        ))
        kept_alpha.paste(component_mask, (component["x"], component["y"]))

    for _ in range(settings["shrink"]):
        kept_alpha = kept_alpha.filter(ImageFilter.MinFilter(3))
    if settings["feather"] > 0:
        kept_alpha = kept_alpha.filter(ImageFilter.GaussianBlur(radius=settings["feather"]))
        kept_alpha = kept_alpha.point(lambda value: min(255, round(value * 1.15)))

    output = image.copy()
    output.putalpha(kept_alpha)
    return output


def render_cutout(image: Image.Image, size: tuple[int, int], padding_percent: int, subject_mode: str) -> Image.Image:
    image = image.convert("RGBA")
    bounds = select_subject_bounds(image, subject_mode) or (0, 0, image.width, image.height)
    crop = image.crop(bounds)
    output_width, output_height = size
    padding = max(0, min(35, padding_percent)) / 100
    available_width = output_width * (1 - padding * 2)
    available_height = output_height * (1 - padding * 2)
    scale = min(available_width / crop.width, available_height / crop.height)
    draw_width = max(1, round(crop.width * scale))
    draw_height = max(1, round(crop.height * scale))
    resized = crop.resize((draw_width, draw_height), Image.Resampling.LANCZOS)
    output = Image.new("RGBA", size, (0, 0, 0, 0))
    output.alpha_composite(resized, ((output_width - draw_width) // 2, (output_height - draw_height) // 2))
    return output


def slugify_stem(path: Path) -> str:
    stem = re.sub(r"[^A-Za-z0-9._-]+", "-", path.stem).strip("-")
    return stem or "image"


def run_batch(args: argparse.Namespace) -> None:
    input_dir = args.input.resolve()
    output_dir = args.output.resolve()
    if not input_dir.is_dir():
        raise SystemExit(f"Input folder not found: {input_dir}")
    sizes = PRESETS[args.preset] if args.preset else args.size
    output_dir.mkdir(parents=True, exist_ok=True)
    images = sorted(path for path in input_dir.iterdir() if path.suffix.lower() in IMAGE_EXTENSIONS)
    if not images:
        raise SystemExit("No JPG, PNG, or WebP images found")

    exported = []
    for image_path in images:
        try:
            with Image.open(image_path) as opened:
                image = opened.convert("RGBA")
        except UnidentifiedImageError:
            print(f"skip {image_path.name}: unreadable image file")
            continue
        if image.width * image.height > 25_000_000:
            print(f"skip {image_path.name}: larger than 25 megapixels")
            continue
        if not args.skip_remove:
            source = io.BytesIO()
            image.save(source, "PNG")
            image = Image.open(io.BytesIO(remove_background(source.getvalue()))).convert("RGBA")
        image = clean_mask(image, args.cleanup_preset, args.cleanup_strength)
        for size in sizes:
            result = render_cutout(image, size, args.padding, args.subject_mode)
            output_name = f"{slugify_stem(image_path)}-{size[0]}x{size[1]}.png"
            output_path = output_dir / output_name
            result.save(output_path, "PNG", optimize=True)
            exported.append(output_path)
            print(f"wrote {output_path}")

    if args.zip:
        zip_path = args.zip.resolve()
        with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            for path in exported:
                archive.write(path, path.relative_to(output_dir.parent))
        print(f"wrote {zip_path}")


class Handler(BaseHTTPRequestHandler):
    server_version = "CreatorCutout/0.1"

    def send_json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        if parsed.path == "/api/health":
            available, detail = rembg_status()
            self.send_json(200, {"ok": True, "backgroundRemoval": available, "model": detail})
            return

        relative = unquote(parsed.path.lstrip("/")) or "index.html"
        candidate = (ROOT / relative).resolve()
        if ROOT not in candidate.parents and candidate != ROOT:
            self.send_error(403)
            return
        if not candidate.is_file():
            self.send_error(404)
            return
        content = candidate.read_bytes()
        content_type = mimetypes.guess_type(candidate.name)[0] or "application/octet-stream"
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(content)))
        self.end_headers()
        self.wfile.write(content)

    def do_POST(self) -> None:  # noqa: N802
        if urlparse(self.path).path != "/api/remove-background":
            self.send_error(404)
            return
        available, detail = rembg_status()
        if not available:
            self.send_json(503, {"error": detail, "install": "pip install -r requirements.txt"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length <= 0 or length > MAX_BODY:
                raise ValueError("Request body is empty or too large")
            payload = json.loads(self.rfile.read(length))
            output = remove_background(decode_data_url(payload.get("image", "")))
            encoded = base64.b64encode(output).decode("ascii")
            self.send_json(200, {"image": f"data:image/png;base64,{encoded}"})
        except (ValueError, json.JSONDecodeError) as exc:
            self.send_json(400, {"error": str(exc)})
        except Exception as exc:  # Keep model/runtime failures visible to the UI.
            self.send_json(500, {"error": f"Background removal failed: {exc}"})

    def log_message(self, message: str, *args) -> None:
        print(f"[creator-tool] {message % args}")


def main() -> None:
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="command")
    serve_parser = subparsers.add_parser("serve", help="start the local web UI")
    serve_parser.add_argument("--port", type=int, default=4173)
    batch_parser = subparsers.add_parser("batch", help="process a folder into transparent PNG outputs")
    batch_parser.add_argument("input", type=Path)
    batch_parser.add_argument("--output", type=Path, default=ROOT / "outputs")
    batch_parser.add_argument("--preset", choices=sorted(PRESETS), default="line-icons")
    batch_parser.add_argument("--size", type=parse_size, action="append", help="custom output size, for example 240x240")
    batch_parser.add_argument("--padding", type=int, default=12)
    batch_parser.add_argument("--subject-mode", choices=["all", "largest", "top2", "center"], default="all")
    batch_parser.add_argument("--cleanup-preset", choices=sorted(CLEANUP_PRESETS), default="photo")
    batch_parser.add_argument("--cleanup-strength", type=int, default=50)
    batch_parser.add_argument("--skip-remove", action="store_true", help="skip AI background removal and use existing alpha")
    batch_parser.add_argument("--zip", type=Path, help="write a ZIP containing all exported PNG files")
    parser.add_argument("--port", type=int, default=4173, help=argparse.SUPPRESS)
    args = parser.parse_args()
    if args.command == "batch":
        if args.size:
            args.preset = None
        run_batch(args)
        return
    port = getattr(args, "port", 4173)
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(f"Creator Cutout Studio: http://127.0.0.1:{port}")
    server.serve_forever()


if __name__ == "__main__":
    main()

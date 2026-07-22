#!/usr/bin/env python3
"""Unified local server for the LINE theme editor and Cutout Studio."""

from __future__ import annotations

import argparse
import base64
import hashlib
import io
import json
import mimetypes
import re
import time
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, quote, unquote, urlparse

import cv2
import numpy as np
from PIL import Image, ImageChops, UnidentifiedImageError

from creator_tool.server import (
    CLEANUP_PRESETS,
    MAX_BODY,
    clean_mask,
    decode_data_url,
    detect_faces,
    detect_subject,
    face_detection_status,
    image_analysis_metrics,
    remove_background,
    rembg_status,
)


ROOT = Path(__file__).resolve().parent
INTERACTIVE_ZIP = ROOT / "line_theme_interactive.zip"
PRODUCT_ZIPS = {"sticker": ROOT / "line_stickers.zip", "emoji": ROOT / "line_emoji.zip"}
MAX_ZIP_BODY = 100 * 1024 * 1024
IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp"}
WORKSPACE_DIR = ROOT / ".workspace"
IMPORT_DIR = WORKSPACE_DIR / "imports"
CACHE_DIR = ROOT / ".cache" / "cutouts"
IMPORT_DIR.mkdir(parents=True, exist_ok=True)
CACHE_DIR.mkdir(parents=True, exist_ok=True)


def safe_filename(value: str) -> str:
    name = Path(value).name
    stem = re.sub(r"[^\w.-]+", "-", Path(name).stem, flags=re.UNICODE).strip("-._") or "image"
    suffix = Path(name).suffix.lower()
    return f"{stem[:80]}{suffix}"


def asset_paths() -> list[Path]:
    root_images = [
        path for path in ROOT.iterdir()
        if path.is_file() and path.suffix.lower() in IMAGE_EXTENSIONS
        and not path.name.startswith(("i_", "a_"))
        and path.name not in {"ios_thumbnail.png", "android_thumbnail.png", "store_thumbnail.png"}
    ]
    imported = [path for path in IMPORT_DIR.iterdir() if path.is_file() and path.suffix.lower() in IMAGE_EXTENSIONS]
    return sorted(root_images + imported, key=lambda path: path.name.lower())


def asset_id(path: Path) -> str:
    return path.relative_to(ROOT).as_posix()


def asset_url(path: Path) -> str:
    return "/" + quote(asset_id(path), safe="/")


def asset_record(path: Path) -> dict:
    display_name = path.name.split("-", 1)[1] if path.parent == IMPORT_DIR and "-" in path.name else path.name
    return {"id": asset_id(path), "name": display_name, "url": asset_url(path)}


def resolve_asset(value: str) -> Path:
    candidate = (ROOT / unquote(value)).resolve()
    if ROOT not in candidate.parents or not candidate.is_file() or candidate.suffix.lower() not in IMAGE_EXTENSIONS:
        raise ValueError("Unknown image asset")
    return candidate


def analyze_asset(path: Path, face_available: bool = True) -> dict:
    with Image.open(path) as opened:
        image = opened.convert("RGBA")
        faces = detect_faces(image) if face_available else []
        return {
            **asset_record(path),
            "width": image.width,
            "height": image.height,
            "faces": faces,
            "quality": image_analysis_metrics(image, faces),
        }


def cutout_cache_path(source: bytes, mode: str) -> Path:
    digest = hashlib.sha256(source + f"|cutout-v2|{mode}|cleanup-photo-52".encode()).hexdigest()
    return CACHE_DIR / f"{digest}.png"


def person_isolation_cache_path(source: bytes, mode: str, faces: list[dict], selected: list[int]) -> Path:
    signature = json.dumps({"mode": mode, "faces": faces, "selected": selected}, sort_keys=True, separators=(",", ":"))
    digest = hashlib.sha256(source + b"|people-watershed-v2-head-protect|" + signature.encode()).hexdigest()
    return CACHE_DIR / f"{digest}.png"


def isolate_people(source: bytes, mode: str, faces: list[dict], selected: list[int]) -> tuple[Path, dict]:
    if not 2 <= len(faces) <= 20:
        raise ValueError("People isolation requires 2 to 20 detected faces")
    selected = sorted(set(selected))
    if not selected or any(index < 0 or index >= len(faces) for index in selected):
        raise ValueError("Select at least one valid person")
    base_path = cutout_cache_path(source, mode)
    if not base_path.is_file():
        result = remove_background(source, mode=mode)
        with Image.open(io.BytesIO(result)) as opened:
            clean_mask(opened.convert("RGBA"), "photo", 52).save(base_path, "PNG", optimize=True)
    normalized_faces = []
    with Image.open(io.BytesIO(source)) as opened:
        rgb = np.array(opened.convert("RGB"))
    with Image.open(base_path) as opened:
        cutout = np.array(opened.convert("RGBA"))
    height, width = rgb.shape[:2]
    if cutout.shape[:2] != (height, width):
        cutout = cv2.resize(cutout, (width, height), interpolation=cv2.INTER_LINEAR)
    for face in faces:
        normalized_faces.append({
            key: max(0, int(round(float(face.get(key, 0)))))
            for key in ("x", "y", "width", "height")
        })
    cached = person_isolation_cache_path(source, mode, normalized_faces, selected)
    if cached.is_file():
        return cached, {"method": "face-seeded-watershed", "selected": selected, "removed": len(faces) - len(selected), "headProtected": True, "cached": True}

    alpha = cutout[:, :, 3]
    markers = np.zeros((height, width), dtype=np.int32)
    markers[alpha < 20] = 1
    for index, face in enumerate(normalized_faces):
        face_width = max(2, min(width, face["width"]))
        face_height = max(2, min(height, face["height"]))
        center = (
            min(width - 1, face["x"] + round(face_width / 2)),
            min(height - 1, face["y"] + round(face_height * 0.52)),
        )
        seed = np.zeros((height, width), dtype=np.uint8)
        cv2.ellipse(seed, center, (max(3, round(face_width * 0.22)), max(3, round(face_height * 0.24))), 0, 0, 360, 255, -1)
        markers[(seed > 0) & (alpha >= 20)] = index + 2
    cv2.watershed(cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR), markers)
    keep = np.isin(markers, np.array([index + 2 for index in selected], dtype=np.int32)).astype(np.uint8) * 255
    # Watershed seeds sit inside the detected face and can stop at a strong
    # hairline edge. Restore only the alpha-connected head component inside a
    # bounded per-face window so hair and hats return without reviving a
    # neighbouring person.
    foreground = (alpha >= 20).astype(np.uint8)
    head_keep = np.zeros((height, width), dtype=np.uint8)
    for index in selected:
        face = normalized_faces[index]
        face_width = max(2, min(width, face["width"]))
        face_height = max(2, min(height, face["height"]))
        x0 = max(0, round(face["x"] - face_width * 0.55))
        y0 = max(0, round(face["y"] - face_height * 0.75))
        x1 = min(width, round(face["x"] + face_width * 1.55))
        y1 = min(height, round(face["y"] + face_height * 0.92))
        if x1 <= x0 or y1 <= y0:
            continue
        roi = foreground[y0:y1, x0:x1]
        _, labels = cv2.connectedComponents(roi, connectivity=8)
        seed_x = min(x1 - x0 - 1, max(0, round(face["x"] + face_width / 2) - x0))
        seed_y = min(y1 - y0 - 1, max(0, round(face["y"] + face_height * 0.52) - y0))
        label = int(labels[seed_y, seed_x])
        if label:
            head_keep[y0:y1, x0:x1][labels == label] = 255
    keep = np.maximum(keep, head_keep)
    kernel_size = max(3, round(max(width, height) / 180)) | 1
    keep = cv2.morphologyEx(keep, cv2.MORPH_CLOSE, np.ones((kernel_size, kernel_size), np.uint8))
    keep = cv2.GaussianBlur(keep, (0, 0), max(0.8, max(width, height) / 1100))
    isolated = cutout.copy()
    isolated[:, :, 3] = np.minimum(alpha, keep)
    Image.fromarray(isolated, "RGBA").save(cached, "PNG", optimize=True)
    original_area = int(np.count_nonzero(alpha > 20))
    retained_area = int(np.count_nonzero(isolated[:, :, 3] > 20))
    report = {
        "method": "face-seeded-watershed",
        "selected": selected,
        "removed": len(faces) - len(selected),
        "headProtected": True,
        "retainedRatio": round(retained_area / original_area, 3) if original_area else 0,
        "cached": False,
    }
    return cached, report


def cutout_quality_report(source: bytes) -> dict:
    paths = {mode: cutout_cache_path(source, mode) for mode in ("draft", "quality")}
    if not all(path.is_file() for path in paths.values()):
        return {"risk": "unknown", "maskAgreement": None, "warnings": []}
    masks = []
    for mode in ("draft", "quality"):
        with Image.open(paths[mode]) as opened:
            alpha = opened.convert("RGBA").getchannel("A")
            scale = min(1.0, 360 / max(alpha.size))
            if scale < 1:
                alpha = alpha.resize((max(1, round(alpha.width * scale)), max(1, round(alpha.height * scale))), Image.Resampling.BILINEAR)
            masks.append(alpha.point(lambda value: 255 if value > 32 else 0))
    intersection = sum(ImageChops.multiply(masks[0], masks[1]).histogram()[1:])
    union = sum(ImageChops.lighter(masks[0], masks[1]).histogram()[1:])
    agreement = intersection / union if union else 1.0
    warnings = []
    if agreement < 0.72:
        risk = "high"
        warnings.append("草稿與高品質遮罩差異很大，可能有背景殘留或主體缺損")
    elif agreement < 0.88:
        risk = "review"
        warnings.append("兩種去背結果差異較大，建議放大檢查邊緣")
    else:
        risk = "low"
    return {"risk": risk, "maskAgreement": round(agreement, 3), "warnings": warnings}


def expected_theme_specs() -> dict[str, tuple[int, int]]:
    specs = {
        "ios_thumbnail.png": (200, 284), "android_thumbnail.png": (136, 202),
        "store_thumbnail.png": (198, 278), "i_11.png": (1472, 150),
        "i_20.png": (240, 240), "i_21.png": (240, 240),
        "a_20.png": (247, 247), "a_21.png": (247, 247),
        "i_22.png": (1482, 1334), "a_22.png": (1300, 1300),
    }
    for index in range(4):
        off = 12 + index * 2
        specs[f"i_{off}.png"] = (120, 120)
        specs[f"i_{off + 1}.png"] = (120, 120)
        specs[f"a_{off}.png"] = (116, 116)
        specs[f"a_{off + 1}.png"] = (116, 116)
    for off, on in [
        ("i_29", "i_30"), ("i_03", "i_04"), ("i_33", "i_34"),
        ("i_31", "i_32"), ("i_25", "i_26"), ("i_27", "i_28"),
        ("i_37", "i_38"), ("i_35", "i_36"), ("i_07", "i_08"),
    ]:
        specs[f"{off}.png"] = (128, 150)
        specs[f"{on}.png"] = (128, 150)
        specs[f"{off}_g.png"] = (80, 56)
        specs[f"{on}_g.png"] = (80, 56)
    return specs


def validate_theme_zip(data: bytes) -> list[str]:
    errors = []
    expected = expected_theme_specs()
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            entries = [entry for entry in archive.infolist() if not entry.is_dir()]
            names = [entry.filename for entry in entries]
            if len(names) != len(set(names)):
                errors.append("ZIP contains duplicate filenames")
            if any(Path(name).name != name for name in names):
                errors.append("ZIP must be flat and cannot contain folders")
            missing = sorted(set(expected) - set(names))
            extra = sorted(set(names) - set(expected))
            if missing:
                errors.append(f"Missing files: {', '.join(missing[:8])}")
            if extra:
                errors.append(f"Unexpected files: {', '.join(extra[:8])}")
            for name, size in expected.items():
                if name not in names:
                    continue
                payload = archive.read(name)
                try:
                    with Image.open(io.BytesIO(payload)) as image:
                        if image.format != "PNG" or image.size != size:
                            errors.append(f"Invalid {name}: expected PNG {size[0]}x{size[1]}")
                        if name == "i_11.png":
                            alpha = image.convert("RGBA").getchannel("A").crop((0, 50, 1472, 150))
                            if alpha.getextrema() != (255, 255):
                                errors.append("i_11.png bottom 100px must be fully opaque")
                except Exception:
                    errors.append(f"Unreadable PNG: {name}")
                if name in {"i_22.png", "a_22.png"} and len(payload) > 1_000_000:
                    errors.append(f"{name} exceeds 1 MB")
    except zipfile.BadZipFile:
        errors.append("Uploaded file is not a valid ZIP")
    return errors


def optimize_theme_zip(data: bytes) -> tuple[bytes, list[str]]:
    notes = []
    source = zipfile.ZipFile(io.BytesIO(data))
    output = io.BytesIO()
    with source, zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as target:
        for entry in source.infolist():
            if entry.is_dir():
                continue
            payload = source.read(entry.filename)
            if entry.filename in {"i_22.png", "a_22.png"} and len(payload) > 1_000_000:
                with Image.open(io.BytesIO(payload)) as image:
                    optimized = io.BytesIO()
                    image.convert("RGB").quantize(colors=192).save(optimized, "PNG", optimize=True)
                    payload = optimized.getvalue()
                notes.append(f"Optimized {entry.filename} to {len(payload) / 1_000_000:.2f} MB")
            target.writestr(entry.filename, payload)
    return output.getvalue(), notes


def validate_product_zip(data: bytes, mode: str) -> list[str]:
    errors = []
    limit = 60_000_000 if mode == "sticker" else 20_000_000
    if len(data) >= limit:
        errors.append(f"ZIP exceeds {limit // 1_000_000} MB")
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            entries = [entry for entry in archive.infolist() if not entry.is_dir()]
            names = [entry.filename for entry in entries]
            if len(names) != len(set(names)):
                errors.append("ZIP contains duplicate filenames")
            if any(Path(name).name != name for name in names):
                errors.append("ZIP must be flat and cannot contain folders")
            content_names = sorted(name for name in names if name[:-4].isdigit() and name.endswith(".png"))
            count = len(content_names)
            if mode == "sticker":
                if count not in {8, 16, 24, 32, 40}:
                    errors.append("Sticker count must be 8, 16, 24, 32, or 40")
                expected_names = {f"{index:02d}.png" for index in range(1, count + 1)} | {"main.png", "tab_on.png"}
                content_size = (370, 320)
            else:
                if not 8 <= count <= 40:
                    errors.append("Emoji count must be between 8 and 40")
                expected_names = {f"{index:03d}.png" for index in range(1, count + 1)} | {"tab_on.png"}
                content_size = (180, 180)
            missing = sorted(expected_names - set(names))
            extra = sorted(set(names) - expected_names)
            if missing:
                errors.append(f"Missing files: {', '.join(missing[:8])}")
            if extra:
                errors.append(f"Unexpected files: {', '.join(extra[:8])}")
            for name in expected_names & set(names):
                payload = archive.read(name)
                if len(payload) >= 1_000_000:
                    errors.append(f"{name} exceeds 1 MB")
                expected_size = (240, 240) if name == "main.png" else (96, 74) if name == "tab_on.png" else content_size
                try:
                    with Image.open(io.BytesIO(payload)) as image:
                        if image.format != "PNG" or image.size != expected_size:
                            errors.append(f"Invalid {name}: expected PNG {expected_size[0]}x{expected_size[1]}")
                        alpha = image.convert("RGBA").getchannel("A")
                        minimum, maximum = alpha.getextrema()
                        if maximum <= 10:
                            errors.append(f"{name} has no visible content")
                        if minimum == 255:
                            errors.append(f"{name} has no transparent background")
                except Exception:
                    errors.append(f"Unreadable PNG: {name}")
    except zipfile.BadZipFile:
        errors.append("Uploaded file is not a valid ZIP")
    return errors


def encode_png(image: Image.Image) -> str:
    output = io.BytesIO()
    image.convert("RGBA").save(output, "PNG", optimize=True)
    return "data:image/png;base64," + base64.b64encode(output.getvalue()).decode("ascii")


class Handler(BaseHTTPRequestHandler):
    server_version = "LineThemeStudio/3.0"

    def send_json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        try:
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            return

    def read_json(self) -> dict:
        length = int(self.headers.get("Content-Length", "0"))
        if length <= 0 or length > MAX_BODY:
            raise ValueError("Request body is empty or too large")
        return json.loads(self.rfile.read(length))

    def do_GET(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        if parsed.path == "/api/health":
            available, detail = rembg_status()
            face_available, face_detail = face_detection_status()
            self.send_json(200, {
                "ok": True,
                "backgroundRemoval": available,
                "model": detail,
                "faceDetection": face_available,
                "faceModel": face_detail,
            })
            return
        if parsed.path == "/favicon.ico":
            self.send_response(204)
            self.end_headers()
            return
        if parsed.path == "/api/images":
            assets = [asset_record(path) for path in asset_paths()]
            self.send_json(200, {"images": [asset["id"] for asset in assets], "assets": assets})
            return
        if parsed.path == "/api/analyze-images":
            face_available, face_detail = face_detection_status()
            analysis = []
            for image_path in asset_paths():
                try:
                    analysis.append(analyze_asset(image_path, face_available))
                except Exception:
                    continue
            self.send_json(200, {"images": analysis, "faceDetection": face_available, "model": face_detail})
            return
        if parsed.path == "/api/cutout-cache":
            query = parse_qs(parsed.query)
            mode = query.get("mode", ["draft"])[0]
            if mode not in {"draft", "quality"}:
                self.send_json(400, {"error": "mode must be draft or quality"})
                return
            try:
                source = resolve_asset(query.get("asset", [""])[0]).read_bytes()
                cached = cutout_cache_path(source, mode)
                self.send_json(200, {
                    "cached": cached.is_file(),
                    "url": asset_url(cached) if cached.is_file() else None,
                    "mode": mode,
                    "quality": cutout_quality_report(source),
                })
            except ValueError as exc:
                self.send_json(404, {"error": str(exc)})
            return
        if parsed.path == "/creator_tool":
            self.send_response(302)
            self.send_header("Location", "/creator_tool/")
            self.end_headers()
            return

        relative = unquote(parsed.path.lstrip("/")) or "index.html"
        if relative.endswith("/"):
            relative += "index.html"
        candidate = (ROOT / relative).resolve()
        if ROOT not in candidate.parents or not candidate.is_file():
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
        parsed = urlparse(self.path)
        path = parsed.path
        if path == "/api/import-image":
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if length <= 0 or length > MAX_BODY:
                    raise ValueError("Image is empty or larger than 30 MB")
                filename = safe_filename(unquote(self.headers.get("X-Filename", "image.png")))
                if Path(filename).suffix.lower() not in IMAGE_EXTENSIONS:
                    raise ValueError("Only JPG, PNG, and WebP are supported")
                payload = self.rfile.read(length)
                with Image.open(io.BytesIO(payload)) as opened:
                    opened.verify()
                digest = hashlib.sha256(payload).hexdigest()
                output = IMPORT_DIR / f"{digest[:16]}-{filename}"
                duplicate = output.exists()
                if not duplicate:
                    output.write_bytes(payload)
                face_available, _ = face_detection_status()
                self.send_json(200, {"asset": asset_record(output), "analysis": analyze_asset(output, face_available), "duplicate": duplicate})
            except (ValueError, UnidentifiedImageError) as exc:
                self.send_json(400, {"error": str(exc)})
            return
        if path == "/api/save-product-zip":
            mode = parse_qs(parsed.query).get("mode", [""])[0]
            if mode not in PRODUCT_ZIPS:
                self.send_json(400, {"error": "mode must be sticker or emoji"})
                return
            length = int(self.headers.get("Content-Length", "0"))
            limit = 60_000_000 if mode == "sticker" else 20_000_000
            if length <= 0 or length >= limit:
                self.send_json(400, {"error": f"ZIP is empty or exceeds {limit // 1_000_000} MB"})
                return
            payload = self.rfile.read(length)
            errors = validate_product_zip(payload, mode)
            if errors:
                self.send_json(422, {"error": "Product validation failed", "errors": errors})
                return
            output = PRODUCT_ZIPS[mode]
            output.write_bytes(payload)
            self.send_json(200, {"success": True, "path": str(output), "size": len(payload)})
            return
        if path == "/api/save-zip":
            length = int(self.headers.get("Content-Length", "0"))
            if length <= 0 or length > MAX_ZIP_BODY:
                self.send_json(400, {"error": "ZIP is empty or larger than 100 MB"})
                return
            try:
                payload, notes = optimize_theme_zip(self.rfile.read(length))
            except zipfile.BadZipFile:
                self.send_json(400, {"error": "Uploaded file is not a valid ZIP"})
                return
            errors = validate_theme_zip(payload)
            if errors:
                self.send_json(422, {"error": "Theme validation failed", "errors": errors})
                return
            INTERACTIVE_ZIP.write_bytes(payload)
            self.send_json(200, {
                "success": True,
                "path": str(INTERACTIVE_ZIP),
                "size": INTERACTIVE_ZIP.stat().st_size,
                "notes": notes,
            })
            return
        if path not in {"/api/remove-background", "/api/isolate-people", "/api/clean-mask", "/api/detect-faces", "/api/detect-subject"}:
            self.send_error(404)
            return
        try:
            payload = self.read_json()
            if path == "/api/detect-subject":
                with Image.open(io.BytesIO(decode_data_url(payload.get("image", "")))) as opened:
                    subject = detect_subject(opened)
                    width, height = opened.size
                self.send_json(200, {"subject": subject, "width": width, "height": height})
                return
            if path == "/api/detect-faces":
                available, detail = face_detection_status()
                if not available:
                    self.send_json(503, {"error": detail})
                    return
                with Image.open(io.BytesIO(decode_data_url(payload.get("image", "")))) as opened:
                    image = opened.convert("RGBA")
                    faces = detect_faces(image)
                self.send_json(200, {
                    "faces": faces,
                    "width": image.width,
                    "height": image.height,
                    "model": detail,
                })
                return
            if path == "/api/remove-background":
                available, detail = rembg_status()
                if not available:
                    self.send_json(503, {"error": detail, "install": "pip install -r creator_tool/requirements.txt"})
                    return
                mode = payload.get("mode", "quality")
                if mode not in {"draft", "quality"}:
                    raise ValueError("mode must be draft or quality")
                source = resolve_asset(payload["assetId"]).read_bytes() if payload.get("assetId") else decode_data_url(payload.get("image", ""))
                cached = cutout_cache_path(source, mode)
                was_cached = cached.is_file()
                started = time.monotonic()
                if not was_cached:
                    result = remove_background(source, mode=mode)
                    with Image.open(io.BytesIO(result)) as opened:
                        cleaned = clean_mask(opened.convert("RGBA"), "photo", 52)
                        cleaned.save(cached, "PNG", optimize=True)
                elapsed = time.monotonic() - started
                url = asset_url(cached)
                self.send_json(200, {
                    "image": url,
                    "url": url,
                    "cached": was_cached,
                    "elapsed": round(elapsed, 3),
                    "mode": mode,
                    "model": "u2netp" if mode == "draft" else "isnet-general-use",
                    "cleaned": True,
                    "quality": cutout_quality_report(source),
                })
                return

            if path == "/api/isolate-people":
                mode = payload.get("mode", "quality")
                if mode not in {"draft", "quality"}:
                    raise ValueError("mode must be draft or quality")
                source = resolve_asset(payload.get("assetId", "")).read_bytes()
                faces = payload.get("faces") if isinstance(payload.get("faces"), list) else []
                selected = payload.get("selected") if isinstance(payload.get("selected"), list) else []
                path_out, report = isolate_people(source, mode, faces, [int(index) for index in selected])
                self.send_json(200, {"url": asset_url(path_out), "report": report})
                return

            preset = payload.get("preset", "photo")
            if preset not in CLEANUP_PRESETS:
                raise ValueError(f"Unknown cleanup preset: {preset}")
            strength = max(0, min(100, int(payload.get("strength", 50))))
            with Image.open(io.BytesIO(decode_data_url(payload.get("image", "")))) as opened:
                image = clean_mask(opened.convert("RGBA"), preset, strength)
            self.send_json(200, {"image": encode_png(image)})
        except (ValueError, TypeError, json.JSONDecodeError) as exc:
            self.send_json(400, {"error": str(exc)})
        except Exception as exc:
            self.send_json(500, {"error": f"Image processing failed: {exc}"})

    def log_message(self, message: str, *args) -> None:
        print(f"[line-theme] {message % args}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=3000)
    args = parser.parse_args()
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print(f"LINE Theme Studio: http://127.0.0.1:{args.port}")
    print(f"Cutout Studio: http://127.0.0.1:{args.port}/creator_tool/")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nServer stopped")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()

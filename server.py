#!/usr/bin/env python3
"""Local-only server for the creator background-removal workspace."""

from __future__ import annotations

import argparse
import base64
import io
import json
import mimetypes
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse

from PIL import Image


ROOT = Path(__file__).resolve().parent
MAX_BODY = 30 * 1024 * 1024
_session = None


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
    parser.add_argument("--port", type=int, default=4173)
    args = parser.parse_args()
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print(f"Creator Cutout Studio: http://127.0.0.1:{args.port}")
    server.serve_forever()


if __name__ == "__main__":
    main()

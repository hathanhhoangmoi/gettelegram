import asyncio
import json
import mimetypes
import os
import re
import secrets
import threading
import time
from base64 import b64decode
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, quote, urlparse

from telethon import TelegramClient
from telethon.errors import SessionPasswordNeededError
from telethon.tl.types import MessageMediaPhoto
from telethon.utils import get_display_name


ROOT = Path(__file__).resolve().parent
STATIC_DIR = ROOT / "static"
DATA_DIR = Path(os.environ.get("DATA_DIR", ROOT)).resolve()
DOWNLOAD_DIR = DATA_DIR / "downloads"
THUMB_DIR = DATA_DIR / ".thumbs"
PREVIEW_DIR = DATA_DIR / ".previews"
SESSION_PATH = DATA_DIR / "telegram_downloader"
ACCESS_KEYS_PATH = Path(os.environ.get("ACCESS_KEYS_PATH", ROOT / "access_keys.txt")).resolve()
TEST_ACCESS_KEY = os.environ.get("TEST_ACCESS_KEY", "Key Test")
HOST = os.environ.get("HOST", "0.0.0.0" if os.environ.get("RENDER") else "127.0.0.1")
PORT = int(os.environ.get("PORT", "8787"))
WEB_USERNAME = os.environ.get("WEB_USERNAME", "admin")
WEB_PASSWORD = os.environ.get("WEB_PASSWORD", "")


def safe_name(value):
    value = re.sub(r"[^\w\-.() \[\]]+", "_", value, flags=re.UNICODE).strip()
    return value[:120] or "telegram"


def json_response(handler, payload, status=HTTPStatus.OK):
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Content-Length", str(len(data)))
    handler.end_headers()
    handler.wfile.write(data)


def file_response(handler, path):
    path = Path(path)
    if not path.exists() or not path.is_file():
        handler.send_error(HTTPStatus.NOT_FOUND)
        return
    content_type = mimetypes.guess_type(str(path))[0] or "application/octet-stream"
    file_size = path.stat().st_size
    start = 0
    end = file_size - 1
    status = HTTPStatus.OK
    range_header = handler.headers.get("Range")
    if range_header and range_header.startswith("bytes="):
        raw_range = range_header.removeprefix("bytes=").split(",", 1)[0]
        raw_start, _, raw_end = raw_range.partition("-")
        start = int(raw_start or 0)
        end = int(raw_end or end)
        end = min(end, file_size - 1)
        status = HTTPStatus.PARTIAL_CONTENT

    length = max(0, end - start + 1)
    handler.send_response(status)
    handler.send_header("Content-Type", content_type)
    handler.send_header("Content-Length", str(length))
    handler.send_header("Accept-Ranges", "bytes")
    if status == HTTPStatus.PARTIAL_CONTENT:
        handler.send_header("Content-Range", f"bytes {start}-{end}/{file_size}")
    handler.send_header("Cache-Control", "private, max-age=86400")
    handler.end_headers()
    with path.open("rb") as source:
        source.seek(start)
        remaining = length
        while remaining > 0:
            chunk = source.read(min(1024 * 1024, remaining))
            if not chunk:
                break
            handler.wfile.write(chunk)
            remaining -= len(chunk)


def read_json(handler):
    length = int(handler.headers.get("Content-Length", "0"))
    if length <= 0:
        return {}
    return json.loads(handler.rfile.read(length).decode("utf-8"))


def load_access_keys():
    if not ACCESS_KEYS_PATH.exists():
        return set()
    return {
        line.strip()
        for line in ACCESS_KEYS_PATH.read_text(encoding="utf-8").splitlines()
        if line.strip() and not line.strip().startswith("#")
    }


def access_key_mode(key):
    key = (key or "").strip()
    if secrets.compare_digest(key, TEST_ACCESS_KEY):
        return "test"
    valid_keys = load_access_keys()
    if any(secrets.compare_digest(key, valid_key) for valid_key in valid_keys):
        return "full"
    return None


class TelegramService:
    def __init__(self):
        self.loop = asyncio.new_event_loop()
        self.thread = threading.Thread(target=self._run_loop, daemon=True)
        self.thread.start()
        self.client = None
        self.phone = None
        self.chats = {}
        self.download_jobs = {}
        self.lock = threading.Lock()

    def _run_loop(self):
        asyncio.set_event_loop(self.loop)
        self.loop.run_forever()

    def run(self, coro):
        future = asyncio.run_coroutine_threadsafe(coro, self.loop)
        return future.result()

    def start_login(self, api_id, api_hash, phone):
        return self.run(self._start_login(api_id, api_hash, phone))

    async def _start_login(self, api_id, api_hash, phone):
        if self.client:
            await self.client.disconnect()
        self.phone = phone
        self.client = TelegramClient(str(SESSION_PATH), int(api_id), api_hash)
        await self.client.connect()
        if await self.client.is_user_authorized():
            return {"authorized": True}
        await self.client.send_code_request(phone)
        return {"authorized": False, "code_required": True}

    def complete_code(self, code, password=None):
        return self.run(self._complete_code(code, password))

    async def _complete_code(self, code, password=None):
        if not self.client or not self.phone:
            raise RuntimeError("Login has not been started.")
        try:
            await self.client.sign_in(self.phone, code)
        except SessionPasswordNeededError:
            if not password:
                return {"password_required": True}
            await self.client.sign_in(password=password)
        return {"authorized": await self.client.is_user_authorized()}

    def status(self):
        return self.run(self._status())

    async def _status(self):
        if not self.client:
            session_exists = Path(str(SESSION_PATH) + ".session").exists()
            return {"connected": False, "authorized": False, "session_exists": session_exists}
        return {
            "connected": self.client.is_connected(),
            "authorized": await self.client.is_user_authorized(),
            "session_exists": Path(str(SESSION_PATH) + ".session").exists(),
        }

    def ensure_connected(self):
        if not self.client:
            raise RuntimeError("You need to log in first.")

    def list_chats(self):
        return self.run(self._list_chats())

    async def _list_chats(self):
        self.ensure_connected()
        rows = []
        self.chats = {}
        async for dialog in self.client.iter_dialogs():
            entity = dialog.entity
            if not (dialog.is_group or dialog.is_channel):
                continue
            key = str(dialog.id)
            title = dialog.name or get_display_name(entity) or key
            self.chats[key] = entity
            rows.append(
                {
                    "id": key,
                    "title": title,
                    "type": "group" if dialog.is_group else "channel",
                    "unread_count": dialog.unread_count,
                }
            )
        rows.sort(key=lambda item: item["title"].lower())
        return rows

    def list_media(self, chat_id, limit=50, offset_id=0):
        return self.run(self._list_media(chat_id, limit, offset_id))

    async def _list_media(self, chat_id, limit=50, offset_id=0):
        self.ensure_connected()
        entity = self.chats.get(str(chat_id))
        if not entity:
            await self._list_chats()
            entity = self.chats.get(str(chat_id))
        if not entity:
            raise RuntimeError("Chat not found. Refresh the chat list.")

        items = []
        scanned = 0
        last_scanned_id = int(offset_id or 0)
        target_media_count = max(1, min(int(limit), 200))
        max_messages_to_scan = max(target_media_count * 30, 1000)

        async for message in self.client.iter_messages(entity, limit=None, offset_id=int(offset_id or 0)):
            scanned += 1
            last_scanned_id = message.id
            kind = self._media_kind(message)
            if kind:
                file_name = getattr(message.file, "name", None) if message.file else None
                ext = getattr(message.file, "ext", None) if message.file else None
                size = getattr(message.file, "size", None) if message.file else None
                items.append(
                    {
                        "id": message.id,
                        "date": message.date.isoformat() if message.date else "",
                        "kind": kind,
                        "name": file_name or f"{kind}_{message.id}{ext or ''}",
                        "size": size,
                        "text": (message.message or "").strip()[:180],
                        "thumbnail_url": f"/api/thumbnail?chat_id={chat_id}&message_id={message.id}",
                        "preview_url": f"/api/preview?chat_id={chat_id}&message_id={message.id}",
                    }
                )
            if len(items) >= target_media_count or scanned >= max_messages_to_scan:
                break

        return {
            "items": items,
            "next_offset_id": last_scanned_id if scanned else int(offset_id or 0),
            "scanned": scanned,
            "scan_limit_reached": scanned >= max_messages_to_scan and len(items) < target_media_count,
        }

    def _media_kind(self, message):
        if not message or not message.media:
            return None
        if isinstance(message.media, MessageMediaPhoto):
            return "photo"
        if message.video:
            return "video"
        return None

    def download_selected(self, chat_id, message_ids):
        job_id = f"job-{int(time.time() * 1000)}"
        with self.lock:
            self.download_jobs[job_id] = {
                "status": "queued",
                "total": len(message_ids),
                "done": 0,
                "files": [],
                "error": None,
            }
        threading.Thread(target=self._download_worker, args=(job_id, chat_id, message_ids), daemon=True).start()
        return {"job_id": job_id}

    def _download_worker(self, job_id, chat_id, message_ids):
        try:
            self.run(self._download_selected(job_id, chat_id, message_ids))
        except Exception as exc:
            with self.lock:
                self.download_jobs[job_id]["status"] = "failed"
                self.download_jobs[job_id]["error"] = str(exc)

    async def _download_selected(self, job_id, chat_id, message_ids):
        self.ensure_connected()
        entity = self.chats.get(str(chat_id))
        if not entity:
            await self._list_chats()
            entity = self.chats.get(str(chat_id))
        if not entity:
            raise RuntimeError("Chat not found. Refresh the chat list.")

        title = safe_name(get_display_name(entity) or str(chat_id))
        target_dir = DOWNLOAD_DIR / title
        target_dir.mkdir(parents=True, exist_ok=True)

        with self.lock:
            self.download_jobs[job_id]["status"] = "running"

        for message_id in message_ids:
            message = await self.client.get_messages(entity, ids=int(message_id))
            if not self._media_kind(message):
                continue
            result = await self.client.download_media(message, file=str(target_dir))
            with self.lock:
                self.download_jobs[job_id]["done"] += 1
                if result:
                    self.download_jobs[job_id]["files"].append(str(Path(result).resolve()))

        with self.lock:
            self.download_jobs[job_id]["status"] = "completed"

    def job_status(self, job_id):
        with self.lock:
            job = self.download_jobs.get(job_id)
            if not job:
                raise RuntimeError("Job not found.")
            return dict(job)

    def thumbnail_path(self, chat_id, message_id):
        return self.run(self._thumbnail_path(chat_id, message_id))

    async def _thumbnail_path(self, chat_id, message_id):
        self.ensure_connected()
        entity = self.chats.get(str(chat_id))
        if not entity:
            await self._list_chats()
            entity = self.chats.get(str(chat_id))
        if not entity:
            raise RuntimeError("Chat not found. Refresh the chat list.")

        message = await self.client.get_messages(entity, ids=int(message_id))
        if not self._media_kind(message):
            raise RuntimeError("Message does not contain a photo or video.")

        chat_key = safe_name(str(chat_id))
        target = THUMB_DIR / f"{chat_key}_{int(message_id)}.jpg"
        if target.exists():
            return target

        THUMB_DIR.mkdir(parents=True, exist_ok=True)
        result = await self.client.download_media(message, file=str(target), thumb=-1)
        if not result:
            raise RuntimeError("This media does not have a preview thumbnail.")
        return Path(result)

    def preview_path(self, chat_id, message_id):
        return self.run(self._preview_path(chat_id, message_id))

    async def _preview_path(self, chat_id, message_id):
        self.ensure_connected()
        entity = self.chats.get(str(chat_id))
        if not entity:
            await self._list_chats()
            entity = self.chats.get(str(chat_id))
        if not entity:
            raise RuntimeError("Chat not found. Refresh the chat list.")

        message = await self.client.get_messages(entity, ids=int(message_id))
        kind = self._media_kind(message)
        if not kind:
            raise RuntimeError("Message does not contain a photo or video.")

        PREVIEW_DIR.mkdir(parents=True, exist_ok=True)
        chat_key = safe_name(str(chat_id))
        cache_prefix = f"{chat_key}_{int(message_id)}_"
        cached = next(PREVIEW_DIR.glob(cache_prefix + "*"), None)
        if cached:
            return cached

        file_name = getattr(message.file, "name", None) if message.file else None
        ext = getattr(message.file, "ext", None) if message.file else None
        if not ext:
            ext = ".mp4" if kind == "video" else ".jpg"
        name = safe_name(file_name or f"{kind}_{message_id}{ext}")
        if not Path(name).suffix:
            name = f"{name}{ext}"
        target = PREVIEW_DIR / f"{cache_prefix}{name}"
        result = await self.client.download_media(message, file=str(target))
        if not result:
            raise RuntimeError("Could not download media preview.")
        return Path(result)


telegram = TelegramService()


class AppHandler(SimpleHTTPRequestHandler):
    def _basic_authorized(self):
        if not WEB_PASSWORD:
            return True
        scheme, _, token = self.headers.get("Authorization", "").partition(" ")
        if scheme.lower() != "basic" or not token:
            return False
        try:
            decoded = b64decode(token).decode("utf-8")
        except Exception:
            return False
        username, _, password = decoded.partition(":")
        return secrets.compare_digest(username, WEB_USERNAME) and secrets.compare_digest(password, WEB_PASSWORD)

    def _require_basic_auth(self):
        if self._basic_authorized():
            return True
        self.send_response(HTTPStatus.UNAUTHORIZED)
        self.send_header("WWW-Authenticate", 'Basic realm="Telegram Downloader"')
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.end_headers()
        self.wfile.write(b"Authentication required.")
        return False

    def _access_key_from_request(self, payload=None):
        parsed = urlparse(self.path)
        query_key = parse_qs(parsed.query).get("access_key", [""])[0]
        body_key = (payload or {}).get("access_key", "")
        return body_key or self.headers.get("X-Access-Key", "") or query_key

    def _require_access_key(self, payload=None):
        key = self._access_key_from_request(payload)
        mode = access_key_mode(key)
        if mode:
            return key, mode
        json_response(self, {"error": "Nhập access key hợp lệ để dùng chức năng này."}, HTTPStatus.UNAUTHORIZED)
        return None, None

    def _attach_access_key(self, media_items, key):
        encoded_key = quote(key, safe="")
        for item in media_items:
            item["thumbnail_url"] = f'{item["thumbnail_url"]}&access_key={encoded_key}'
            item["preview_url"] = f'{item["preview_url"]}&access_key={encoded_key}'

    def translate_path(self, path):
        parsed = urlparse(path)
        clean_path = parsed.path
        if clean_path == "/":
            return str(STATIC_DIR / "index.html")
        return str(STATIC_DIR / clean_path.lstrip("/"))

    def log_message(self, fmt, *args):
        print("%s - %s" % (self.address_string(), fmt % args))

    def do_GET(self):
        if not self._require_basic_auth():
            return
        parsed = urlparse(self.path)
        path = parsed.path
        try:
            if path == "/api/status":
                return json_response(self, telegram.status())
            if path == "/api/chats":
                _, mode = self._require_access_key()
                if not mode:
                    return
                return json_response(self, {"chats": telegram.list_chats(), "key_mode": mode})
            if path == "/api/media":
                key, mode = self._require_access_key()
                if not mode:
                    return
                qs = parse_qs(parsed.query)
                chat_id = qs.get("chat_id", [""])[0]
                limit = int(qs.get("limit", ["50"])[0])
                offset_id = int(qs.get("offset_id", ["0"])[0])
                result = telegram.list_media(chat_id, limit, offset_id)
                self._attach_access_key(result["items"], key)
                return json_response(self, {"media": result["items"], **result})
            if path == "/api/job":
                _, mode = self._require_access_key()
                if not mode:
                    return
                qs = parse_qs(parsed.query)
                return json_response(self, telegram.job_status(qs.get("id", [""])[0]))
            if path == "/api/thumbnail":
                _, mode = self._require_access_key()
                if not mode:
                    return
                qs = parse_qs(parsed.query)
                thumb_path = telegram.thumbnail_path(qs.get("chat_id", [""])[0], qs.get("message_id", [""])[0])
                return file_response(self, thumb_path)
            if path == "/api/preview":
                _, mode = self._require_access_key()
                if not mode:
                    return
                qs = parse_qs(parsed.query)
                preview_path = telegram.preview_path(qs.get("chat_id", [""])[0], qs.get("message_id", [""])[0])
                return file_response(self, preview_path)
            return super().do_GET()
        except Exception as exc:
            return json_response(self, {"error": str(exc)}, HTTPStatus.BAD_REQUEST)

    def do_HEAD(self):
        if not self._require_basic_auth():
            return
        return super().do_HEAD()

    def do_POST(self):
        if not self._require_basic_auth():
            return
        parsed = urlparse(self.path)
        try:
            payload = read_json(self)
            if parsed.path == "/api/login/start":
                return json_response(
                    self,
                    telegram.start_login(payload["api_id"], payload["api_hash"], payload["phone"]),
                )
            if parsed.path == "/api/login/code":
                return json_response(
                    self,
                    telegram.complete_code(payload.get("code", ""), payload.get("password") or None),
                )
            if parsed.path == "/api/key/check":
                _, mode = self._require_access_key(payload)
                if not mode:
                    return
                return json_response(self, {"valid": True, "key_mode": mode})
            if parsed.path == "/api/download":
                _, mode = self._require_access_key(payload)
                if not mode:
                    return
                message_ids = [int(item) for item in payload.get("message_ids", [])]
                if not message_ids:
                    raise RuntimeError("Select at least one photo or video.")
                if mode == "test" and len(message_ids) > 1:
                    raise RuntimeError("Key Test chỉ được tải 1 file. Hãy dùng key khác để tải nhiều file.")
                return json_response(self, telegram.download_selected(payload["chat_id"], message_ids))
            return json_response(self, {"error": "Not found"}, HTTPStatus.NOT_FOUND)
        except Exception as exc:
            return json_response(self, {"error": str(exc)}, HTTPStatus.BAD_REQUEST)


def main():
    mimetypes.add_type("application/javascript", ".js")
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    DOWNLOAD_DIR.mkdir(parents=True, exist_ok=True)
    THUMB_DIR.mkdir(parents=True, exist_ok=True)
    PREVIEW_DIR.mkdir(parents=True, exist_ok=True)
    server = ThreadingHTTPServer((HOST, PORT), AppHandler)
    print(f"Telegram downloader is running at http://{HOST}:{PORT}")
    if WEB_PASSWORD:
        print(f"Web login is enabled for username: {WEB_USERNAME}")
    else:
        print("Web login is disabled. Set WEB_PASSWORD before deploying publicly.")
    print(f"Downloads will be saved to {DOWNLOAD_DIR}")
    server.serve_forever()


if __name__ == "__main__":
    main()

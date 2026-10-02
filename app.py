#!/usr/bin/env python3
"""ClientBook HTTP service."""
import argparse
import json
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
import signal
import sqlite3
from urllib.parse import urlsplit

PRODUCT = "ClientBook"
RESOURCE = "clients"
PAGE = '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ClientBook · 客户联系人与商机记录</title><style>body{font-family:system-ui,sans-serif;max-width:52rem;margin:3rem auto;padding:0 1rem;line-height:1.7}a{color:#175b9c}</style><main><h1>ClientBook</h1><p>客户联系人与商机记录</p><h2>客户列表</h2><p>还没有客户记录。</p><p><a href="/api/clients">查看客户列表接口</a> · <a href="/health">服务状态</a></p></main></html>'


def main():
    parser = argparse.ArgumentParser(description="ClientBook - 客户联系人与商机记录")
    commands = parser.add_subparsers(dest="command", required=True)
    serve = commands.add_parser("serve", help="Start the HTTP service")
    serve.add_argument("--host", default="127.0.0.1", help="Address to bind (default: 127.0.0.1)")
    serve.add_argument("--port", type=int, default=8080, help="Port to bind; 0 selects an available port")
    serve.add_argument("--data-dir", type=Path, default=Path("data"), help="Directory for the local SQLite database")
    args = parser.parse_args()
    if not 0 <= args.port <= 65535:
        parser.error("port must be between 0 and 65535")
    args.data_dir.mkdir(parents=True, exist_ok=True)
    database = sqlite3.connect(args.data_dir / "client-book.sqlite")
    database.execute("CREATE TABLE IF NOT EXISTS clients (id INTEGER PRIMARY KEY, name TEXT NOT NULL)")
    database.commit()

    class Handler(BaseHTTPRequestHandler):
        def respond(self, status, value, *, html=False):
            payload = value.encode("utf8") if html else json.dumps(value, ensure_ascii=False).encode("utf8")
            self.send_response(status)
            self.send_header("Content-Type", "text/html; charset=utf-8" if html else "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(payload)))
            if status == 405:
                self.send_header("Allow", "GET")
            self.end_headers()
            self.wfile.write(payload)

        def route(self):
            location = urlsplit(self.path).path
            if location not in ("/", "/health", "/api/clients"):
                self.respond(404, {"error": "not found"})
                return
            if self.command != "GET":
                self.respond(405, {"error": "method not allowed"})
                return
            if location == "/":
                self.respond(200, PAGE, html=True)
            elif location == "/health":
                self.respond(200, {"status": "ok", "product": PRODUCT})
            else:
                records = [{"id": row[0], "name": row[1]} for row in database.execute("SELECT id, name FROM clients ORDER BY id")]
                self.respond(200, {RESOURCE: records})

        do_GET = do_POST = do_PUT = do_PATCH = do_DELETE = do_HEAD = do_OPTIONS = route

    def stop(_signal, _frame):
        raise KeyboardInterrupt

    signal.signal(signal.SIGTERM, stop)
    server = None
    try:
        server = HTTPServer((args.host, args.port), Handler)
        host, port = server.server_address[:2]
        address = f"[{host}]" if ":" in host else host
        print(f"{PRODUCT} listening on http://{address}:{port}", flush=True)
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        if server is not None:
            server.server_close()
        database.close()


if __name__ == "__main__":
    main()

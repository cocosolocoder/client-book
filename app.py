#!/usr/bin/env python3
"""ClientBook HTTP service."""
import argparse
import datetime
import json
import re
import signal
import sqlite3
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from urllib.parse import urlsplit

PRODUCT = "ClientBook"
RESOURCE = "clients"
OPTIONAL_FIELDS = ("source", "region", "industry", "important_date")
ALL_COLUMNS = ("name",) + OPTIONAL_FIELDS
MAX_BODY = 10 * 1024 * 1024
DATE_RE = re.compile(r"^(\d{4})-(\d{2})-(\d{2})$")

PAGE = '''<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>ClientBook · 客户联系人与商机记录</title>
<style>
body{font-family:system-ui,sans-serif;max-width:60rem;margin:3rem auto;padding:0 1rem;line-height:1.7;color:#1c2733}
a{color:#175b9c}
h1{margin-bottom:.2rem}
.subtitle{color:#5b6b7b;margin-top:0}
.card{border:1px solid #d8dee6;border-radius:8px;padding:1rem 1.25rem;margin:1.5rem 0}
.card h2{margin-top:0;font-size:1.15rem}
.filename{margin-left:.5rem;color:#5b6b7b}
button{font-size:1rem;padding:.45rem 1.4rem;border-radius:6px;border:1px solid #175b9c;background:#175b9c;color:#fff;cursor:pointer}
button:disabled{background:#9db6cc;border-color:#9db6cc;cursor:default}
.hint{color:#5b6b7b;font-size:.9rem;margin:.35rem 0 0}
#report{display:none;margin-top:1rem}
.banner{padding:.6rem 1rem;border-radius:6px;margin-bottom:.75rem}
.banner.ok{background:#e9f7ec;border:1px solid #bfe3c8}
.banner.bad{background:#fdeeee;border:1px solid #f3c4c4}
.failures{border:1px solid #ecd7d7;background:#fdf6f6;border-radius:6px;padding:.5rem 1rem;max-height:16rem;overflow:auto}
.failures b{color:#a02b2b}
.failures ul{margin:.4rem 0}
table{border-collapse:collapse;width:100%}
#clients-table{display:none}
#clients-table.on{display:table}
#clients-empty{display:none}
#clients-empty.on{display:block}
th,td{text-align:left;padding:.45rem .6rem;border-bottom:1px solid #e3e8ee;vertical-align:top}
th{font-size:.85rem;color:#5b6b7b;font-weight:600}
.muted{color:#9aa7b4}
.footer{color:#5b6b7b;font-size:.9rem;margin-top:2rem}
</style>
</head>
<body>
<main>
<h1>ClientBook</h1>
<p class="subtitle">客户联系人与商机记录</p>

<section class="card">
<h2>从 CSV 导入客户</h2>
<form id="import-form">
  <input type="file" id="file-input" accept=".csv,text/csv,text/plain" required>
  <span class="filename" id="filename"></span>
  <div style="margin-top:.75rem"><button type="submit" id="submit-btn">导入</button></div>
</form>
<p class="hint">表头须包含 name（必需），可选 source、region、industry、important_date，顺序不限；重要日期须为 YYYY-MM-DD 真实日期。支持带引号字段与字段内换行（UTF-8，可带 BOM）。</p>
<div id="report"></div>
</section>

<h2>客户列表</h2>
<p id="clients-empty" class="muted">还没有客户记录。</p>
<table id="clients-table">
  <thead><tr><th>编号</th><th>客户名称</th><th>来源</th><th>地区</th><th>行业</th><th>重要日期</th></tr></thead>
  <tbody id="clients-body"></tbody>
</table>

<p class="footer"><a href="/api/clients">查看客户列表接口</a> · <a href="/health">服务状态</a></p>
</main>
<script>
const ESC = {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"};
const esc = s => String(s === null || s === undefined ? "" : s).replace(/[&<>"']/g, c => ESC[c]);
const blank = v => (v === null || v === undefined || v === "") ? '<span class="muted">—</span>' : esc(v);

async function loadClients() {
  const res = await fetch("/api/clients");
  const data = await res.json();
  const rows = data.clients || [];
  const tbl = document.getElementById("clients-table");
  const empty = document.getElementById("clients-empty");
  const body = document.getElementById("clients-body");
  if (rows.length) {
    tbl.classList.add("on");
    empty.classList.remove("on");
    body.innerHTML = rows.map(r =>
      "<tr><td>" + esc(r.id) + "</td><td>" + esc(r.name) + "</td><td>" + blank(r.source) +
      "</td><td>" + blank(r.region) + "</td><td>" + blank(r.industry) +
      "</td><td>" + blank(r.important_date) + "</td></tr>").join("");
  } else {
    tbl.classList.remove("on");
    empty.classList.add("on");
    body.innerHTML = "";
  }
}

document.getElementById("file-input").addEventListener("change", e => {
  document.getElementById("filename").textContent = e.target.files[0] ? e.target.files[0].name : "";
});

function showReport(innerHTML, ok) {
  const report = document.getElementById("report");
  report.style.display = "block";
  report.innerHTML = innerHTML;
}

document.getElementById("import-form").addEventListener("submit", async e => {
  e.preventDefault();
  const input = document.getElementById("file-input");
  const file = input.files[0];
  const btn = document.getElementById("submit-btn");
  if (!file) {
    showReport('<div class="banner bad">请先选择 CSV 文件。</div>');
    return;
  }
  btn.disabled = true;
  try {
    const res = await fetch("/api/clients/import", {method: "POST", body: file});
    const data = await res.json();
    renderReport(data, res.status);
    if (res.ok && data.imported_count > 0) {
      await loadClients();
    }
  } catch (err) {
    showReport('<div class="banner bad">导入请求失败：' + esc(err.message) + '</div>');
  } finally {
    btn.disabled = false;
  }
});

function renderReport(data, status) {
  if (status === 400) {
    showReport('<div class="banner bad">整份文件已拒绝导入，客户列表保持原样。<br>原因：' +
      esc(data.error || "未知错误") + '</div>');
    return;
  }
  const failures = data.failures || [];
  let out = '<div class="banner ok">新增 <b>' + esc(data.imported_count) + '</b> 条，' +
    '未导入 <b>' + failures.length + '</b> 条。</div>';
  if (failures.length) {
    out += '<div class="failures"><p><b>未导入记录（编号按原文件数据记录，表头不计入）：</b></p><ul>';
    out += failures.map(f =>
      "<li>第 <b>" + esc(f.row) + "</b> 条：" + esc(f.reason) + "</li>").join("");
    out += "</ul></div>";
  }
  showReport(out);
}

loadClients();
</script>
</body>
</html>
'''


class FileError(Exception):
    """文件级错误：整份文件拒绝导入（HTTP 400）。"""


def parse_csv(text):
    """解析 RFC 4180 风格 CSV，返回 (header, data_rows)。

    支持引号包裹的字段、引号内逗号与换行、双引号转义；
    引号外支持 LF / CRLF / CR 换行。结构损坏时抛 FileError。
    """
    rows = []
    record = []
    field = []
    quoted = False
    started = False
    i = 0
    n = len(text)
    while i < n:
        c = text[i]
        if quoted:
            if c == '"':
                if i + 1 < n and text[i + 1] == '"':
                    field.append('"')
                    i += 2
                    continue
                quoted = False
                i += 1
                continue
            if c == "\r":
                # 统一字段内换行符为 LF
                if i + 1 < n and text[i + 1] == "\n":
                    i += 1
                field.append("\n")
                i += 1
                continue
            field.append(c)
            i += 1
            continue
        if c == '"' and not started:
            quoted = True
            started = True
        elif c == ",":
            record.append("".join(field))
            field = []
            started = False
        elif c in "\r\n":
            if c == "\r" and i + 1 < n and text[i + 1] == "\n":
                i += 1
            if not started and not record and not field:
                # 空白行：不作为数据记录（显式的 "" 空字段 started=True，仍会保留）
                i += 1
                continue
            record.append("".join(field))
            rows.append(record)
            record = []
            field = []
            started = False
        else:
            field.append(c)
            started = True
        i += 1
    if quoted:
        raise FileError("CSV 结构损坏：存在未闭合的引号")
    if started or field or record:
        record.append("".join(field))
        rows.append(record)
    if not rows:
        raise FileError("CSV 内容为空：缺少表头")
    return rows[0], rows[1:]


def check_date(value):
    """校验 YYYY-MM-DD 且为真实日历日期，返回 (是否合法, 错误原因)。"""
    match = DATE_RE.match(value)
    if not match:
        return False, "重要日期格式无效（%s）：须为 YYYY-MM-DD" % value
    try:
        datetime.date(int(match.group(1)), int(match.group(2)), int(match.group(3)))
    except ValueError:
        return False, "重要日期无效（%s）：不是真实日历日期" % value
    return True, None


def import_clients(database, text):
    """执行导入，返回响应字典；文件级错误抛 FileError。"""
    header, data_rows = parse_csv(text)
    headers = [h.strip() for h in header]

    seen = set()
    duplicates = []
    for h in headers:
        if h in seen and h not in duplicates:
            duplicates.append(h)
        seen.add(h)
    if duplicates:
        raise FileError("表头重复：%s" % "、".join(repr(h) for h in duplicates))
    unknown = [h for h in headers if h not in ALL_COLUMNS]
    if unknown:
        raise FileError("出现未知列：%s" % "、".join(repr(h) for h in unknown))
    if "name" not in headers:
        raise FileError("缺少名称列：表头必须包含 name 列")

    index = {h: i for i, h in enumerate(headers)}
    name_index = index["name"]
    date_index = index.get("important_date")

    existing = {}
    for cid, cname in database.execute("SELECT id, name FROM clients"):
        existing[(cname or "").strip().casefold()] = cid

    imported = []
    failures = []
    seen_in_file = {}

    for row_number, raw in enumerate(data_rows, start=1):
        if len(raw) != len(headers):
            failures.append({
                "row": row_number,
                "reason": "列数不符：表头有 %d 列，该记录有 %d 列" % (len(headers), len(raw)),
            })
            continue

        name = raw[name_index].strip()
        problems = []
        if not name:
            problems.append("缺少名称：name 列为空")
        date_value = ""
        if date_index is not None:
            date_value = raw[date_index].strip()
            if date_value:
                ok, reason = check_date(date_value)
                if not ok:
                    problems.append(reason)
        if problems:
            failures.append({"row": row_number, "reason": "；".join(problems)})
            continue

        key = name.casefold()
        if key in existing:
            failures.append({
                "row": row_number,
                "reason": "名称与已有客户重复（已有客户编号 %d），未更新" % existing[key],
            })
            continue
        if key in seen_in_file:
            failures.append({
                "row": row_number,
                "reason": "名称与文件内第 %d 条记录重复" % seen_in_file[key],
            })
            continue

        seen_in_file[key] = row_number
        record = {"name": name}
        for field_name in OPTIONAL_FIELDS:
            idx = index.get(field_name)
            value = raw[idx].strip() if idx is not None else ""
            record[field_name] = value or None
        imported.append((row_number, record))

    saved = []
    for row_number, record in imported:
        cursor = database.execute(
            "INSERT INTO clients (name, source, region, industry, important_date)"
            " VALUES (:name, :source, :region, :industry, :important_date)",
            record,
        )
        saved.append({"row": row_number, "id": cursor.lastrowid, "name": record["name"]})
    database.commit()

    return {
        "imported_count": len(saved),
        "failed_count": len(failures),
        "imported": saved,
        "failures": failures,
    }


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
    columns = {row[1] for row in database.execute("PRAGMA table_info(clients)")}
    for field_name in OPTIONAL_FIELDS:
        if field_name not in columns:
            database.execute("ALTER TABLE clients ADD COLUMN %s TEXT" % field_name)
    database.commit()

    class Handler(BaseHTTPRequestHandler):
        def respond(self, status, value, *, html=False, allow=None):
            payload = value.encode("utf8") if html else json.dumps(value, ensure_ascii=False).encode("utf8")
            self.send_response(status)
            self.send_header("Content-Type", "text/html; charset=utf-8" if html else "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(payload)))
            if status == 405:
                self.send_header("Allow", allow or "GET")
            self.end_headers()
            self.wfile.write(payload)

        def handle_import(self):
            try:
                length = int(self.headers.get("Content-Length") or 0)
            except ValueError:
                length = 0
            if length > MAX_BODY:
                self.respond(400, {"error": "文件过大：超过 %d 字节上限" % MAX_BODY})
                return
            raw_body = self.rfile.read(length) if length > 0 else b""
            try:
                text = raw_body.decode("utf-8-sig")
            except UnicodeDecodeError:
                self.respond(400, {"error": "编码错误：文件不是有效的 UTF-8 文本"})
                return
            try:
                result = import_clients(database, text)
            except FileError as exc:
                database.rollback()
                self.respond(400, {"error": str(exc)})
                return
            self.respond(200, result)

        def route(self):
            location = urlsplit(self.path).path
            if location not in ("/", "/health", "/api/clients", "/api/clients/import"):
                self.respond(404, {"error": "not found"})
                return
            if location == "/api/clients/import":
                if self.command != "POST":
                    self.respond(405, {"error": "method not allowed"}, allow="POST")
                    return
                self.handle_import()
                return
            if self.command != "GET":
                self.respond(405, {"error": "method not allowed"}, allow="GET")
                return
            if location == "/":
                self.respond(200, PAGE, html=True)
            elif location == "/health":
                self.respond(200, {"status": "ok", "product": PRODUCT})
            else:
                records = [
                    {
                        "id": row[0],
                        "name": row[1],
                        "source": row[2],
                        "region": row[3],
                        "industry": row[4],
                        "important_date": row[5],
                    }
                    for row in database.execute(
                        "SELECT id, name, source, region, industry, important_date FROM clients ORDER BY id"
                    )
                ]
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

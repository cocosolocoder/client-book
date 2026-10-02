#!/usr/bin/env python3
"""ClientBook HTTP service."""
import argparse
import csv
from datetime import datetime
import io
import json
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
import re
import signal
import sqlite3
from urllib.parse import urlsplit

PRODUCT = "ClientBook"
RESOURCE = "clients"
COLUMNS = ("name", "source", "region", "industry", "important_date")
COLUMN_SET = frozenset(COLUMNS)
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")

PAGE = """<!doctype html>
<html lang="zh-CN">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>ClientBook · 客户联系人与商机记录</title>
<style>
body{font-family:system-ui,sans-serif;max-width:52rem;margin:3rem auto;padding:0 1rem;line-height:1.7}
a{color:#175b9c}
table{border-collapse:collapse;width:100%;margin-top:1rem}
th,td{border:1px solid #ccc;padding:.4rem .6rem;text-align:left}
th{background:#f4f4f4}
form{margin:1rem 0}
input[type=file]{margin-right:.5rem}
#import-result{margin:1rem 0}
#import-result ul{margin:.5rem 0;padding-left:1.5rem}
.error{color:#b00020}
</style>
<main>
<h1>ClientBook</h1>
<p>客户联系人与商机记录</p>

<h2>导入客户</h2>
<form id="import-form">
  <input type="file" id="csv-file" accept=".csv,text/csv" required>
  <button type="submit">导入 CSV</button>
</form>
<div id="import-result"></div>

<h2>客户列表</h2>
<div id="client-list"><p>还没有客户记录。</p></div>

<p><a href="/api/clients">查看客户列表接口</a> · <a href="/health">服务状态</a></p>
</main>
<script>
function escapeHtml(s){
  return String(s).replace(/[&<>"']/g,function(c){
    return {'&':'&','<':'<','>':'>','"':'"',"'":'''}[c];
  });
}
async function loadClients(){
  try{
    var res=await fetch('/api/clients');
    var data=await res.json();
    var list=document.getElementById('client-list');
    if(!data.clients||data.clients.length===0){
      list.innerHTML='<p>还没有客户记录。</p>';
      return;
    }
    var html='<table><thead><tr><th>ID</th><th>名称</th><th>来源</th><th>地区</th><th>行业</th><th>重要日期</th></tr></thead><tbody>';
    for(var i=0;i<data.clients.length;i++){
      var c=data.clients[i];
      html+='<tr><td>'+c.id+'</td><td>'+escapeHtml(c.name)+'</td><td>'+escapeHtml(c.source||'')+'</td><td>'+escapeHtml(c.region||'')+'</td><td>'+escapeHtml(c.industry||'')+'</td><td>'+escapeHtml(c.important_date||'')+'</td></tr>';
    }
    html+='</tbody></table>';
    list.innerHTML=html;
  }catch(e){
    document.getElementById('client-list').innerHTML='<p class="error">加载客户列表失败。</p>';
  }
}
document.getElementById('import-form').addEventListener('submit',async function(e){
  e.preventDefault();
  var fileInput=document.getElementById('csv-file');
  var file=fileInput.files[0];
  if(!file){return;}
  var resultDiv=document.getElementById('import-result');
  resultDiv.innerHTML='<p>正在导入…</p>';
  try{
    var content=await file.text();
    var res=await fetch('/api/clients/import',{
      method:'POST',
      headers:{'Content-Type':'text/csv; charset=utf-8'},
      body:content
    });
    var data=await res.json();
    if(!res.ok){
      resultDiv.innerHTML='<p class="error">导入失败：'+escapeHtml(data.error||'未知错误')+'</p>';
      return;
    }
    var html='<p>新增 '+data.added+' 条，未导入 '+data.not_imported+' 条。</p>';
    if(data.records&&data.records.length){
      html+='<ul>';
      for(var i=0;i<data.records.length;i++){
        var r=data.records[i];
        if(r.status==='added'){
          html+='<li>第 '+r.record+' 条：已新增（客户 #'+r.id+' '+escapeHtml(r.name)+'）</li>';
        }else{
          html+='<li>第 '+r.record+' 条：'+escapeHtml(r.reason)+'</li>';
        }
      }
      html+='</ul>';
    }
    resultDiv.innerHTML=html;
    loadClients();
  }catch(err){
    resultDiv.innerHTML='<p class="error">导入失败：'+escapeHtml(err.message||'未知错误')+'</p>';
  }
});
loadClients();
</script>
</html>"""


def valid_date(value):
    if not DATE_RE.match(value):
        return False
    try:
        datetime.strptime(value, "%Y-%m-%d")
        return True
    except ValueError:
        return False


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
    database.execute(
        "CREATE TABLE IF NOT EXISTS clients ("
        "id INTEGER PRIMARY KEY, name TEXT NOT NULL, "
        "source TEXT DEFAULT '', region TEXT DEFAULT '', "
        "industry TEXT DEFAULT '', important_date TEXT DEFAULT '')"
    )
    existing_cols = {row[1] for row in database.execute("PRAGMA table_info(clients)")}
    for col in COLUMNS[1:]:
        if col not in existing_cols:
            database.execute(f"ALTER TABLE clients ADD COLUMN {col} TEXT DEFAULT ''")
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
                length = int(self.headers.get("Content-Length", 0))
            except (TypeError, ValueError):
                length = 0
            raw = self.rfile.read(length) if length > 0 else b""
            try:
                text = raw.decode("utf-8-sig")
            except UnicodeDecodeError:
                self.respond(400, {"error": "文件编码错误：无法以 UTF-8 解码"})
                return
            try:
                rows = [r for r in csv.reader(io.StringIO(text), strict=True) if r]
            except csv.Error as e:
                self.respond(400, {"error": f"CSV 结构损坏：{e}"})
                return
            if not rows:
                self.respond(400, {"error": "文件为空，缺少表头"})
                return
            header = rows[0]
            seen_headers = set()
            for col in header:
                if col in seen_headers:
                    self.respond(400, {"error": f"表头重复：{col} 出现多次"})
                    return
                seen_headers.add(col)
            for col in header:
                if col not in COLUMN_SET:
                    self.respond(400, {"error": f"出现未知列：{col}"})
                    return
            if "name" not in header:
                self.respond(400, {"error": "表头缺少 name 列"})
                return
            col_index = {col: i for i, col in enumerate(header)}

            existing = {}
            for row in database.execute("SELECT id, name FROM clients"):
                key = row[1].strip().lower()
                existing[key] = row[0]
            seen_in_file = {}
            results = []
            added = 0
            not_imported = 0

            for rec_no, row in enumerate(rows[1:], start=1):
                if len(row) != len(header):
                    results.append({
                        "record": rec_no, "status": "invalid",
                        "reason": f"第 {rec_no} 条记录：列数不符，表头 {len(header)} 列，记录 {len(row)} 列",
                    })
                    not_imported += 1
                    continue
                issues = []
                name = row[col_index["name"]].strip()
                if not name:
                    issues.append("名称为空")
                date_val = ""
                if "important_date" in col_index:
                    date_val = row[col_index["important_date"]].strip()
                    if date_val:
                        if not DATE_RE.match(date_val):
                            issues.append("重要日期格式无效，应为 YYYY-MM-DD")
                        else:
                            try:
                                datetime.strptime(date_val, "%Y-%m-%d")
                            except ValueError:
                                issues.append("重要日期不是真实日历日期")
                if issues:
                    results.append({
                        "record": rec_no, "status": "invalid",
                        "reason": f"第 {rec_no} 条记录：" + "；".join(issues),
                    })
                    not_imported += 1
                    continue
                key = name.lower()
                if key in existing:
                    results.append({
                        "record": rec_no, "status": "duplicate",
                        "reason": f"第 {rec_no} 条记录：与已有客户 #{existing[key]} 重复",
                        "name": name,
                    })
                    not_imported += 1
                    continue
                if key in seen_in_file:
                    results.append({
                        "record": rec_no, "status": "duplicate",
                        "reason": f"第 {rec_no} 条记录：与第 {seen_in_file[key]} 条记录重复",
                        "name": name,
                    })
                    not_imported += 1
                    continue
                source = row[col_index["source"]].strip() if "source" in col_index else ""
                region = row[col_index["region"]].strip() if "region" in col_index else ""
                industry = row[col_index["industry"]].strip() if "industry" in col_index else ""
                cursor = database.execute(
                    "INSERT INTO clients (name, source, region, industry, important_date) "
                    "VALUES (?, ?, ?, ?, ?)",
                    (name, source, region, industry, date_val),
                )
                database.commit()
                new_id = cursor.lastrowid
                seen_in_file[key] = rec_no
                results.append({"record": rec_no, "status": "added", "id": new_id, "name": name})
                added += 1

            self.respond(200, {"added": added, "not_imported": not_imported, "records": results})

        def route(self):
            location = urlsplit(self.path).path
            if location == "/api/clients/import":
                if self.command != "POST":
                    self.respond(405, {"error": "method not allowed"}, allow="POST")
                    return
                self.handle_import()
                return
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
                records = [
                    {
                        "id": row[0], "name": row[1],
                        "source": row[2] or "", "region": row[3] or "",
                        "industry": row[4] or "", "important_date": row[5] or "",
                    }
                    for row in database.execute(
                        "SELECT id, name, source, region, industry, important_date "
                        "FROM clients ORDER BY id"
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

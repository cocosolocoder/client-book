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
.banner.busy{background:#eef4fb;border:1px solid #c3d5e8}
.banner.warn{background:#fdf6e5;border:1px solid #ecd9a8}
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
#clients-body tr.selected{background:#f1f6fb}
.sel-panel{background:#f5f8fb;border:1px solid #d8dee6;border-radius:6px;padding:.6rem .8rem;margin:.8rem 0}
.sel-list{margin-top:.35rem}
.sel-chip{display:inline-block;background:#fff;border:1px solid #cdd7e2;border-radius:999px;padding:.1rem .35rem .1rem .6rem;margin:.2rem .35rem .2rem 0;font-size:.9rem;white-space:nowrap}
.sel-chip button{border:none;background:none;color:#5b6b7b;font-size:1.05rem;line-height:1;padding:0 .25rem;cursor:pointer}
.sel-chip button:hover{color:#a02b2b}
.bf{border:1px solid #d8dee6;border-radius:6px;padding:.55rem .8rem;margin:.6rem 0}
.bf-head{display:flex;flex-wrap:wrap;gap:.8rem;align-items:center;margin-bottom:.35rem}
.bf-head b{min-width:4.5rem}
.bf-head label{font-weight:400;white-space:nowrap}
.bf textarea{width:100%;box-sizing:border-box;font:inherit;resize:vertical;padding:.3rem .45rem}
.bf input[type=text]{font:inherit;padding:.3rem .45rem}
.bf textarea:disabled,.bf input:disabled{background:#f2f4f7;color:#8a97a5}
.bf .val-hint{margin:.25rem 0 0;font-size:.85rem;color:#5b6b7b}
#batch-report{margin-top:.75rem}
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
  <thead><tr><th style="width:2.2rem"><input type="checkbox" id="check-all" title="全选/取消全选当前列表"></th><th>编号</th><th>客户名称</th><th>来源</th><th>地区</th><th>行业</th><th>重要日期</th></tr></thead>
  <tbody id="clients-body"></tbody>
</table>

<section class="card" id="batch-card">
<h2>批量修改选中客户</h2>
<div class="sel-panel">
  已选择 <b id="sel-count">0</b> 名客户：
  <div class="sel-list" id="sel-list"><span class="muted" id="sel-none">尚未勾选任何客户，勾选列表中的客户后可批量修改。</span></div>
</div>
<form id="batch-form">
  <div id="batch-fields"></div>
  <p class="hint">每个字段可分别选择「保持原值」「设为填写的值」或「清空」；初次进入编辑时全部保持原值，留空不会清空资料。来源、地区和行业保留内部空白与换行，仅含空白的填写值按清空处理；重要日期须为 YYYY-MM-DD 真实日历日期。客户名称和编号不参与编辑，也不会新建客户。</p>
  <div style="margin-top:.6rem">
    <button type="submit" id="batch-submit" disabled>保存修改</button>
  </div>
</form>
<div id="batch-report"></div>
</section>

<p class="footer"><a href="/api/clients">查看客户列表接口</a> · <a href="/health">服务状态</a></p>
</main>
<script>
const ESC = {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"};
const esc = s => String(s === null || s === undefined ? "" : s).replace(/[&<>"']/g, c => ESC[c]);
const blank = v => (v === null || v === undefined || v === "") ? '<span class="muted">—</span>' : esc(v);

const BATCH_FIELDS = [
  {key: "source", label: "来源"},
  {key: "region", label: "地区"},
  {key: "industry", label: "行业"},
  {key: "important_date", label: "重要日期", date: true},
];

let clients = [];
const selected = new Set();
// 一次批量保存从发出到本次结果处理结束期间为 true：期间只能有这一次请求，
// 勾选变化与表单重复提交都不能解除或新增请求。
let batchSaving = false;

function syncSubmitState() {
  const btn = document.getElementById("batch-submit");
  btn.disabled = batchSaving || selected.size === 0;
  btn.textContent = batchSaving ? "正在保存…" : "保存修改";
}

// 读取客户列表。任何失败（连接错误、非成功状态、响应无法解析或
// 未包含有效客户列表）都抛异常，且绝不改动当前已显示的客户数据：
// 错误响应即使是可解析的 JSON，也不能当作空客户列表处理。
async function loadClients() {
  const res = await fetch("/api/clients");
  if (!res.ok) throw new Error("服务返回状态 " + res.status);
  const data = await res.json();
  if (!data || !Array.isArray(data.clients)) {
    throw new Error("响应中未包含有效的客户列表");
  }
  clients = data.clients;
  const known = new Set(clients.map(r => r.id));
  for (const id of [...selected]) {
    if (!known.has(id)) selected.delete(id);
  }
  renderClients();
  renderSelection();
}

function renderClients() {
  const tbl = document.getElementById("clients-table");
  const empty = document.getElementById("clients-empty");
  const body = document.getElementById("clients-body");
  if (clients.length) {
    tbl.classList.add("on");
    empty.classList.remove("on");
    body.innerHTML = clients.map(r =>
      '<tr data-id="' + esc(r.id) + '"' + (selected.has(r.id) ? ' class="selected"' : "") + ">" +
      '<td><input type="checkbox" class="row-check" value="' + esc(r.id) + '"' +
      (selected.has(r.id) ? " checked" : "") + " aria-label='选择客户 " + esc(r.id) + "'></td>" +
      "<td>" + esc(r.id) + "</td><td>" + esc(r.name) + "</td><td>" + blank(r.source) +
      "</td><td>" + blank(r.region) + "</td><td>" + blank(r.industry) +
      "</td><td>" + blank(r.important_date) + "</td></tr>").join("");
  } else {
    tbl.classList.remove("on");
    empty.classList.add("on");
    body.innerHTML = "";
  }
  syncCheckAll();
}

function syncCheckAll() {
  const box = document.getElementById("check-all");
  box.checked = clients.length > 0 && selected.size === clients.length;
  box.indeterminate = selected.size > 0 && selected.size < clients.length;
}

function renderSelection() {
  document.getElementById("sel-count").textContent = String(selected.size);
  const list = document.getElementById("sel-list");
  if (!selected.size) {
    list.innerHTML = '<span class="muted">尚未勾选任何客户，勾选列表中的客户后可批量修改。</span>';
  } else {
    const byId = new Map(clients.map(r => [r.id, r]));
    list.innerHTML = [...selected].sort((a, b) => a - b).map(id => {
      const r = byId.get(id);
      return '<span class="sel-chip">#' + esc(id) + " " + esc(r ? r.name : "") +
        ' <button type="button" data-remove="' + esc(id) + '" title="取消勾选该客户">×</button></span>';
    }).join("");
  }
  syncSubmitState();
  document.querySelectorAll("#clients-body tr").forEach(tr => {
    tr.classList.toggle("selected", selected.has(Number(tr.dataset.id)));
  });
  syncCheckAll();
}

function buildBatchFields() {
  const wrap = document.getElementById("batch-fields");
  wrap.innerHTML = BATCH_FIELDS.map(f =>
    '<div class="bf" data-field="' + f.key + '">' +
      '<div class="bf-head"><b>' + f.label + "</b>" +
        '<label><input type="radio" name="' + f.key + '-op" value="keep" checked> 保持原值</label>' +
        '<label><input type="radio" name="' + f.key + '-op" value="set"> 设为填写的值</label>' +
        '<label><input type="radio" name="' + f.key + '-op" value="clear"> 清空</label>' +
      "</div>" +
      (f.date
        ? '<input type="text" class="bf-value" disabled placeholder="YYYY-MM-DD" autocomplete="off">'
        : '<textarea class="bf-value" rows="2" disabled></textarea>') +
      '<p class="val-hint">' + (f.date
        ? "非空时须为 YYYY-MM-DD 真实日历日期；仅含空白的填写值按清空处理。"
        : "去除前后空白后保存，内部空白与换行保留；仅含空白的填写值按清空处理。") +
      "</p></div>").join("");
  wrap.querySelectorAll(".bf").forEach(card => {
    const input = card.querySelector(".bf-value");
    card.querySelectorAll('input[type=radio]').forEach(radio => radio.addEventListener("change", () => {
      const op = card.querySelector('input[type=radio]:checked').value;
      input.disabled = op !== "set";
      if (op === "set") input.focus();
    }));
  });
}

function collectBatchPayload() {
  const updates = {};
  for (const card of document.querySelectorAll("#batch-fields .bf")) {
    const key = card.dataset.field;
    const op = card.querySelector('input[type=radio]:checked').value;
    if (op === "keep") {
      updates[key] = {op: "keep"};
    } else if (op === "clear") {
      updates[key] = {op: "clear"};
    } else {
      updates[key] = {op: "set", value: card.querySelector(".bf-value").value};
    }
  }
  return {ids: [...selected].sort((a, b) => a - b), updates};
}

function resetBatchForm() {
  document.querySelectorAll("#batch-fields .bf").forEach(card => {
    card.querySelector('input[value=keep]').checked = true;
    const input = card.querySelector(".bf-value");
    input.value = "";
    input.disabled = true;
  });
}

function showBatchReport(html) {
  document.getElementById("batch-report").innerHTML = html;
}

document.getElementById("check-all").addEventListener("change", e => {
  if (e.target.checked) clients.forEach(r => selected.add(r.id));
  else selected.clear();
  renderClients();
  renderSelection();
});

document.getElementById("clients-body").addEventListener("change", e => {
  if (!e.target.classList.contains("row-check")) return;
  const id = Number(e.target.value);
  if (e.target.checked) selected.add(id);
  else selected.delete(id);
  renderSelection();
});

document.getElementById("sel-list").addEventListener("click", e => {
  const btn = e.target.closest("[data-remove]");
  if (!btn) return;
  selected.delete(Number(btn.dataset.remove));
  renderClients();
  renderSelection();
});

document.getElementById("batch-form").addEventListener("submit", async e => {
  e.preventDefault();
  // 等待结果期间再次提交（重复点击、回车等）一律忽略：不增加请求、不提前显示成功、
  // 不清除已填内容；等待期间的勾选变化也不会在结果返回后自动补交。
  if (batchSaving) return;
  if (!selected.size) {
    showBatchReport('<div class="banner bad">请先勾选至少一名客户。</div>');
    syncSubmitState();
    return;
  }
  // 以本次点击时的勾选与填写为准，固化请求内容；等待期间勾选变化不影响本次请求。
  const payload = collectBatchPayload();
  batchSaving = true;
  syncSubmitState();
  showBatchReport('<div class="banner busy">正在保存本次批量修改，请勿重复提交…</div>');
  // 第一阶段：等待保存接口的明确答复。只有收到成功状态及处理数量，
  // 才允许进入成功流程；其余一律按失败或拒绝展示，绝不提前宣称已保存。
  let count = null;
  try {
    const res = await fetch("/api/clients/batch-update", {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify(payload),
    });
    let data = null;
    try { data = await res.json(); } catch (parseErr) { data = null; }
    if (!res.ok) {
      // 服务明确拒绝：显示具体原因，保留当时页面上的勾选、字段操作及填写内容，
      // 由用户修正后主动再次保存。
      showBatchReport('<div class="banner bad">本次修改已全部拒绝，客户资料保持原样。<br>原因：' +
        esc((data && data.error) || "未知错误") + "</div>");
      return;
    }
    if (!data || typeof data.updated_count !== "number") {
      // 成功状态但回复无法识别：没有明确的保存成功答复，不能按已保存处理。
      showBatchReport('<div class="banner bad">批量修改请求失败：服务回复无法识别，' +
        "本次修改结果未知，请刷新客户列表核对后再决定是否需要重新保存。</div>");
      return;
    }
    count = data.updated_count;
  } catch (err) {
    // 请求失败也要结束等待并显示失败，不能使页面一直无法继续使用。
    showBatchReport('<div class="banner bad">批量修改请求失败：' + esc(err.message) + "</div>");
    return;
  } finally {
    // 等待结束：是否能保存仍取决于有没有选中客户（成功后已清除勾选）。
    batchSaving = false;
    syncSubmitState();
  }
  // 第二阶段：保存已明确成功（数量以保存回复为准，不按旧表格、勾选或刷新结果推算）。
  // 清除本次勾选、字段编辑恢复为保持原值，旧表格上的勾选状态同步清除。
  resetBatchForm();
  selected.clear();
  renderClients();
  renderSelection();
  // 随后尝试刷新列表。刷新失败不影响已保存的结果：保留成功提示，
  // 另行告知列表暂未更新；已显示的客户资料保持原样，不清空表格。
  try {
    await loadClients();
    showBatchReport('<div class="banner ok">已成功处理 <b>' + esc(count) +
      "</b> 名客户，列表已刷新为最新资料，勾选已清除。</div>");
  } catch (err) {
    showBatchReport('<div class="banner ok">已成功处理 <b>' + esc(count) +
      "</b> 名客户，勾选已清除。</div>" +
      '<div class="banner warn">客户列表暂未更新（' + esc(err.message) +
      "）：当前显示的资料可能仍是保存前的内容，这不影响已保存的修改，请稍后刷新查看，无需再次保存。</div>");
  }
});

buildBatchFields();

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
    if (res.ok) {
      // 导入已成功；列表刷新失败不影响导入结果，也不把导入报告改成失败。
      try { await loadClients(); } catch (refreshErr) { /* 保留当前列表，稍后可手动刷新 */ }
    }
  } catch (err) {
    showReport('<div class="banner bad">导入请求失败：' + esc(err.message) + '</div>');
  } finally {
    btn.disabled = false;
  }
});

function renderReport(data, status) {
  if (status === 400) {
    showReport('<div class="banner bad">整份文件已拒绝导入，本次没有新增客户，原有客户资料保持原样。<br>原因：' +
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

// 首次加载失败时保留空列表提示区域原状，稍后刷新页面重试即可。
loadClients().catch(() => {});
</script>
</body>
</html>
'''


class FileError(Exception):
    """文件级错误：整份文件拒绝导入（HTTP 400）。"""


class BatchUpdateError(Exception):
    """批量修改请求级错误：整次修改拒绝（HTTP 400）。"""


FIELD_LABELS = {
    "source": "来源",
    "region": "地区",
    "industry": "行业",
    "important_date": "重要日期",
}


def _normalize_set_value(field_name, value):
    """校验 set 操作的值并返回最终入库值；非法时抛 BatchUpdateError。

    去除前后空白；仅含空白按清空（None）处理；来源/地区/行业保留内部空白与换行；
    重要日期非空时须为 YYYY-MM-DD 真实日历日期。
    """
    if not isinstance(value, str):
        raise BatchUpdateError("%s的设置值不是文本" % FIELD_LABELS[field_name])
    text = value.strip()
    if not text:
        return None
    if field_name == "important_date":
        ok, reason = check_date(text)
        if not ok:
            raise BatchUpdateError(reason)
    return text


def batch_update_clients(database, payload):
    """执行批量修改，返回 {"updated_count": 去重后的客户数}；非法请求抛 BatchUpdateError。

    任一问题都整次拒绝，不写入任何客户。
    """
    if not isinstance(payload, dict):
        raise BatchUpdateError("请求体必须是 JSON 对象")

    raw_ids = payload.get("ids")
    if not isinstance(raw_ids, list):
        raise BatchUpdateError("ids 必须是客户编号数组")
    if not raw_ids:
        raise BatchUpdateError("未选择客户：请先勾选至少一名客户")

    ids = []
    seen_ids = set()
    for raw_id in raw_ids:
        if isinstance(raw_id, bool) or not isinstance(raw_id, int) or raw_id <= 0:
            raise BatchUpdateError("客户编号必须是正整数：%r 不合法" % (raw_id,))
        if raw_id not in seen_ids:
            seen_ids.add(raw_id)
            ids.append(raw_id)

    raw_updates = payload.get("updates", {})
    if not isinstance(raw_updates, dict):
        raise BatchUpdateError("updates 必须是字段修改说明对象")
    extra = [key for key in raw_updates if key not in OPTIONAL_FIELDS]
    if extra:
        raise BatchUpdateError("包含不能修改或不存在的字段：%s" % "、".join(extra))

    actions = {}
    for field_name in OPTIONAL_FIELDS:
        spec = raw_updates.get(field_name, {"op": "keep"})
        if not isinstance(spec, dict):
            raise BatchUpdateError("%s的修改说明必须是对象" % FIELD_LABELS[field_name])
        op = spec.get("op")
        if op not in ("keep", "set", "clear"):
            raise BatchUpdateError(
                "%s的操作必须是 keep、set 或 clear 之一" % FIELD_LABELS[field_name])
        if op == "keep":
            continue
        if op == "clear":
            actions[field_name] = None
        else:
            actions[field_name] = _normalize_set_value(field_name, spec.get("value"))

    if not actions:
        raise BatchUpdateError("全部字段均保持原值：请至少选择一个字段进行设置或清空")

    placeholders = ",".join("?" for _ in ids)
    existing = {
        row[0]
        for row in database.execute(
            "SELECT id FROM clients WHERE id IN (%s)" % placeholders, ids
        )
    }
    missing = [cid for cid in ids if cid not in existing]
    if missing:
        raise BatchUpdateError("找不到对应客户，编号：%s" % "、".join(str(c) for c in missing))

    assignments = ", ".join("%s = ?" % field_name for field_name in actions)
    params = list(actions.values()) + ids
    try:
        database.execute(
            "UPDATE clients SET %s WHERE id IN (%s)" % (assignments, placeholders), params
        )
        database.commit()
    except sqlite3.DatabaseError:
        database.rollback()
        raise BatchUpdateError("保存失败：数据库错误，本次修改未生效")

    return {"updated_count": len(ids)}


def parse_csv(text):
    """解析 RFC 4180 风格 CSV，返回 (header, data_rows)。

    支持引号包裹的字段、引号内逗号与换行、双引号转义；
    引号外支持 LF / CRLF / CR 换行。结构损坏时抛 FileError：
    - 未加引号的字段中出现双引号（双引号只能在字段开头用于包住整个字段）；
    - 结束引号后出现逗号、换行或文件结束以外的字符（含空格）；
    - 文件结束时仍有字段处于引号内（引号未闭合）。
    错误信息区分上述三种情况，并指出发生在表头还是第 N 条数据记录
    （数据记录编号不包含表头，引号字段内的换行不增加编号）。
    """
    rows = []
    record = []
    field = []
    quoted = False        # 当前字段处于引号内
    started = False       # 当前字段已经开始（已有内容或已进入引号）
    closed = False       # 引号字段刚结束，等待逗号 / 换行 / 文件结束
    record_number = 0     # 0 = 表头，1 起为数据记录
    i = 0
    n = len(text)

    def location():
        return "表头" if record_number == 0 else "第 %d 条数据记录" % record_number

    def structure_error(kind):
        raise FileError("CSV 结构损坏（%s）：%s" % (location(), kind))

    def finish_record():
        nonlocal record, field, started, closed
        record.append("".join(field))
        rows.append(record)
        record = []
        field = []
        started = False
        closed = False

    while i < n:
        c = text[i]
        if quoted:
            if c == '"':
                if i + 1 < n and text[i + 1] == '"':
                    field.append('"')
                    i += 2
                    continue
                quoted = False
                closed = True
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
        if closed:
            # 引号已结束，只允许逗号、记录换行或文件结束
            if c == ",":
                record.append("".join(field))
                field = []
                started = False
                closed = False
            elif c in "\r\n":
                if c == "\r" and i + 1 < n and text[i + 1] == "\n":
                    i += 1
                finish_record()
                record_number += 1
            else:
                structure_error("结束引号后有多余字符，结束引号后只能紧接逗号、记录换行或文件结束")
            i += 1
            continue
        if c == '"' and not started:
            quoted = True
            started = True
        elif c == '"':
            structure_error("未加引号的字段中出现双引号，双引号只能在字段开头用于包住整个字段")
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
            finish_record()
            record_number += 1
        else:
            field.append(c)
            started = True
        i += 1
    if quoted:
        structure_error("引号未闭合，文件结束时仍有字段处于引号内")
    if started or field or record or closed:
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

        def handle_batch_update(self):
            try:
                length = int(self.headers.get("Content-Length") or 0)
            except ValueError:
                length = 0
            if length > MAX_BODY:
                self.respond(400, {"error": "请求体过大：超过 %d 字节上限" % MAX_BODY})
                return
            raw_body = self.rfile.read(length) if length > 0 else b""
            try:
                payload = json.loads(raw_body.decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError):
                self.respond(400, {"error": "请求体不是有效的 UTF-8 JSON 对象"})
                return
            try:
                result = batch_update_clients(database, payload)
            except BatchUpdateError as exc:
                database.rollback()
                self.respond(400, {"error": str(exc)})
                return
            self.respond(200, result)

        def route(self):
            location = urlsplit(self.path).path
            if location not in (
                "/", "/health", "/api/clients",
                "/api/clients/import", "/api/clients/batch-update",
            ):
                self.respond(404, {"error": "not found"})
                return
            if location == "/api/clients/import":
                if self.command != "POST":
                    self.respond(405, {"error": "method not allowed"}, allow="POST")
                    return
                self.handle_import()
                return
            if location == "/api/clients/batch-update":
                if self.command != "POST":
                    self.respond(405, {"error": "method not allowed"}, allow="POST")
                    return
                self.handle_batch_update()
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

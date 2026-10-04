#!/usr/bin/env node
/**
 * 页面层面的批量保存结果处理回归测试。
 *
 * 零外部依赖：用 Node 标准库启动真实的 app.py HTTP 服务，并通过 CDP（Chrome
 * DevTools Protocol）驱动本机无头 Chrome 打开真实首页进行操作；列表读取失败、
 * 非成功状态、无法解析、缺少 clients 数组等故障全部用 CDP Fetch 域在浏览器侧
 * 注入，不修改 app.py、也不改变任何接口的公开行为。
 *
 * 运行：node page_batch_save_test.mjs
 * 需要本机可用的 google-chrome（也可用环境变量 CHROME_BIN 指定可执行文件）。
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const ROOT = path.dirname(new URL(import.meta.url).pathname);
const CHROME_BIN = process.env.CHROME_BIN || "google-chrome";
const sleep = ms => new Promise(r => setTimeout(r, ms));
const norm = s => String(s || "").replace(/\s+/g, " ").trim();

let failed = 0;
const failureNames = [];
function check(name, cond, extra) {
  const tag = cond ? "PASS" : "FAIL";
  console.log(`${tag}  ${name}${cond ? "" : "    → " + JSON.stringify(extra)}`);
  if (!cond) { failed++; failureNames.push(name); }
}

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function startServer(dataDir) {
  const proc = spawn("python3", [
    path.join(ROOT, "app.py"), "serve",
    "--host", "127.0.0.1", "--port", "0", "--data-dir", dataDir,
  ], { stdio: ["ignore", "pipe", "pipe"] });
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) { settled = true; reject(new Error("等待服务启动超时")); }
    }, 8000);
    proc.stdout.on("data", d => {
      const m = String(d).match(/http:\/\/127\.0\.0\.1:(\d+)/);
      if (m && !settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ proc, base: `http://127.0.0.1:${m[1]}` });
      }
    });
    proc.on("exit", code => {
      if (!settled) { settled = true; reject(new Error("服务提前退出，code=" + code)); }
    });
  });
}

async function waitHealthy(base, deadlineMs = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < deadlineMs) {
    try {
      const r = await fetch(base + "/health");
      if (r.ok) return;
    } catch { /* 重试 */ }
    await sleep(80);
  }
  throw new Error("服务健康检查失败：" + base);
}

async function importCsv(base, content) {
  const r = await fetch(base + "/api/clients/import", { method: "POST", body: content });
  return { status: r.status, body: await r.json() };
}

async function getClients(base) {
  const r = await fetch(base + "/api/clients");
  if (!r.ok) throw new Error("GET /api/clients 状态 " + r.status);
  return (await r.json()).clients;
}

// ---------------------------------------------------------------- CDP 封装

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.handlers = new Map();
    ws.onmessage = e => {
      const msg = JSON.parse(e.data);
      if (msg.id && this.pending.has(msg.id)) {
        this.pending.get(msg.id)(msg);
        this.pending.delete(msg.id);
      } else if (msg.method) {
        for (const h of this.handlers.get(msg.method) || []) h(msg.params);
      }
    };
  }
  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, m => {
        if (m.error) reject(new Error(method + ": " + JSON.stringify(m.error)));
        else resolve(m.result);
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  on(method, handler) {
    if (!this.handlers.has(method)) this.handlers.set(method, []);
    this.handlers.get(method).push(handler);
  }
}

async function launchChrome() {
  const profile = makeTempDir("clientbook-chrome-");
  const proc = spawn(CHROME_BIN, [
    "--headless=new",
    "--no-sandbox",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    "about:blank",
  ], { stdio: ["ignore", "pipe", "pipe"] });

  let wsLine = null;
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("等待 Chrome DevTools 端口超时")), 10000);
    proc.stderr.on("data", d => {
      const m = String(d).match(/DevTools listening on (ws:\/\/\S+)/);
      if (m && !wsLine) { wsLine = m[1]; clearTimeout(timer); resolve(); }
    });
    proc.on("exit", code => {
      clearTimeout(timer);
      reject(new Error("Chrome 提前退出，code=" + code));
    });
  });
  await ready;

  const httpBase = wsLine.replace(/^ws/, "http").replace(/\/devtools\/.*$/, "");
  for (let i = 0; i < 50; i++) {
    try {
      const targets = await (await fetch(httpBase + "/json/list")).json();
      const page = targets.find(t => t.type === "page");
      if (page) {
        const ws = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise(r => { ws.onopen = r; });
        const cdp = new CDP(ws);
        await cdp.send("Page.enable");
        await cdp.send("Runtime.enable");
        return { proc, profile, cdp };
      }
    } catch { /* 重试 */ }
    await sleep(80);
  }
  proc.kill();
  throw new Error("无法连接到 Chrome 页面目标");
}

// 注入到每个页面文档的测试操作工具（只在测试浏览器内存在，不修改 app.py）。
const PAGE_HELPERS = `
(() => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  window.T = {
    sleep,
    async waitLoaded(timeoutMs = 8000) {
      const t0 = Date.now();
      while (Date.now() - t0 < timeoutMs) {
        const tbl = document.getElementById("clients-table").classList.contains("on");
        const empty = document.getElementById("clients-empty").classList.contains("on");
        const err = document.getElementById("clients-load-error").classList.contains("on");
        if (tbl || empty || err) return true;
        await sleep(30);
      }
      return false;
    },
    async waitDone(timeoutMs = 6000) {
      const t0 = Date.now();
      while (Date.now() - t0 < timeoutMs) {
        const btn = document.getElementById("batch-submit");
        const busy = document.querySelector("#batch-report .banner.busy");
        if (btn.textContent !== "正在保存…" && !busy) return true;
        await sleep(30);
      }
      return false;
    },
    async selectRows(ids) {
      for (const id of ids) {
        const cb = document.querySelector('.row-check[value="' + id + '"]');
        if (!cb) throw new Error("找不到客户勾选框：" + id);
        if (!cb.checked) {
          cb.checked = true;
          cb.dispatchEvent(new Event("change", { bubbles: true }));
        }
      }
    },
    // specs: {source: {op:"set", value:"..."}, industry: {op:"clear"}, ...}
    // 未给出的字段一律恢复为“保持原值”，便于每个用例从相同基线开始。
    async fillForm(specs) {
      specs = specs || {};
      for (const card of document.querySelectorAll("#batch-fields .bf")) {
        const spec = specs[card.dataset.field] || { op: "keep" };
        const radio = card.querySelector('input[type=radio][value="' + spec.op + '"]');
        radio.checked = true;
        radio.dispatchEvent(new Event("change", { bubbles: true }));
        const input = card.querySelector(".bf-value");
        input.value = spec.op === "set" ? (spec.value || "") : "";
      }
    },
    clickSave() {
      document.getElementById("batch-form")
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    },
    state() {
      const q = s => document.querySelector(s);
      const rows = [...document.querySelectorAll("#clients-body tr")].map(tr => ({
        id: Number(tr.dataset.id),
        selected: tr.classList.contains("selected"),
        checked: tr.querySelector(".row-check").checked,
        name: tr.children[2].textContent,
        source: tr.children[3].textContent.trim(),
        region: tr.children[4].textContent.trim(),
        industry: tr.children[5].textContent.trim(),
        importantDate: tr.children[6].textContent.trim(),
      }));
      return {
        tableOn: q("#clients-table").classList.contains("on"),
        emptyOn: q("#clients-empty").classList.contains("on"),
        loadErrorOn: q("#clients-load-error").classList.contains("on"),
        loadErrorText: norm(q("#clients-load-error").textContent),
        selCount: Number(q("#sel-count").textContent),
        chipCount: document.querySelectorAll("#sel-list .sel-chip").length,
        chipsText: norm(q("#sel-list").textContent),
        submitDisabled: q("#batch-submit").disabled,
        submitText: q("#batch-submit").textContent,
        checkAllChecked: q("#check-all").checked,
        reportText: norm(q("#batch-report").textContent),
        reportHasOk: !!q("#batch-report .banner.ok"),
        reportHasWarn: !!q("#batch-report .banner.warn"),
        reportHasBad: !!q("#batch-report .banner.bad"),
        fields: [...document.querySelectorAll("#batch-fields .bf")].map(card => ({
          field: card.dataset.field,
          op: card.querySelector('input[type=radio]:checked').value,
          value: card.querySelector(".bf-value").value,
          inputDisabled: card.querySelector(".bf-value").disabled,
        })),
        rows,
      };
      function norm(s) { return String(s || "").replace(/\\s+/g, " ").trim(); }
    },
  };
})();
`;

// 故障规则：每个来源（origin）独立配置
// listMode: pass | fail | http500 | badjson | noclients | sparse
// saveMode: pass | http400
function installFaultRules(cdp) {
  const rules = new Map();
  const ruleFor = origin => {
    if (!rules.has(origin)) {
      rules.set(origin, {
        listMode: "pass", saveMode: "pass", saveError: "",
        counts: { list: 0, save: 0 }, lastSaveBody: "",
      });
    }
    return rules.get(origin);
  };

  const fulfill = async (p, status, body, contentType = "application/json") => {
    await cdp.send("Fetch.fulfillRequest", {
      requestId: p.requestId,
      responseCode: status,
      responseHeaders: [{ name: "Content-Type", value: contentType + "; charset=utf-8" }],
      body: Buffer.from(body, "utf8").toString("base64"),
    });
  };

  cdp.on("Fetch.requestPaused", async p => {
    try {
      const u = new URL(p.request.url);
      if (u.pathname !== "/api/clients" && u.pathname !== "/api/clients/batch-update") {
        await cdp.send("Fetch.continueRequest", { requestId: p.requestId });
        return;
      }
      const rule = ruleFor(u.origin);
      if (p.request.method === "POST" && u.pathname === "/api/clients/batch-update") {
        rule.counts.save++;
        rule.lastSaveBody = p.request.postData || "";
        if (rule.saveMode === "http400") {
          await fulfill(p, 400, JSON.stringify({ error: rule.saveError }));
          return;
        }
        await cdp.send("Fetch.continueRequest", { requestId: p.requestId });
        return;
      }
      if (p.request.method === "GET" && u.pathname === "/api/clients") {
        rule.counts.list++;
        switch (rule.listMode) {
          case "fail":
            await cdp.send("Fetch.failRequest", { requestId: p.requestId, errorReason: "Failed" });
            return;
          case "http500":
            await fulfill(p, 500, JSON.stringify({ error: "服务器内部错误（测试注入）" }));
            return;
          case "badjson":
            await fulfill(p, 200, "这不是有效JSON { [", "text/plain");
            return;
          case "noclients":
            await fulfill(p, 200, JSON.stringify({ status: "ok", note: "缺少 clients 数组（测试注入）" }));
            return;
          case "sparse":
            await fulfill(p, 200, JSON.stringify({ clients: [{
              id: 999, name: "刷新返回列表中的假客户",
              source: "假来源", region: "假地区", industry: "假行业", important_date: null,
            }] }));
            return;
          default:
            await cdp.send("Fetch.continueRequest", { requestId: p.requestId });
        }
      } else {
        await cdp.send("Fetch.continueRequest", { requestId: p.requestId });
      }
    } catch (err) {
      // 避免暂停的请求无人处理导致页面挂起
      try {
        await cdp.send("Fetch.continueRequest", { requestId: p.requestId });
      } catch { /* 已处理 */ }
      console.error("故障注入处理异常：", err.message);
    }
  });

  cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] });
  return ruleFor;
}

// ---------------------------------------------------------------- 主流程

async function main() {
  const dataDir1 = makeTempDir("clientbook-data1-");
  const dataDir2 = makeTempDir("clientbook-data2-");
  let server1, server2, chrome;
  try {
    server1 = await startServer(dataDir1);
    server2 = await startServer(dataDir2);
    await waitHealthy(server1.base);
    await waitHealthy(server2.base);
    const base1 = server1.base;
    const base2 = server2.base;

    // 服务端准备三名资料互不相同的客户
    const imp = await importCsv(base1,
      "name,source,region,industry,important_date\n" +
      "页面甲,老来源A,华东,制造业,2020-01-15\n" +
      "页面乙,老来源B,华南,零售业,2021-06-30\n" +
      "页面丙,老来源C,华北,互联网,2022-12-01\n");
    check("准备数据：导入 3 名客户", imp.status === 200 && imp.body.imported_count === 3, imp);
    const [idA, idB, idC] = imp.body.imported.map(x => x.id);

    chrome = await launchChrome();
    const cdp = chrome.cdp;
    const pageErrors = [];
    cdp.on("Runtime.exceptionThrown", p => {
      pageErrors.push(norm(p.exceptionDetails && p.exceptionDetails.text));
    });
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: PAGE_HELPERS });
    const ruleFor = installFaultRules(cdp);
    const rule1 = ruleFor(new URL(base1).origin);
    const rule2 = ruleFor(new URL(base2).origin);

    const evalJs = async expr => {
      const r = await cdp.send("Runtime.evaluate", {
        expression: expr, awaitPromise: true, returnByValue: true,
      });
      if (r.exceptionDetails) {
        throw new Error("页面执行异常：" + JSON.stringify(r.exceptionDetails.exception || r.exceptionDetails.text));
      }
      return r.result.value;
    };
    const gotoPage = async url => {
      await cdp.send("Page.navigate", { url });
      const loaded = await evalJs("T.waitLoaded()");
      if (!loaded) throw new Error("页面初始列表状态等待超时：" + url);
    };
    const state = () => evalJs("T.state()");
    const saveAndWait = async () => {
      await evalJs("T.clickSave()");
      const done = await evalJs("T.waitDone()");
      if (!done) throw new Error("保存等待状态未结束");
      await sleep(300); // 给潜在的重复/延迟请求留出窗口，便于计数断言
    };

    const fieldMap = st => Object.fromEntries(st.fields.map(f => [f.field, f]));
    const rowsById = st => Object.fromEntries(st.rows.map(r => [r.id, r]));
    const expectResetForm = (st, label) => {
      for (const f of st.fields) {
        check(`${label}：${f.field} 恢复为保持原值`, f.op === "keep", f);
        check(`${label}：${f.field} 输入已清空`, f.value === "", f);
        check(`${label}：${f.field} 输入框回到不可填写`, f.inputDisabled === true, f);
      }
    };

    // ===== 0. 首次打开：渲染真实列表 =====
    await gotoPage(base1 + "/");
    let st = await state();
    check("初始：显示 3 行真实客户", st.tableOn && st.rows.length === 3, st.rows.map(r => r.name));
    check("初始：无空列表提示、无读取失败提示", !st.emptyOn && !st.loadErrorOn, st);
    check("初始：已选 0、保存按钮不可提交", st.selCount === 0 && st.submitDisabled, st);
    const beforeRows = st.rows;

    // ===== 1. 保存成功 + 随后列表网络连接失败 =====
    rule1.listMode = "fail";
    rule1.counts.list = 0;
    rule1.counts.save = 0;
    await evalJs(`T.selectRows([${idA}, ${idB}])`);
    await evalJs(`T.fillForm({
      source: {op: "set", value: "  新来源甲乙方  "},
      industry: {op: "clear"},
    })`);
    st = await state();
    check("保存前：已选 2 名且按钮可提交", st.selCount === 2 && !st.submitDisabled && st.submitText === "保存修改", st);
    await saveAndWait();
    st = await state();

    check("1 成功横幅：以保存回复为准显示处理 2 名",
      st.reportHasOk && /已成功处理\s*2\s*名客户/.test(st.reportText), st.reportText);
    check("1 成功横幅：说明勾选已清除、编辑恢复保持原值",
      st.reportText.includes("勾选已清除") && st.reportText.includes("保持原值"), st.reportText);
    check("1 失败提示：说明列表暂未更新、可能仍是保存前内容",
      st.reportHasWarn && st.reportText.includes("列表暂未更新") && st.reportText.includes("可能仍是保存前"),
      st.reportText);
    check("1 失败提示：说明稍后刷新即可、无需再次保存",
      st.reportText.includes("刷新页面即可看到最新资料") && st.reportText.includes("无需再次保存"),
      st.reportText);
    check("1 不得改说成全部拒绝/请求失败/无法确认/尚未保存",
      !st.reportHasBad &&
      !st.reportText.includes("全部拒绝") && !st.reportText.includes("请求失败") &&
      !st.reportText.includes("无法确认") && !st.reportText.includes("尚未保存"),
      st.reportText);
    check("1 页内列表读取失败提示出现", st.loadErrorOn, st.loadErrorText);
    check("1 页内提示说明稍后刷新即可重新读取",
      st.loadErrorText.includes("客户列表读取失败") && st.loadErrorText.includes("稍后刷新页面"),
      st.loadErrorText);

    check("1 已选数量归零、勾选全部取消",
      st.selCount === 0 && st.chipCount === 0 && st.rows.every(r => !r.checked && !r.selected) &&
      !st.checkAllChecked, st);
    check("1 保存按钮结束等待且未勾选时不可提交",
      st.submitText === "保存修改" && st.submitDisabled === true, st);
    expectResetForm(st, "1");

    check("1 旧表格完整保留：编号/名称/各字段仍是保存前内容",
      JSON.stringify(st.rows) === JSON.stringify(beforeRows),
      { before: beforeRows, after: st.rows });
    check("1 没有清掉表格、没有显示“还没有客户记录”",
      st.tableOn && st.rows.length === 3 && !st.emptyOn, st);

    check("1 修改只提交一次，未因读取失败自动重发",
      rule1.counts.save === 1 && rule1.counts.list >= 1, rule1.counts);
    const savedBody = JSON.parse(rule1.lastSaveBody || "{}");
    check("1 请求内容为当时勾选与填写",
      JSON.stringify(savedBody.ids) === JSON.stringify([idA, idB]) &&
      savedBody.updates.source.op === "set" && savedBody.updates.industry.op === "clear",
      savedBody);

    // 服务端确实已保存（绕过浏览器，直接查接口）
    let apiRows = await getClients(base1);
    let apiById = Object.fromEntries(apiRows.map(r => [r.id, r]));
    check("1 服务端：勾选客户来源已更新（前后空白去除）",
      apiById[idA].source === "新来源甲乙方" && apiById[idB].source === "新来源甲乙方",
      [apiById[idA], apiById[idB]]);
    check("1 服务端：行业已清空为 null",
      apiById[idA].industry === null && apiById[idB].industry === null,
      [apiById[idA], apiById[idB]]);
    check("1 服务端：未勾选客户完全不变",
      apiById[idC].source === "老来源C" && apiById[idC].region === "华北" &&
      apiById[idC].industry === "互联网" && apiById[idC].important_date === "2022-12-01",
      apiById[idC]);

    // ===== 2. 刷新页面：读取成功后展示真实数据并撤下失败提示 =====
    rule1.listMode = "pass";
    await gotoPage(base1 + "/");
    st = await state();
    check("2 刷新后显示真实返回的 3 名客户", st.tableOn && st.rows.length === 3, st.rows.length);
    check("2 刷新后读取失败提示撤下", !st.loadErrorOn && st.loadErrorText === "", st.loadErrorText);
    check("2 刷新后相关列更新为保存结果",
      rowsById(st)[idA].source === "新来源甲乙方" && rowsById(st)[idB].source === "新来源甲乙方" &&
      rowsById(st)[idA].industry === "—" && rowsById(st)[idB].industry === "—",
      st.rows);
    check("2 刷新后仍无勾选、按钮不可提交",
      st.selCount === 0 && st.submitDisabled && st.chipCount === 0, st);

    // ===== 3. 保存成功 + 列表返回非成功状态（HTTP 500）=====
    rule1.listMode = "http500";
    rule1.counts.list = 0;
    rule1.counts.save = 0;
    await evalJs(`T.selectRows([${idA}, ${idC}])`);
    await evalJs(`T.fillForm({ region: {op: "set", value: " 西北测试 "} })`);
    await saveAndWait();
    st = await state();
    check("3 处理数量仍为 2（以保存回复为准）",
      st.reportHasOk && /已成功处理\s*2\s*名客户/.test(st.reportText) && !st.reportHasBad, st.reportText);
    check("3 失败提示点名非成功状态且说明列表暂未更新",
      st.reportHasWarn && st.reportText.includes("HTTP 500") &&
      st.reportText.includes("列表暂未更新") && st.reportText.includes("无需再次保存"),
      st.reportText);
    check("3 旧表格保留：地区列仍是保存前内容",
      rowsById(st)[idA].region === "华东" && rowsById(st)[idC].region === "华北" &&
      st.rows.length === 3, st.rows);
    check("3 勾选清理与按钮状态",
      st.selCount === 0 && st.submitText === "保存修改" && st.submitDisabled, st);
    expectResetForm(st, "3");
    check("3 未自动重发修改", rule1.counts.save === 1, rule1.counts);
    apiRows = await getClients(base1);
    apiById = Object.fromEntries(apiRows.map(r => [r.id, r]));
    check("3 服务端：地区已保存",
      apiById[idA].region === "西北测试" && apiById[idC].region === "西北测试" &&
      apiById[idB].region === "华南", [apiById[idA], apiById[idB], apiById[idC]]);

    // 刷新恢复
    rule1.listMode = "pass";
    await gotoPage(base1 + "/");
    st = await state();
    check("3 刷新后失败提示撤下、地区列更新",
      !st.loadErrorOn && rowsById(st)[idA].region === "西北测试" &&
      rowsById(st)[idC].region === "西北测试", st);

    // ===== 4. 保存成功 + 列表内容无法解析 =====
    rule1.listMode = "badjson";
    rule1.counts.save = 0;
    rule1.counts.list = 0;
    await evalJs(`T.selectRows([${idB}])`);
    await evalJs(`T.fillForm({ industry: {op: "set", value: "行业乙新"} })`);
    await saveAndWait();
    st = await state();
    check("4 处理数量为 1，成功结论不受解析失败影响",
      st.reportHasOk && /已成功处理\s*1\s*名客户/.test(st.reportText) && !st.reportHasBad, st.reportText);
    check("4 提示说明响应无法解析、列表暂未更新、无需再次保存",
      st.reportHasWarn && st.reportText.includes("无法解析") &&
      st.reportText.includes("列表暂未更新") && st.reportText.includes("无需再次保存"), st.reportText);
    check("4 页内读取失败提示可见", st.loadErrorOn && st.loadErrorText.includes("无法解析"), st.loadErrorText);
    check("4 旧行业仍显示在表格中（本次刷新前的真实内容）",
      rowsById(st)[idB].industry === "—" && st.rows.length === 3, st.rows);
    check("4 勾选清理完成",
      st.selCount === 0 && st.submitDisabled && st.rows.every(r => !r.checked), st);
    expectResetForm(st, "4");
    check("4 未自动重发", rule1.counts.save === 1, rule1.counts);
    apiRows = await getClients(base1);
    apiById = Object.fromEntries(apiRows.map(r => [r.id, r]));
    check("4 服务端：行业已保存", apiById[idB].industry === "行业乙新", apiById[idB]);

    rule1.listMode = "pass";
    await gotoPage(base1 + "/");
    st = await state();
    check("4 刷新后解析失败提示撤下、行业更新",
      !st.loadErrorOn && rowsById(st)[idB].industry === "行业乙新", st);

    // ===== 5. 保存成功 + 列表响应缺少 clients 数组 =====
    rule1.listMode = "noclients";
    rule1.counts.save = 0;
    rule1.counts.list = 0;
    await evalJs(`T.selectRows([${idA}, ${idB}])`);
    await evalJs(`T.fillForm({ important_date: {op: "clear"} })`);
    await saveAndWait();
    st = await state();
    check("5 处理数量为 2，成功结论不受缺数组影响",
      st.reportHasOk && /已成功处理\s*2\s*名客户/.test(st.reportText) && !st.reportHasBad, st.reportText);
    check("5 提示说明未包含有效客户列表、列表暂未更新",
      st.reportHasWarn && st.reportText.includes("未包含有效的客户列表") &&
      st.reportText.includes("列表暂未更新") && st.reportText.includes("稍后"), st.reportText);
    check("5 旧表格与旧日期保留，不清空也不提示空列表",
      st.tableOn && st.rows.length === 3 && !st.emptyOn &&
      rowsById(st)[idA].importantDate === "2020-01-15" &&
      rowsById(st)[idB].importantDate === "2021-06-30", st.rows);
    check("5 勾选清理完成",
      st.selCount === 0 && st.submitDisabled && st.chipCount === 0, st);
    expectResetForm(st, "5");
    check("5 未自动重发", rule1.counts.save === 1, rule1.counts);
    apiRows = await getClients(base1);
    apiById = Object.fromEntries(apiRows.map(r => [r.id, r]));
    check("5 服务端：日期已清空",
      apiById[idA].important_date === null && apiById[idB].important_date === null &&
      apiById[idC].important_date === "2022-12-01", [apiById[idA], apiById[idB], apiById[idC]]);

    rule1.listMode = "pass";
    await gotoPage(base1 + "/");
    st = await state();
    check("5 刷新后提示撤下、日期清空列显示空、未勾选客户日期不变",
      !st.loadErrorOn &&
      rowsById(st)[idA].importantDate === "—" && rowsById(st)[idB].importantDate === "—" &&
      rowsById(st)[idC].importantDate === "2022-12-01", st.rows);

    // ===== 6. 成功数量不按刷新后出现的记录数量计算 =====
    rule1.listMode = "sparse"; // 合法 clients 数组，但只返回 1 条与本次保存无关的记录
    rule1.counts.save = 0;
    rule1.counts.list = 0;
    await evalJs(`T.selectRows([${idA}, ${idB}, ${idC}])`);
    await evalJs(`T.fillForm({ region: {op: "set", value: "统一地区"} })`);
    await saveAndWait();
    st = await state();
    check("6 横幅处理数量为 3，不按刷新返回的 1 条记录计算",
      st.reportHasOk && /已成功处理\s*3\s*名客户/.test(st.reportText) && !st.reportHasWarn,
      { report: st.reportText, rows: st.rows.length });
    check("6 勾选仍按保存成功清理",
      st.selCount === 0 && st.submitDisabled && st.chipCount === 0, st);
    expectResetForm(st, "6");
    check("6 未自动重发", rule1.counts.save === 1, rule1.counts);

    rule1.listMode = "pass";
    await gotoPage(base1 + "/");
    st = await state();
    check("6 刷新后恢复真实返回的 3 名客户且地区均已更新",
      !st.loadErrorOn && st.rows.length === 3 &&
      rowsById(st)[idA].region === "统一地区" && rowsById(st)[idB].region === "统一地区" &&
      rowsById(st)[idC].region === "统一地区", st.rows);

    // ===== 7. 保存被明确拒绝（HTTP 400）：不能套用成功后的清理与提示 =====
    rule1.saveMode = "http400";
    rule1.saveError = "测试拒绝原因：重要日期无效（2023-02-29）：不是真实日历日期";
    rule1.counts.save = 0;
    rule1.counts.list = 0;
    await evalJs(`T.selectRows([${idA}, ${idB}])`);
    await evalJs(`T.fillForm({
      source: {op: "set", value: "拒绝后不应保存的来源"},
      important_date: {op: "set", value: "2023-02-29"},
    })`);
    await saveAndWait();
    st = await state();
    check("7 显示全部拒绝与具体原因",
      st.reportHasBad && st.reportText.includes("全部拒绝") &&
      st.reportText.includes("测试拒绝原因：重要日期无效（2023-02-29）：不是真实日历日期"),
      st.reportText);
    check("7 不显示成功横幅或读取失败警告",
      !st.reportHasOk && !st.reportHasWarn, st.reportText);
    check("7 勾选保留供修正",
      st.selCount === 2 && !st.submitDisabled && st.submitText === "保存修改" &&
      rowsById(st)[idA].checked && rowsById(st)[idB].checked &&
      !rowsById(st)[idC].checked && st.chipsText.includes("#" + idA) &&
      st.chipsText.includes("页面甲"), st);
    const f = fieldMap(st);
    check("7 来源操作与填写内容保留",
      f.source.op === "set" && f.source.value === "拒绝后不应保存的来源" && !f.source.inputDisabled, f.source);
    check("7 重要日期操作与填写内容保留",
      f.important_date.op === "set" && f.important_date.value === "2023-02-29" &&
      !f.important_date.inputDisabled, f.important_date);
    check("7 未改动字段仍为保持原值",
      f.region.op === "keep" && f.industry.op === "keep", f);
    check("7 表格内容未被清理", st.tableOn && st.rows.length === 3 && !st.emptyOn, st);
    check("7 拒绝后不触发列表读取", rule1.counts.list === 0, rule1.counts);
    check("7 拒绝只产生一次保存请求", rule1.counts.save === 1, rule1.counts);
    apiRows = await getClients(base1);
    apiById = Object.fromEntries(apiRows.map(r => [r.id, r]));
    check("7 服务端资料保持拒绝前状态",
      apiById[idA].source === "新来源甲乙方" && apiById[idB].source === "新来源甲乙方" &&
      apiById[idA].important_date === null, [apiById[idA], apiById[idB]]);

    // 7b. 用户修正（日期改回保持原值）后重新保存：正常成功并完成清理
    rule1.saveMode = "pass";
    await evalJs(`T.fillForm({
      source: {op: "set", value: "拒绝后不应保存的来源"},
      important_date: {op: "keep"},
    })`);
    st = await state();
    check("7b 修正后仍保留原勾选且可提交", st.selCount === 2 && !st.submitDisabled, st);
    await saveAndWait();
    st = await state();
    check("7b 重新保存成功：显示处理 2 名、列表已更新",
      st.reportHasOk && /已成功处理\s*2\s*名客户/.test(st.reportText) &&
      st.reportText.includes("列表已更新") && !st.reportHasBad && !st.reportHasWarn, st.reportText);
    check("7b 成功后勾选清空、表单重置、按钮不可提交",
      st.selCount === 0 && st.submitDisabled && st.chipCount === 0, st);
    expectResetForm(st, "7b");
    check("7b 列表相关列已更新",
      rowsById(st)[idA].source === "拒绝后不应保存的来源" &&
      rowsById(st)[idB].source === "拒绝后不应保存的来源", st.rows);

    // ===== 8. 另一个空库：真实空列表 vs 读取失败的区分 =====
    // 8a 冷启动读到真实空列表
    await gotoPage(base2 + "/");
    st = await state();
    check("8a 真实空列表：显示空列表提示", st.emptyOn && !st.tableOn, st);
    check("8a 真实空列表：不被当成读取失败", !st.loadErrorOn, st.loadErrorText);
    check("8a 空列表时保存按钮不可提交", st.submitDisabled && st.selCount === 0, st);

    // 8b 读取失败（连接失败）：即使库里确实为空，也不能冒充空列表
    rule2.listMode = "fail";
    await gotoPage(base2 + "/");
    st = await state();
    check("8b 读取失败：失败提示出现", st.loadErrorOn && st.loadErrorText.includes("客户列表读取失败"), st);
    check("8b 读取失败：不显示“还没有客户记录”、不渲染表格",
      !st.emptyOn && !st.tableOn && st.rows.length === 0, st);

    // 8c 缺少 clients 数组同样视为失败而非空列表
    rule2.listMode = "noclients";
    await gotoPage(base2 + "/");
    st = await state();
    check("8c 缺 clients 数组：按读取失败处理",
      st.loadErrorOn && st.loadErrorText.includes("未包含有效的客户列表") && !st.emptyOn, st);

    // 恢复后真实空列表正常显示
    rule2.listMode = "pass";
    await gotoPage(base2 + "/");
    st = await state();
    check("8 恢复后：真实空列表提示恢复、失败提示撤下",
      st.emptyOn && !st.loadErrorOn && !st.tableOn, st);

    // 8d 空库导入一名客户后，保存成功 + 列表读取成功的正常路径
    const imp2 = await importCsv(base2, "name,source,region\n空库客户,初始来源,初始地区\n");
    check("8d 空库导入 1 名客户", imp2.status === 200 && imp2.body.imported_count === 1, imp2.body);
    const idD = imp2.body.imported[0].id;
    await gotoPage(base2 + "/");
    st = await state();
    check("8d 列表显示该客户", st.tableOn && st.rows.length === 1 && rowsById(st)[idD], st.rows);
    rule2.counts.save = 0;
    rule2.counts.list = 0;
    await evalJs(`T.selectRows([${idD}])`);
    await evalJs(`T.fillForm({ source: {op: "set", value: "更新后来源"} })`);
    await saveAndWait();
    st = await state();
    check("8d 正常路径：显示处理 1 名、列表已更新",
      st.reportHasOk && /已成功处理\s*1\s*名客户/.test(st.reportText) &&
      st.reportText.includes("列表已更新") && !st.reportHasWarn && !st.reportHasBad, st.reportText);
    check("8d 正常路径：无读取失败提示", !st.loadErrorOn, st.loadErrorText);
    check("8d 正常路径：相关列更新",
      rowsById(st)[idD].source === "更新后来源" && rowsById(st)[idD].region === "初始地区", st.rows);
    check("8d 正常路径：勾选清零、表单重置、按钮不可提交",
      st.selCount === 0 && st.submitDisabled && st.chipCount === 0, st);
    expectResetForm(st, "8d");

    if (pageErrors.length) {
      check("页面无未捕获异常", false, pageErrors);
    } else {
      check("页面无未捕获异常", true);
    }
  } catch (err) {
    console.error("\n测试执行中断：", err.stack || err);
    failed++;
  } finally {
    if (chrome) {
      try { chrome.cdp.ws.close(); } catch { /* ignore */ }
      try { chrome.proc.kill(); } catch { /* ignore */ }
      try { await sleep(200); } catch { /* ignore */ }
      try { fs.rmSync(chrome.profile, { recursive: true, force: true }); } catch { /* ignore */ }
    }
    for (const s of [server1, server2]) {
      if (s) {
        try { s.proc.kill("SIGTERM"); } catch { /* ignore */ }
      }
    }
    for (const d of [dataDir1, dataDir2]) {
      try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
    }
    // 等待被终止的子进程回收，避免输出残留
    await sleep(150);
  }

  console.log("\n" + "=".repeat(48));
  if (failed === 0) {
    console.log("页面批量保存回归测试全部通过");
  } else {
    console.log(`${failed} 项失败：\n - ${failureNames.join("\n - ")}`);
  }
  process.exit(failed ? 1 : 0);
}

main();

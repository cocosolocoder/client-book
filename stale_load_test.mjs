#!/usr/bin/env node
/**
 * 客户列表多次读取先后错开的页面层面回归保障。
 *
 * 启动真实 app.py 服务（与 smoke_test.py 同一后端，不模拟、不改动接口公开行为），
 * 用 Puppeteer 驱动系统 Chrome 打开首页，通过请求拦截把客户列表读取挂起，
 * 人为制造「较早发起的读取的回复晚于较新读取到达」的乱序，逐项验证：
 *
 * 1. 同一页面以最近发起的列表读取决定表格内容与读取提示：首次读取尚未结束
 *    时导入成功，导入触发的读取已显示新增客户后，首次读取才带着导入前的
 *    列表返回，页面继续显示新增后的记录；旧回复是空列表时也不出现
 *    「还没有客户记录」；
 * 2. 旧读取随后发生连接错误、返回非成功状态或数据无法解析，都不能给已经
 *    更新的页面新增读取失败或列表暂未更新的提示，也不重发请求；
 * 3. 较新读取仍在等待时，较早回复不能抢先决定页面内容：现有勾选、已选
 *    数量与已选客户说明不因旧列表缺少某个编号而被清除；
 * 4. 最近发起的读取失败时保留此前已显示的客户行并提示列表暂未更新；此后
 *    较早读取即使成功，也不能撤掉这一提示或换掉保留的表格；
 * 5. 由批量保存触发的列表读取同样适用：它成为较早读取时，已显示的客户
 *    编号、名称及其他资料不被旧回复替换，保存成功数量仍以保存回复为准，
 *    但不再断言「列表已更新」，也不误报读取失败。
 */
import {spawn} from "node:child_process";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";
import {mkdtempSync, mkdirSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import puppeteer from "puppeteer";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, "app.py");
const TMP = mkdtempSync(join(tmpdir(), "clientbook-stale-load-"));
const FAILURES = [];
let checkCount = 0;

function check(label, cond, detail = "") {
  checkCount += 1;
  if (cond) {
    console.log("PASS", label);
  } else {
    FAILURES.push({label, detail: typeof detail === "string" ? detail : JSON.stringify(detail)});
    console.log("FAIL", label, typeof detail === "string" ? detail : JSON.stringify(detail));
  }
}

// ---------------------------------------------------------------------------
// 真实 app.py 进程
// ---------------------------------------------------------------------------
function startApp(label) {
  const proc = spawn("python3", [
    APP, "serve", "--host", "127.0.0.1", "--port", "0",
    "--data-dir", join(TMP, label),
  ], {cwd: HERE, stdio: ["ignore", "pipe", "pipe"]});
  const port = new Promise((resolve, reject) => {
    let buf = "";
    const onData = d => {
      buf += d.toString();
      const m = buf.match(/http:\/\/127\.0\.0\.1:(\d+)/);
      if (m) {
        proc.stdout.off("data", onData);
        resolve(Number(m[1]));
      }
    };
    proc.stdout.on("data", onData);
    proc.on("exit", code => reject(new Error(`app.py 意外退出（${code}）：${buf}`)));
  });
  return {proc, port};
}

async function waitReady(base, deadlineMs = 8000) {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(base + "/health");
      if (res.status === 200) return;
    } catch { /* 尚未就绪 */ }
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error("服务未在限定时间内就绪：" + base);
}

async function stopApp(ctx) {
  ctx.proc.kill();
  const timer = setTimeout(() => {
    try { ctx.proc.kill("SIGKILL"); } catch { /* 已退出 */ }
  }, 2000);
  await new Promise(r => ctx.proc.on("exit", r));
  clearTimeout(timer);
}

async function startServer(label) {
  const ctx = startApp(label);
  const port = await ctx.port;
  const base = `http://127.0.0.1:${port}`;
  await waitReady(base);
  return {proc: ctx.proc, base};
}

async function listClients(base) {
  const res = await fetch(base + "/api/clients");
  return res.json();
}

async function importCsv(base, csv) {
  const res = await fetch(base + "/api/clients/import", {method: "POST", body: csv});
  const data = await res.json();
  if (res.status !== 200) throw new Error("seed 失败：" + JSON.stringify(data));
  return data;
}

// 直接打后端准备稳定的测试数据
async function seed(base, rows) {
  const lines = rows.map(r => [r.name, r.source ?? "", r.region ?? "", r.industry ?? "", r.date ?? ""]
    .map(v => `"${String(v).replace(/"/g, '""')}"`).join(","));
  const csv = "name,source,region,industry,important_date\n" + lines.join("\n") + "\n";
  const data = await importCsv(base, csv);
  return data.imported.map(x => x.id);
}

// ---------------------------------------------------------------------------
// 页面驱动：拦截客户列表读取，可挂起后按测试指定的顺序与内容放行
// ---------------------------------------------------------------------------
async function openSession(browser, base, {listHold = true} = {}) {
  const page = await browser.newPage();
  const modes = {listHold};
  const counts = {listGets: 0, importPosts: 0, batchPosts: 0};
  // 被挂起的客户列表读取，按发起先后入队（下标 0 即最早发起的那次）
  const heldLists = [];

  await page.setRequestInterception(true);
  page.on("request", request => {
    const url = request.url();
    if (request.method() === "GET" && url.endsWith("/api/clients")) {
      counts.listGets += 1;
      if (modes.listHold) {
        heldLists.push(request);
        return;
      }
      request.continue();
      return;
    }
    if (request.method() === "POST" && url.endsWith("/api/clients/import")) {
      counts.importPosts += 1;
    }
    if (request.method() === "POST" && url.endsWith("/api/clients/batch-update")) {
      counts.batchPosts += 1;
    }
    request.continue();
  });

  await page.setCacheEnabled(false);
  // 首次列表读取可能被挂起，不能等 networkidle0
  await page.goto(base + "/", {waitUntil: "domcontentloaded"});
  return {page, modes, counts, heldLists};
}

// 等待第 n 次（1 起）列表读取被挂起
async function waitHeld(session, n, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (session.heldLists.length >= n) return session.heldLists[n - 1];
    await new Promise(r => setTimeout(r, 25));
  }
  throw new Error(`第 ${n} 次列表读取未在限定时间内被挂起`);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// 读取页面与客户列表、两个表单区域的全部可见状态
async function snap(page) {
  return page.evaluate(() => {
    const text = sel => document.querySelector(sel)?.textContent.trim() ?? null;
    return {
      rows: [...document.querySelectorAll("#clients-body tr")].map(tr => ({
        id: tr.dataset.id,
        // td: 0 勾选框, 1 编号, 2 名称, 3 来源, 4 地区, 5 行业, 6 重要日期
        cells: [...tr.querySelectorAll("td")].slice(1).map(td => td.textContent.trim()),
        checked: tr.querySelector(".row-check").checked,
      })),
      emptyOn: document.getElementById("clients-empty").classList.contains("on"),
      loadErrorOn: document.getElementById("clients-load-error").classList.contains("on"),
      loadErrorText: text("#clients-load-error"),
      selCount: text("#sel-count"),
      selList: document.getElementById("sel-list").innerText.replace(/[ \t\r\n]+/g, " ").trim(),
      batchSubmitDisabled: document.getElementById("batch-submit").disabled,
      batchSubmitText: text("#batch-submit"),
      batchReport: document.getElementById("batch-report").innerText.replace(/[ \t\r\n]+/g, " ").trim(),
      importReport: document.getElementById("report").innerText.replace(/[ \t\r\n]+/g, " ").trim(),
      importBanners: [...document.querySelectorAll("#report .banner")].map(b => b.className),
      submitText: text("#submit-btn"),
      submitDisabled: document.getElementById("submit-btn").disabled,
    };
  });
}

async function waitRows(page, n, timeout = 5000) {
  await page.waitForFunction(
    expected => document.querySelectorAll("#clients-body tr").length === expected,
    {timeout}, n);
}

async function uploadCsv(page, name, content) {
  const dir = join(TMP, "uploads");
  mkdirSync(dir, {recursive: true});
  const path = join(dir, name);
  writeFileSync(path, content, "utf8");
  const input = await page.$("#file-input");
  await input.uploadFile(path);
  await page.waitForFunction(n => document.getElementById("filename").textContent === n,
    {}, name);
}

// 提交导入并等待导入报告出现（列表读取可能仍被挂起，不等按钮恢复）
async function submitImport(page) {
  await page.click("#submit-btn");
  await page.waitForSelector("#report .banner", {timeout: 5000});
}

// 勾选指定编号的客户
async function selectRows(page, ids) {
  for (const id of ids) {
    await page.click(`#clients-body tr[data-id="${id}"] .row-check`);
  }
  await page.waitForFunction(
    n => document.getElementById("sel-count").textContent.trim() === String(n),
    {timeout: 3000}, ids.length);
}

// 把来源字段设为填写的值
async function setSourceField(page, value) {
  await page.click('input[name="source-op"][value="set"]');
  await page.click('.bf[data-field="source"] .bf-value', {clickCount: 3});
  await page.type('.bf[data-field="source"] .bf-value', value);
}

// 提交批量修改并等待保存回复处理到「读取客户列表」阶段（读取本身可能被挂起）
async function submitBatch(page) {
  await page.click("#batch-submit");
  await page.waitForSelector("#batch-report .banner", {timeout: 5000});
}

const CSV_TWO = "name,source,region,industry,important_date\n" +
  "新客户甲,来源甲,地区甲,行业甲,2025-01-02\n" +
  "新客户乙,来源乙,地区乙,行业乙,2025-03-04\n";

// ---------------------------------------------------------------------------
// 场景
// ---------------------------------------------------------------------------

// 场景 A/B：首次读取挂起 → 导入成功、导入触发的读取先显示新增客户 →
// 首次读取才带着导入前的列表返回。A 的旧列表含既有客户，B 的旧列表为空。
async function scenarioStaleSuccess(browser, {label, seedRows, csvName}) {
  const server = await startServer(label);
  try {
    if (seedRows.length) await seed(server.base, seedRows);
    const oldBody = JSON.stringify(await listClients(server.base)); // 导入前的列表
    const session = await openSession(browser, server.base);
    const {page, heldLists} = session;

    await waitHeld(session, 1); // 首次读取 A 被挂起
    await uploadCsv(page, csvName, CSV_TWO);
    await submitImport(page);
    await page.waitForSelector("#report .banner.ok", {timeout: 5000});
    await waitHeld(session, 2); // 导入触发的读取 B 被挂起

    // 较新的读取 B 先带着导入后的真实列表返回
    heldLists[1].respond({
      status: 200, contentType: "application/json; charset=utf-8",
      body: JSON.stringify(await listClients(server.base)),
    });
    const expectedRows = seedRows.length + 2;
    await waitRows(page, expectedRows);
    let s = await snap(page);
    check(label + " 较新读取先到达：显示导入后的全部客户",
      s.rows.length === expectedRows && !s.emptyOn && !s.loadErrorOn,
      {rows: s.rows.map(r => r.id), empty: s.emptyOn, err: s.loadErrorOn});
    check(label + " 导入报告按有效回复显示新增数量",
      s.importReport.includes("新增 2 条") && s.importReport.includes("未导入 0 条"),
      s.importReport);

    // 较早发起的读取 A 才带着导入前的列表返回：不能再决定页面内容
    heldLists[0].respond({
      status: 200, contentType: "application/json; charset=utf-8", body: oldBody});
    await sleep(300);
    s = await snap(page);
    check(label + " 旧回复到达后：表格仍是新增后的记录，不被旧列表替换",
      s.rows.length === expectedRows &&
      s.rows.every(r => r.cells[1].startsWith("新客户") || seedRows.some(x => x.name === r.cells[1])),
      {rows: s.rows.map(r => r.cells), expectedRows});
    check(label + " 旧回复到达后：不出现「还没有客户记录」",
      !s.emptyOn, {empty: s.emptyOn, rows: s.rows.length});
    check(label + " 旧回复到达后：没有读取失败提示",
      !s.loadErrorOn && !s.loadErrorText, s.loadErrorText);
    check(label + " 旧回复到达后：导入报告不变、无附加提示",
      s.importReport.includes("新增 2 条") && s.importBanners.length === 1,
      {report: s.importReport, banners: s.importBanners});
    check(label + " 全程只有两次列表读取，没有自动重发",
      session.counts.listGets === 2, `gets=${session.counts.listGets}`);
    await page.close();
  } finally {
    await stopApp(server);
  }
}

// 场景 C：旧读取随后连接错误 / 非成功状态 / 无法解析——不能给已更新的
// 页面新增读取失败或列表暂未更新的提示。
async function scenarioStaleFailure(browser, label, release) {
  const server = await startServer(label);
  try {
    await seed(server.base, [{name: "既有客户", source: "旧来源"}]);
    const session = await openSession(browser, server.base);
    const {page, heldLists} = session;

    await waitHeld(session, 1);
    await uploadCsv(page, label + ".csv", CSV_TWO);
    await submitImport(page);
    await page.waitForSelector("#report .banner.ok", {timeout: 5000});
    await waitHeld(session, 2);

    heldLists[1].respond({
      status: 200, contentType: "application/json; charset=utf-8",
      body: JSON.stringify(await listClients(server.base)),
    });
    await waitRows(page, 3);

    await release(heldLists[0]);
    await sleep(300);
    const s = await snap(page);
    check(label + " 旧读取失败后：表格保持新增后的 3 名客户",
      s.rows.length === 3, {rows: s.rows.map(r => r.id)});
    check(label + " 旧读取失败后：不新增读取失败提示",
      !s.loadErrorOn && !s.loadErrorText, s.loadErrorText);
    check(label + " 旧读取失败后：不出现空列表说明", !s.emptyOn);
    check(label + " 旧读取失败后：导入报告无「列表暂未更新」等附加提示",
      s.importBanners.length === 1 && !s.importReport.includes("列表暂未更新"),
      {report: s.importReport, banners: s.importBanners});
    check(label + " 旧读取失败后：没有自动重发读取",
      session.counts.listGets === 2, `gets=${session.counts.listGets}`);
    await page.close();
  } finally {
    await stopApp(server);
  }
}

// 场景 D：较新读取仍在等待时，较早回复不能抢先决定页面内容；
// 现有勾选与已选客户说明不得因旧列表缺少某个编号而被清除。
async function scenarioSelectionKept(browser) {
  const server = await startServer("selection");
  try {
    const session = await openSession(browser, server.base);
    const {page, heldLists} = session;

    await waitHeld(session, 1); // 首次读取 A 挂起
    await uploadCsv(page, "selection.csv", CSV_TWO);
    await submitImport(page);
    await page.waitForSelector("#report .banner.ok", {timeout: 5000});
    await waitHeld(session, 2); // 导入触发的读取 B 挂起

    // 较新的读取 B 放行到真实后端，表格显示两名新客户
    heldLists[1].continue();
    await waitRows(page, 2);
    const ids = (await listClients(server.base)).clients.map(c => c.id);
    await selectRows(page, ids);
    let s = await snap(page);
    check("D 勾选完成：已选 2 名客户、说明列出两名客户",
      s.selCount === "2" && s.selList.includes("新客户甲") && s.selList.includes("新客户乙"),
      {count: s.selCount, list: s.selList});

    // 较早发起的读取 A 带着导入前的空列表返回：不能清除勾选与表格
    heldLists[0].respond({
      status: 200, contentType: "application/json; charset=utf-8",
      body: JSON.stringify({clients: []}),
    });
    await sleep(300);
    s = await snap(page);
    check("D 旧空列表到达后：表格仍是两名新客户",
      s.rows.length === 2, {rows: s.rows.map(r => r.id)});
    check("D 旧空列表到达后：勾选保留、复选框仍选中",
      s.rows.every(r => r.checked) && s.selCount === "2",
      {checked: s.rows.map(r => r.checked), count: s.selCount});
    check("D 旧空列表到达后：已选客户说明保留",
      s.selList.includes("新客户甲") && s.selList.includes("新客户乙"), s.selList);
    check("D 旧空列表到达后：保存按钮因仍有勾选而可提交",
      !s.batchSubmitDisabled && s.batchSubmitText === "保存修改",
      {disabled: s.batchSubmitDisabled, text: s.batchSubmitText});
    check("D 旧空列表到达后：无空列表说明、无读取失败提示",
      !s.emptyOn && !s.loadErrorOn, {empty: s.emptyOn, err: s.loadErrorOn});
    await page.close();
  } finally {
    await stopApp(server);
  }
}

// 场景 E：最近发起的读取（批量保存触发）失败，保留此前已显示的客户行并
// 提示列表暂未更新；此后较早读取（导入触发）即使成功，也不能撤掉提示
// 或换掉保留的表格。
async function scenarioNewestFailsThenStaleSucceeds(browser) {
  const server = await startServer("newest-fails");
  try {
    const [id1, id2] = await seed(server.base, [
      {name: "客户甲", source: "甲来源"},
      {name: "客户乙", source: "乙来源"},
    ]);
    const session = await openSession(browser, server.base, {listHold: false});
    const {page, modes, heldLists} = session;
    await waitRows(page, 2); // 首次读取正常完成，表格显示两名客户

    modes.listHold = true;
    await uploadCsv(page, "newest-fails.csv", "name\n新客户丙\n");
    await submitImport(page);
    await page.waitForSelector("#report .banner.ok", {timeout: 5000});
    await waitHeld(session, 1); // 导入触发的读取 A（首次读取之后的第一次挂起）

    await selectRows(page, [id1, id2]);
    await setSourceField(page, "统一来源");
    await submitBatch(page);
    await waitHeld(session, 2); // 批量保存触发的读取 B（最近发起）挂起

    // 最近发起的读取 B 失败：保留旧表格并提示列表暂未更新
    heldLists[1].respond({status: 500, contentType: "application/json; charset=utf-8",
      body: JSON.stringify({error: "模拟的服务错误"})});
    await page.waitForSelector("#clients-load-error.on", {timeout: 5000});
    let s = await snap(page);
    check("E 最近读取失败：保留此前显示的两名客户行",
      s.rows.length === 2 && s.rows[0].cells[1] === "客户甲" && s.rows[1].cells[1] === "客户乙",
      {rows: s.rows.map(r => r.cells)});
    check("E 最近读取失败：提示列表暂未更新、资料可能不是最新",
      s.loadErrorOn && s.loadErrorText.includes("可能不是最新") &&
      s.batchReport.includes("列表暂未更新") && s.batchReport.includes("无需再次保存"),
      {err: s.loadErrorText, report: s.batchReport});
    check("E 最近读取失败：保存成功数量以保存回复为准",
      s.batchReport.includes("已成功处理 2 名客户"), s.batchReport);

    // 较早发起的读取 A 随后成功返回真实列表：不能撤掉提示、不能换掉表格
    heldLists[0].respond({
      status: 200, contentType: "application/json; charset=utf-8",
      body: JSON.stringify(await listClients(server.base)),
    });
    await sleep(300);
    s = await snap(page);
    check("E 较早读取随后成功：读取失败提示保留",
      s.loadErrorOn && s.loadErrorText.includes("可能不是最新"), s.loadErrorText);
    check("E 较早读取随后成功：保留的表格不被换掉（仍是两名旧客户）",
      s.rows.length === 2 && s.rows[0].cells[1] === "客户甲" && s.rows[1].cells[1] === "客户乙",
      {rows: s.rows.map(r => r.cells)});
    check("E 较早读取随后成功：批量保存报告的失败提示保留",
      s.batchReport.includes("列表暂未更新") && s.batchReport.includes("已成功处理 2 名客户"),
      s.batchReport);
    check("E 较早读取随后成功：不出现空列表说明", !s.emptyOn);
    await page.close();
  } finally {
    await stopApp(server);
  }
}

// 场景 F：批量保存触发的读取成为较早读取——已显示的客户资料不被它的
// 旧回复替换；保存成功数量仍以保存回复为准，但不再断言「列表已更新」，
// 也不误报读取失败。
async function scenarioBatchReadStale(browser) {
  const server = await startServer("batch-stale");
  try {
    const [id1, id2] = await seed(server.base, [
      {name: "客户甲", source: "甲来源"},
      {name: "客户乙", source: "乙来源"},
    ]);
    const session = await openSession(browser, server.base, {listHold: false});
    const {page, modes, heldLists} = session;
    await waitRows(page, 2);

    modes.listHold = true;
    await selectRows(page, [id1, id2]);
    await setSourceField(page, "统一来源");
    await submitBatch(page);
    await waitHeld(session, 1); // 批量保存触发的读取 A 挂起

    await uploadCsv(page, "batch-stale.csv", "name\n新客户丙\n");
    await submitImport(page);
    await page.waitForSelector("#report .banner.ok", {timeout: 5000});
    await waitHeld(session, 2); // 导入触发的读取 B（最近发起）挂起

    // 最近发起的读取 B 先返回导入后的真实列表（含批量修改后的来源）
    heldLists[1].respond({
      status: 200, contentType: "application/json; charset=utf-8",
      body: JSON.stringify(await listClients(server.base)),
    });
    await waitRows(page, 3);
    let s = await snap(page);
    check("F 较新读取先到达：表格显示导入后的 3 名客户",
      s.rows.length === 3, {rows: s.rows.map(r => r.id)});
    check("F 较新读取先到达：批量修改后的来源已显示",
      s.rows.filter(r => r.cells[1] !== "新客户丙").every(r => r.cells[2] === "统一来源"),
      {rows: s.rows.map(r => r.cells)});
    check("F 批量保存的读取仍在等待：报告保持等待提示",
      s.batchReport.includes("正在保存") && s.batchSubmitDisabled,
      {report: s.batchReport, disabled: s.batchSubmitDisabled});

    // 较早发起的读取 A 才带着导入前的旧列表返回：不能替换已显示的资料
    const staleBody = JSON.stringify({clients: [
      {id: id1, name: "客户甲", source: "甲来源", region: null, industry: null, important_date: null},
      {id: id2, name: "客户乙", source: "乙来源", region: null, industry: null, important_date: null},
    ]});
    heldLists[0].respond({
      status: 200, contentType: "application/json; charset=utf-8", body: staleBody});
    await page.waitForFunction(
      () => document.getElementById("batch-report").innerText.includes("已成功处理"),
      {timeout: 5000});
    s = await snap(page);
    check("F 旧回复到达后：表格仍是导入后的 3 名客户，编号名称未被替换",
      s.rows.length === 3 && s.rows[2].cells[1] === "新客户丙",
      {rows: s.rows.map(r => r.cells)});
    check("F 旧回复到达后：批量修改后的来源等其他资料未被旧值替换",
      s.rows.filter(r => r.cells[1] !== "新客户丙").every(r => r.cells[2] === "统一来源"),
      {rows: s.rows.map(r => r.cells)});
    check("F 旧回复到达后：保存成功数量仍以保存回复为准",
      s.batchReport.includes("已成功处理 2 名客户"), s.batchReport);
    check("F 旧回复到达后：不断言「列表已更新」、也不误报读取失败",
      !s.batchReport.includes("列表已更新") && !s.batchReport.includes("列表暂未更新") &&
      !s.loadErrorOn,
      {report: s.batchReport, err: s.loadErrorOn});
    check("F 旧回复到达后：勾选清除与字段复位沿用保存成功行为",
      s.selCount === "0" && s.batchSubmitDisabled,
      {count: s.selCount, disabled: s.batchSubmitDisabled});
    check("F 旧回复到达后：无空列表说明、导入报告不变",
      !s.emptyOn && s.importReport.includes("新增 1 条"),
      {empty: s.emptyOn, report: s.importReport});
    await page.close();
  } finally {
    await stopApp(server);
  }
}

// ---------------------------------------------------------------------------
async function run() {
  const browser = await puppeteer.launch({
    executablePath: process.env.CHROME || "/usr/bin/google-chrome",
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });

  try {
    await scenarioStaleSuccess(browser, {
      label: "A", seedRows: [{name: "既有客户", source: "旧来源"}], csvName: "a.csv"});
    await scenarioStaleSuccess(browser, {label: "B", seedRows: [], csvName: "b.csv"});
    await scenarioStaleFailure(browser, "C1 连接错误", req => req.abort("failed"));
    await scenarioStaleFailure(browser, "C2 非成功状态", req => req.respond({
      status: 500, contentType: "application/json; charset=utf-8",
      body: JSON.stringify({error: "模拟的服务错误"})}));
    await scenarioStaleFailure(browser, "C3 无法解析", req => req.respond({
      status: 200, contentType: "application/json; charset=utf-8",
      body: "<<<not valid json>>>"}));
    await scenarioSelectionKept(browser);
    await scenarioNewestFailsThenStaleSucceeds(browser);
    await scenarioBatchReadStale(browser);

    await browser.close();
  } finally {
    rmSync(TMP, {recursive: true, force: true});
  }

  console.log(`\n${"=".repeat(50)}`);
  if (FAILURES.length) {
    console.log(`${FAILURES.length} / ${checkCount} 项断言失败：`);
    for (const {label, detail} of FAILURES) {
      console.log(" -", label, detail ? `（${detail}）` : "");
    }
    process.exitCode = 1;
  } else {
    console.log(`全部通过（共 ${checkCount} 项页面层面断言）`);
  }
}

run().catch(err => {
  console.error("测试运行出错：", err);
  process.exit(1);
});

#!/usr/bin/env node
/**
 * 首页 CSV 导入结果展示的页面层面回归保障。
 *
 * 启动真实 app.py 服务（与 smoke_test.py、page_test.mjs 同一后端，不模拟、不改动
 * 接口公开行为），用 Puppeteer 驱动系统 Chrome 打开首页，通过请求拦截分别「破坏」
 * 导入回复与「导入成功之后的那次客户列表读取」，逐项验证：
 *
 * 1. 完整有效的导入报告：页面按报告显示新增数量与未导入数量，并按原文件的数据
 *    记录编号逐条展示未导入原因（表头不计入编号；带引号字段里的换行不拆成多条
 *    记录）；有效与无效记录混在同一文件的部分成功照常展示；
 * 2. 合法的零结果：只有表头时显示零新增、零未导入；全部记录因重复或字段问题
 *    跳过时仍显示完整数量与逐条原因，不说成整份文件被拒绝；
 * 3. 成功状态但报告不可靠（回复无法解析、数量不是非负整数、未导入明细缺失或
 *    条数与报告数量不符、记录编号不是正整数、原因不是非空文本、非 400 的失败
 *    状态）：显示结果无法确认、提示先核对客户列表再决定是否重新导入；不显示
 *    任何成功数量，不补造零新增报告，不出现 undefined 等内容；
 * 4. 已确认的有效报告之后，客户列表读取失败（连接失败 / 无法解析 / 缺少客户
 *    数组）：保留已确认的数量与逐条原因，附加列表暂未更新、资料可能不是最新、
 *    稍后刷新即可、无需重新导入的说明；此前显示的客户行保留，不清空、不改成
 *    没有客户的提示；重新打开页面读取成功时显示实际保存的资料；
 * 5. 结果处理结束后：导入按钮恢复可用、已选文件保留、页面不自动再次提交文件；
 * 6. 正常路径：导入成功且列表读取成功，列表即时刷新出新增客户；
 * 7. 整份文件明确拒绝（HTTP 400）：保留原有错误说明与资料不变的行为，不刷新
 *    列表、不显示成功数量；
 * 8. 新增数量只以导入报告为准，不凭客户列表的变化推算（报告数量与列表行数
 *    不一致时仍按报告显示）。
 *
 * 运行方式（需要 Node 18+ 与系统 Chrome/Chromium；默认 /usr/bin/google-chrome，
 * 可用 CHROME 环境变量指定其它可执行文件）：
 *
 *     npm install
 *     node import_test.mjs   # 或 npm run test:import
 */
import {spawn} from "node:child_process";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";
import {mkdtempSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import puppeteer from "puppeteer";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, "app.py");
const TMP = mkdtempSync(join(tmpdir(), "clientbook-import-"));
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
  ctx.proc.kill(); // SIGTERM：app.py 收到后走正常关闭
  const timer = setTimeout(() => {
    try { ctx.proc.kill("SIGKILL"); } catch { /* 已退出 */ }
  }, 2000);
  await new Promise(r => ctx.proc.on("exit", r));
  clearTimeout(timer);
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

async function listClients(base) {
  const res = await fetch(base + "/api/clients");
  return res.json();
}

// 把测试用 CSV 写到临时目录，供文件选择框上传
function csvFile(name, content) {
  const path = join(TMP, name);
  writeFileSync(path, content, "utf8");
  return path;
}

// ---------------------------------------------------------------------------
// 页面驱动：请求拦截分别控制「导入回复」与「导入后的列表读取」
// ---------------------------------------------------------------------------
async function openSession(browser, base) {
  const page = await browser.newPage();
  const modes = {
    // ok 正常转发；close 连接断开；bad-json 无法解析；no-clients 可解析但缺少客户数组
    list: "ok",
    // 导入响应改写：null = 走真实后端；否则用给定 {status, body}
    importOverride: null,
  };
  const counts = {importPosts: 0, listGets: 0};

  await page.setRequestInterception(true);
  page.on("request", request => {
    const url = request.url();
    if (request.method() === "GET" && url.endsWith("/api/clients")) {
      counts.listGets += 1;
      if (modes.list === "close") { request.abort("failed"); return; }
      if (modes.list === "bad-json") {
        request.respond({status: 200, contentType: "application/json; charset=utf-8",
          body: "<<<not valid json>>>"});
        return;
      }
      if (modes.list === "no-clients") {
        request.respond({status: 200, contentType: "application/json; charset=utf-8",
          body: JSON.stringify({unexpected: true})});
        return;
      }
      request.continue();
      return;
    }
    if (request.method() === "POST" && url.endsWith("/api/clients/import")) {
      counts.importPosts += 1;
      if (modes.importOverride) {
        const {status, body} = modes.importOverride;
        request.respond({status, contentType: "application/json; charset=utf-8", body});
        return;
      }
    }
    request.continue();
  });

  await page.setCacheEnabled(false);
  await page.goto(base + "/", {waitUntil: "networkidle0"});
  return {page, modes, counts};
}

// 读取导入区域与列表区域的全部可见状态
async function snapshot(page) {
  return page.evaluate(() => {
    const text = sel => document.querySelector(sel)?.textContent.trim() ?? null;
    return {
      reportShown: document.getElementById("report").style.display === "block",
      reportText: document.getElementById("report").innerText.replace(/[ \t\r\n]+/g, " ").trim(),
      banners: [...document.querySelectorAll("#report .banner")].map(b => ({
        cls: b.className,
        text: b.innerText.replace(/[ \t\r\n]+/g, " ").trim(),
      })),
      failureItems: [...document.querySelectorAll("#report .failures li")]
        .map(li => li.innerText.replace(/[ \t\r\n]+/g, " ").trim()),
      submitDisabled: document.getElementById("submit-btn").disabled,
      fileCount: document.getElementById("file-input").files.length,
      fileName: text("#filename"),
      rows: [...document.querySelectorAll("#clients-body tr")].map(tr => ({
        id: tr.dataset.id,
        // td: 0 勾选框, 1 编号, 2 名称, 3 来源, 4 地区, 5 行业, 6 重要日期
        cells: [...tr.querySelectorAll("td")].slice(1).map(td => td.textContent.trim()),
      })),
      tableDisplay: getComputedStyle(document.getElementById("clients-table")).display,
      emptyOn: document.getElementById("clients-empty").classList.contains("on"),
      loadErrorOn: document.getElementById("clients-load-error").classList.contains("on"),
      loadErrorText: text("#clients-load-error"),
    };
  });
}

// 选择文件并提交导入，等待本次结果处理结束（按钮恢复可用、报告已展示）
async function importAndSettle(session, filePath) {
  const {page, counts} = session;
  const input = await page.$("#file-input");
  await input.uploadFile(filePath);
  const before = counts.importPosts;
  await page.click("#submit-btn");
  await page.waitForFunction(
    () => document.getElementById("report").style.display === "block" &&
      !document.getElementById("submit-btn").disabled,
    {timeout: 5000});
  await new Promise(r => setTimeout(r, 60)); // 让横幅/列表提示渲染稳定
  return before;
}

// 结果处理结束后页面不自动再次提交文件
async function checkNoResubmit(session, label, before) {
  await new Promise(r => setTimeout(r, 250));
  check(`${label}：导入请求全程仅 1 次，页面不自动再次提交文件`,
    session.counts.importPosts === before + 1,
    `import posts=${session.counts.importPosts}`);
}

// 导入按钮恢复可用、已选文件保留
function checkReadyAgain(label, snap, fileName) {
  check(`${label}：导入按钮恢复可用、已选文件保留`,
    !snap.submitDisabled && snap.fileCount === 1 && snap.fileName === fileName,
    {disabled: snap.submitDisabled, files: snap.fileCount, name: snap.fileName});
}

function countBanner(snap, imported, failed) {
  return snap.banners.some(b => b.cls.includes("ok") &&
    new RegExp(`新增\\s*${imported}\\s*条`).test(b.text) &&
    new RegExp(`未导入\\s*${failed}\\s*条`).test(b.text));
}

// 成功数量的统一口径：页面不得出现与报告不符或补造的数量
function noFabricatedCounts(snap) {
  return !snap.banners.some(b => b.cls.includes("ok")) &&
    !/新增\s*\d+\s*条/.test(snap.reportText) &&
    snap.failureItems.length === 0 &&
    !/undefined|NaN|null/.test(snap.reportText);
}

function unreliableBanner(snap) {
  return snap.banners.some(b => b.cls.includes("bad") &&
    b.text.includes("无法确认") &&
    b.text.includes("核对客户列表") &&
    b.text.includes("不会自动重新提交"));
}

function listWarnBanner(snap) {
  return snap.banners.some(b => b.cls.includes("warn") &&
    b.text.includes("读取客户列表失败") &&
    b.text.includes("列表暂未更新") &&
    b.text.includes("可能不是最新") &&
    b.text.includes("稍后刷新") &&
    b.text.includes("无需重新导入"));
}

// ---------------------------------------------------------------------------
// 测试流程
// ---------------------------------------------------------------------------
async function run() {
  const {proc, port: portPromise} = startApp("main");
  let base;
  try {
    base = `http://127.0.0.1:${await portPromise}`;
    await waitReady(base);

    const [existingId, keepId] = await seed(base, [
      {name: "已有客户", source: "老客户推荐", region: "华东", industry: "制造业", date: "2020-01-15"},
      {name: "保留客户", source: "广告", region: "华北", industry: "互联网", date: "2022-12-01"},
    ]);

    const browser = await puppeteer.launch({
      executablePath: process.env.CHROME || "/usr/bin/google-chrome",
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });

    try {
      // ===================================================================
      // 场景 A：部分成功——有效与无效记录混在同一文件；带引号字段里的换行
      //         不拆成多条记录，未导入原因按原文件数据记录编号逐条展示
      // ===================================================================
      {
        const session = await openSession(browser, base);
        const {page, counts} = session;
        const init = await snapshot(page);
        check("A 初始：表格显示两名既有客户、无读取失败提示",
          init.rows.length === 2 && !init.loadErrorOn,
          {rows: init.rows, err: init.loadErrorText});

        // 记录 1 有效；记录 2 日期无效；记录 3 与已有客户重复；
        // 记录 4 名称带引号字段内换行（仍属同一条记录）；记录 5 与记录 1 文件内重复
        const csv = csvFile("partial.csv", [
          "name,source,region,industry,important_date",
          "有效甲,展会,华东,制造业,2024-01-15",
          "坏日期记录,,,,2024-13-40",
          "已有客户,,,,",
          '"带\n换行的名字",广告,华南,互联网,',
          "有效甲,,,,",
          "",
        ].join("\n"));
        const before = await importAndSettle(session, csv);
        const snap = await snapshot(page);

        check("A 部分成功：显示新增 2 条、未导入 3 条",
          countBanner(snap, 2, 3), snap.banners);
        check("A 部分成功：逐条原因按原文件数据记录编号（第 2、3、5 条，表头不计入）",
          snap.failureItems.length === 3 &&
          /^第\s*2\s*条/.test(snap.failureItems[0]) && snap.failureItems[0].includes("重要日期") &&
          /^第\s*3\s*条/.test(snap.failureItems[1]) && snap.failureItems[1].includes("已有客户") &&
          /^第\s*5\s*条/.test(snap.failureItems[2]) && snap.failureItems[2].includes("第 1 条"),
          snap.failureItems);
        check("A 部分成功：不把记录级失败说成整份拒绝或结果无法确认",
          !snap.reportText.includes("整份文件已拒绝") && !snap.reportText.includes("无法确认"),
          snap.reportText);
        check("A 部分成功：列表即时刷新出新增客户（含引号字段内换行的名称仍是一条记录）",
          snap.rows.length === 4 &&
          snap.rows.some(r => r.cells[1] === "有效甲") &&
          snap.rows.some(r => r.cells[1].includes("换行的名字")),
          snap.rows.map(r => r.cells[1]));
        check("A 部分成功：无读取失败提示与警告横幅",
          !snap.loadErrorOn && !snap.banners.some(b => b.cls.includes("warn")),
          {err: snap.loadErrorOn, banners: snap.banners});
        checkReadyAgain("A 部分成功", snap, "partial.csv");
        await checkNoResubmit(session, "A 部分成功", before);

        const real = await listClients(base);
        check("A 部分成功：后端真实新增两条（有效甲、带换行的名字），既有客户不变",
          real.clients.length === 4 &&
          real.clients.some(x => x.name === "有效甲" && x.source === "展会") &&
          real.clients.some(x => x.name === "带\n换行的名字") &&
          real.clients.find(x => x.id === existingId).source === "老客户推荐",
          real.clients.map(x => x.name));
        await page.close();
      }

      // ===================================================================
      // 场景 B：合法零结果之一——只有表头：零新增、零未导入
      // ===================================================================
      {
        const session = await openSession(browser, base);
        const {page} = session;
        const csv = csvFile("header-only.csv", "name,source,region,industry,important_date\n");
        const before = await importAndSettle(session, csv);
        const snap = await snapshot(page);

        check("B 只有表头：显示零新增、零未导入",
          countBanner(snap, 0, 0), snap.banners);
        check("B 只有表头：没有未导入明细、不说成无法确认或整份拒绝",
          snap.failureItems.length === 0 &&
          !snap.reportText.includes("无法确认") && !snap.reportText.includes("整份文件已拒绝"),
          {items: snap.failureItems, text: snap.reportText});
        check("B 只有表头：列表保持既有四名客户、无读取失败提示",
          snap.rows.length === 4 && !snap.loadErrorOn,
          {rows: snap.rows.length, err: snap.loadErrorOn});
        checkReadyAgain("B 只有表头", snap, "header-only.csv");
        await checkNoResubmit(session, "B 只有表头", before);
        check("B 只有表头：后端仍只有既有客户",
          (await listClients(base)).clients.length === 4, "后端客户数");
        await page.close();
      }

      // ===================================================================
      // 场景 C：合法零结果之二——全部记录因重复或字段问题跳过：
      //         仍显示完整数量与逐条原因，不能说成整份文件被拒绝
      // ===================================================================
      {
        const session = await openSession(browser, base);
        const {page} = session;
        const csv = csvFile("all-skipped.csv", [
          "name,important_date",
          "已有客户,",
          "坏日期乙,2023-02-29",
          ",2020-01-01",
          "",
        ].join("\n"));
        const before = await importAndSettle(session, csv);
        const snap = await snapshot(page);

        check("C 全部跳过：显示新增 0 条、未导入 3 条",
          countBanner(snap, 0, 3), snap.banners);
        check("C 全部跳过：逐条原因完整（重复、日期无效、缺少名称）",
          snap.failureItems.length === 3 &&
          /^第\s*1\s*条/.test(snap.failureItems[0]) && snap.failureItems[0].includes("重复") &&
          /^第\s*2\s*条/.test(snap.failureItems[1]) && snap.failureItems[1].includes("2023-02-29") &&
          /^第\s*3\s*条/.test(snap.failureItems[2]) && snap.failureItems[2].includes("缺少名称"),
          snap.failureItems);
        check("C 全部跳过：不说成整份文件被拒绝、不说成无法确认",
          !snap.reportText.includes("整份文件已拒绝") && !snap.reportText.includes("无法确认"),
          snap.reportText);
        checkReadyAgain("C 全部跳过", snap, "all-skipped.csv");
        await checkNoResubmit(session, "C 全部跳过", before);
        check("C 全部跳过：后端客户数不变",
          (await listClients(base)).clients.length === 4, "后端客户数");
        await page.close();
      }

      // ===================================================================
      // 场景 D：成功状态但报告不可靠——显示结果无法确认，不显示成功数量，
      //         不补造零新增报告，不出现 undefined；按钮恢复、文件保留、
      //         不重发、不触发列表读取
      // ===================================================================
      {
        const session = await openSession(browser, base);
        const {page, modes, counts} = session;
        const csv = csvFile("whatever.csv", "name\n某客户\n");
        const listGetsBefore = counts.listGets;
        const cases = [
          ["无法解析", {status: 200, body: "<<<not valid json>>>"}],
          ["回复为 null", {status: 200, body: "null"}],
          ["回复为数组", {status: 200, body: "[]"}],
          ["新增数量为负", {status: 200, body: JSON.stringify(
            {imported_count: -1, failed_count: 0, imported: [], failures: []})}],
          ["新增数量为小数", {status: 200, body: JSON.stringify(
            {imported_count: 1.5, failed_count: 0, imported: [], failures: []})}],
          ["数量为文本", {status: 200, body: JSON.stringify(
            {imported_count: "2", failed_count: "0", imported: [], failures: []})}],
          ["缺少未导入明细", {status: 200, body: JSON.stringify(
            {imported_count: 1, failed_count: 1, imported: []})}],
          ["明细条数与报告数量不符", {status: 200, body: JSON.stringify(
            {imported_count: 1, failed_count: 2, imported: [],
             failures: [{row: 1, reason: "只有一条"}]})}],
          ["记录编号为零", {status: 200, body: JSON.stringify(
            {imported_count: 0, failed_count: 1, imported: [],
             failures: [{row: 0, reason: "编号不合法"}]})}],
          ["记录编号为文本", {status: 200, body: JSON.stringify(
            {imported_count: 0, failed_count: 1, imported: [],
             failures: [{row: "2", reason: "编号不合法"}]})}],
          ["原因为空白文本", {status: 200, body: JSON.stringify(
            {imported: [], failures: [{row: 1, reason: "   "}],
             imported_count: 0, failed_count: 1})}],
          ["原因不是文本", {status: 200, body: JSON.stringify(
            {imported_count: 0, failed_count: 1, imported: [],
             failures: [{row: 1, reason: 42}]})}],
          ["非 400 的失败状态", {status: 500, body: JSON.stringify({error: "模拟的服务错误"})}],
        ];
        for (const [label, override] of cases) {
          modes.importOverride = override;
          const before = await importAndSettle(session, csv);
          const snap = await snapshot(page);
          check(`D ${label}：显示结果无法确认并提示先核对客户列表`,
            unreliableBanner(snap), snap.banners);
          check(`D ${label}：不显示成功数量、不补造零新增报告、无 undefined 内容`,
            noFabricatedCounts(snap), snap.reportText);
          check(`D ${label}：不说成整份文件已拒绝`,
            !snap.reportText.includes("整份文件已拒绝"), snap.reportText);
          checkReadyAgain(`D ${label}`, snap, "whatever.csv");
          await checkNoResubmit(session, `D ${label}`, before);
          check(`D ${label}：结果不可靠不触发列表读取`,
            counts.listGets === listGetsBefore,
            `list gets=${counts.listGets}`);
        }
        modes.importOverride = null;
        check("D 全程：后端未被任何改写过的回复写入",
          (await listClients(base)).clients.length === 4, "后端客户数");
        await page.close();
      }

      // ===================================================================
      // 场景 E：已确认有效报告后，列表读取失败（连接失败 / 无法解析 /
      //         缺少客户数组）——保留已确认结果，旧行保留，重开页面恢复
      // ===================================================================
      for (const mode of ["close", "bad-json", "no-clients"]) {
        const session = await openSession(browser, base);
        const {page, modes} = session;
        const beforeClients = (await listClients(base)).clients.length;
        const init = await snapshot(page);
        check(`E ${mode} 初始：列表显示当前 ${beforeClients} 名客户`,
          init.rows.length === beforeClients, init.rows.length);

        const unique = `读失败-${mode}`;
        const csv = csvFile(`import-${mode}.csv`, [
          "name,source",
          `${unique},展会`,
          "已有客户,",
          "",
        ].join("\n"));
        modes.list = mode;
        const before = await importAndSettle(session, csv);
        modes.list = "ok";
        const snap = await snapshot(page);

        check(`E ${mode}：已确认的新增 1 条、未导入 1 条与逐条原因全部保留`,
          countBanner(snap, 1, 1) &&
          snap.failureItems.length === 1 &&
          /^第\s*2\s*条/.test(snap.failureItems[0]) && snap.failureItems[0].includes("重复"),
          {banners: snap.banners, items: snap.failureItems});
        check(`E ${mode}：读取失败不改说结果无法确认或整份拒绝`,
          !snap.reportText.includes("无法确认") && !snap.reportText.includes("整份文件已拒绝"),
          snap.reportText);
        check(`E ${mode}：警告说明列表暂未更新、资料可能不是最新、稍后刷新、无需重新导入`,
          listWarnBanner(snap), snap.banners);
        check(`E ${mode}：页内列表读取失败提示也出现`, snap.loadErrorOn, snap.loadErrorText);
        check(`E ${mode}：此前显示的客户行保留，不清空、不改成没有客户的提示`,
          snap.rows.length === beforeClients && !snap.emptyOn &&
          snap.tableDisplay === "table" &&
          snap.rows.some(r => r.cells[1] === "已有客户") &&
          !snap.rows.some(r => r.cells[1] === unique),
          {rows: snap.rows.length, empty: snap.emptyOn, display: snap.tableDisplay});
        checkReadyAgain(`E ${mode}`, snap, `import-${mode}.csv`);
        await checkNoResubmit(session, `E ${mode}`, before);

        const real = await listClients(base);
        check(`E ${mode}：后端确已新增（结果只以导入报告为准）`,
          real.clients.length === beforeClients + 1 &&
          real.clients.some(x => x.name === unique && x.source === "展会"),
          real.clients.map(x => x.name));

        // 重新打开页面读取成功：显示实际保存的资料，撤下失败提示
        const reopened = await openSession(browser, base);
        const rsnap = await snapshot(reopened.page);
        check(`E ${mode} 重新打开：失败提示撤下、显示实际保存的资料`,
          !rsnap.loadErrorOn && rsnap.rows.length === beforeClients + 1 &&
          rsnap.rows.some(r => r.cells[1] === unique),
          {err: rsnap.loadErrorOn, rows: rsnap.rows.length});
        await page.close();
        await reopened.page.close();
      }

      // ===================================================================
      // 场景 F：正常路径——导入成功且列表读取成功，列表即时刷新
      // ===================================================================
      {
        const session = await openSession(browser, base);
        const {page} = session;
        const beforeClients = (await listClients(base)).clients.length;
        const csv = csvFile("normal.csv", [
          "name,source,region,industry,important_date",
          "正常路径客户,展会,华南,零售业,2025-05-20",
          "",
        ].join("\n"));
        const before = await importAndSettle(session, csv);
        const snap = await snapshot(page);

        check("F 正常路径：显示新增 1 条、未导入 0 条",
          countBanner(snap, 1, 0), snap.banners);
        check("F 正常路径：无警告横幅、无读取失败提示",
          !snap.banners.some(b => b.cls.includes("warn")) && !snap.loadErrorOn,
          {banners: snap.banners, err: snap.loadErrorOn});
        check("F 正常路径：列表即时刷新出新增客户及其字段",
          snap.rows.length === beforeClients + 1 &&
          snap.rows.some(r => r.cells[1] === "正常路径客户" &&
            r.cells[2] === "展会" && r.cells[5] === "2025-05-20"),
          snap.rows.map(r => r.cells));
        checkReadyAgain("F 正常路径", snap, "normal.csv");
        await checkNoResubmit(session, "F 正常路径", before);
        check("F 正常路径：后端确已新增",
          (await listClients(base)).clients.some(x => x.name === "正常路径客户"),
          "后端客户");
        await page.close();
      }

      // ===================================================================
      // 场景 G：整份文件明确拒绝（HTTP 400）——原有错误说明与资料不变的
      //         行为继续保留（缺 name 列 / CSV 结构损坏，含仓库内 bad 样例）
      // ===================================================================
      {
        const session = await openSession(browser, base);
        const {page, counts} = session;
        const beforeClients = (await listClients(base)).clients.length;
        const listGetsBefore = counts.listGets;

        const noName = csvFile("no-name.csv", "source,region\n展会,华东\n");
        let before = await importAndSettle(session, noName);
        let snap = await snapshot(page);
        check("G 缺 name 列：显示整份文件已拒绝、没有新增、资料保持原样及具体原因",
          snap.banners.some(b => b.cls.includes("bad") &&
            b.text.includes("整份文件已拒绝导入") &&
            b.text.includes("没有新增客户") &&
            b.text.includes("保持原样") &&
            b.text.includes("缺少名称列")),
          snap.banners);
        check("G 缺 name 列：不显示成功数量、不说成无法确认",
          noFabricatedCounts(snap) && !snap.reportText.includes("无法确认"),
          snap.reportText);
        check("G 缺 name 列：不触发列表读取、既有客户行保留",
          counts.listGets === listGetsBefore && snap.rows.length === beforeClients,
          {gets: counts.listGets, rows: snap.rows.length});
        checkReadyAgain("G 缺 name 列", snap, "no-name.csv");
        await checkNoResubmit(session, "G 缺 name 列", before);

        // 仓库自带的结构损坏样例：结束引号后有多余字符
        before = await importAndSettle(session, join(HERE, "bad2.csv"));
        snap = await snapshot(page);
        check("G 结构损坏：显示整份文件已拒绝及结构损坏原因",
          snap.banners.some(b => b.cls.includes("bad") &&
            b.text.includes("整份文件已拒绝导入") &&
            b.text.includes("结构损坏")),
          snap.banners);
        check("G 结构损坏：不显示成功数量、既有客户行保留",
          noFabricatedCounts(snap) && snap.rows.length === beforeClients,
          {text: snap.reportText, rows: snap.rows.length});
        checkReadyAgain("G 结构损坏", snap, "bad2.csv");
        await checkNoResubmit(session, "G 结构损坏", before);
        check("G 全程：后端客户资料不变",
          (await listClients(base)).clients.length === beforeClients, "后端客户数");
        await page.close();
      }

      // ===================================================================
      // 场景 H：新增数量只以导入报告为准，不凭客户列表的变化推算
      //         （报告 7 新增 1 未导入，列表行数与此无关）
      // ===================================================================
      {
        const session = await openSession(browser, base);
        const {page, modes} = session;
        const csv = csvFile("count-from-report.csv", "name,source\n不计数客户,展会\n");
        modes.importOverride = {status: 200, body: JSON.stringify({
          imported_count: 7,
          failed_count: 1,
          imported: [],
          failures: [{row: 3, reason: "模拟的未导入原因"}],
        })};
        const before = await importAndSettle(session, csv);
        const snap = await snapshot(page);

        check("H 数量以报告为准：显示报告的新增 7 条、未导入 1 条，不按列表行数推算",
          countBanner(snap, 7, 1), snap.banners);
        check("H 数量以报告为准：逐条原因按报告展示（第 3 条）",
          snap.failureItems.length === 1 &&
          /^第\s*3\s*条/.test(snap.failureItems[0]) &&
          snap.failureItems[0].includes("模拟的未导入原因"),
          snap.failureItems);
        check("H 数量以报告为准：不说成无法确认或整份拒绝",
          !snap.reportText.includes("无法确认") && !snap.reportText.includes("整份文件已拒绝"),
          snap.reportText);
        checkReadyAgain("H 数量以报告为准", snap, "count-from-report.csv");
        await checkNoResubmit(session, "H 数量以报告为准", before);
        await page.close();
      }

      await browser.close();
    } finally {
      // 主进程在下面统一回收
    }
  } finally {
    await stopApp({proc});
    rmSync(TMP, {recursive: true, force: true});
  }

  console.log(`\n${"=".repeat(50)}`);
  if (FAILURES.length) {
    console.log(`${FAILURES.length} / ${checkCount} 项断言失败：`);
    for (const {label, detail} of FAILURES) console.log(" -", label, detail ? `（${detail}）` : "");
    process.exitCode = 1;
  } else {
    console.log(`全部通过（共 ${checkCount} 项页面层面断言）`);
  }
}

run().catch(err => {
  console.error("测试运行出错：", err);
  process.exit(1);
});

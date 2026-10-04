#!/usr/bin/env node
/**
 * 首页 CSV 导入结果展示的页面层面回归保障。
 *
 * 启动真实 app.py 服务（与 smoke_test.py / page_test.mjs 同一后端，不模拟、
 * 不改动接口公开行为与现有导入规则），用 Puppeteer 驱动系统 Chrome 打开首页，
 * 用真实文件选择框上传 CSV；对「服务返回内容」和「导入后的客户列表读取」分别
 * 做请求拦截，逐项验证页面严格区分「拿到完整可靠的导入报告」与「只收到成功
 * 状态、结果无法确认」：
 *
 * A. 完整有效报告：显示报告里的新增/未导入数量，按原文件数据记录编号逐条展示
 *    原因（表头不计编号，引号字段内换行不拆记录）；覆盖有效/无效混在同一文件
 *    的部分成功、仅表头的合法零新增、全部因重复或字段问题跳过（不得说成整份
 *    文件被拒绝）；
 * B. 成功状态但回复无法解析、数量不是非负整数（负数/小数/文本/布尔/缺失）、
 *    未导入明细缺失或条数不符、明细编号不是正整数或原因不是非空文本：一律
 *    显示结果无法确认，提示先核对客户列表再决定是否重新导入；不显示成功数量，
 *    不补造零新增/空明细，页面不出现 undefined/NaN；页面也不能凭客户列表的
 *    行数推算新增数量；
 * C. 已取得有效报告后，随后的客户列表读取失败（连接失败 / 500 / 无法解析 /
 *    缺少 clients 数组）不改变已确认的数量与逐条原因：附加列表暂未更新、
 *    资料可能不是最新、稍后刷新即可、无需重新导入的提示；旧客户行保留，不被
 *    清空、不显示空列表提示；重新打开读取成功后显示实际保存的资料；
 * D. 结果处理结束后导入按钮恢复可用、已选文件保留、不会自动再次提交；
 * E. 正常导入并成功刷新列表的路径，以及整份文件被明确拒绝（HTTP 400）时
 *    原有错误说明与资料不变的行为继续保留；网络失败与其他非成功状态同样按
 *    「无法确认」处理。
 */
import {spawn} from "node:child_process";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";
import {mkdtempSync, mkdirSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import puppeteer from "puppeteer";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, "app.py");
const TMP = mkdtempSync(join(tmpdir(), "clientbook-import-page-"));
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

const norm = s => (s || "").replace(/[ \t\r\n]+/g, " ").trim();

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

async function startServer(label) {
  const {proc, port: portPromise} = startApp(label);
  const base = `http://127.0.0.1:${await portPromise}`;
  await waitReady(base);
  return {proc, base};
}

// ---------------------------------------------------------------------------
// CSV 构造与后端直连准备数据
// ---------------------------------------------------------------------------
const csvField = v => `"${String(v).replace(/"/g, '""')}"`;
const buildCsv = (header, rows) =>
  header.map(csvField).join(",") + "\n" +
  rows.map(r => r.map(csvField).join(",")).join("\n") + "\n";

async function importCsvDirect(base, csv) {
  const res = await fetch(base + "/api/clients/import", {method: "POST", body: csv});
  const data = await res.json();
  if (res.status !== 200) throw new Error("seed 失败：" + JSON.stringify(data));
  return data;
}

async function seed(base, names) {
  const csv = buildCsv(["name"], names.map(n => [n]));
  const data = await importCsvDirect(base, csv);
  return new Map(data.imported.map(x => [x.name, x.id]));
}

async function listClients(base) {
  const res = await fetch(base + "/api/clients");
  return res.json();
}

// ---------------------------------------------------------------------------
// 页面驱动：拦截导入请求与导入后的客户列表读取
// ---------------------------------------------------------------------------
async function openSession(browser, base) {
  const page = await browser.newPage();
  const modes = {
    // ok 正常转发；close 连接断开；500 非成功状态；bad-json 无法解析；
    // no-clients 可解析但缺少客户数组
    list: "ok",
    // importOverride：null = 走真实后端；否则用给定 {status, body, contentType}
    importOverride: null,
    // importAbort 为 true 时直接断开导入请求（模拟网络错误）
    importAbort: false,
  };
  const counts = {importPosts: 0, listGets: 0};

  await page.setRequestInterception(true);
  page.on("request", request => {
    const url = request.url();
    if (request.method() === "GET" && url.endsWith("/api/clients")) {
      counts.listGets += 1;
      if (modes.list === "close") { request.abort("failed"); return; }
      if (modes.list === "500") {
        request.respond({status: 500, contentType: "application/json; charset=utf-8",
          body: JSON.stringify({error: "模拟的服务错误"})});
        return;
      }
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
      if (modes.importAbort) { request.abort("failed"); return; }
      if (modes.importOverride) {
        const {status, body, contentType} = modes.importOverride;
        request.respond({
          status,
          contentType: contentType || "application/json; charset=utf-8",
          body,
        });
        return;
      }
    }
    request.continue();
  });

  await page.setCacheEnabled(false);
  await page.goto(base + "/", {waitUntil: "networkidle0"});
  return {page, modes, counts};
}

// 读取导入区域与客户列表的全部可见状态
async function importSnap(page) {
  return page.evaluate(() => {
    const text = sel => document.querySelector(sel)?.textContent.trim() ?? null;
    const report = document.getElementById("report");
    return {
      reportVisible: report.style.display === "block",
      banners: [...report.querySelectorAll(".banner")].map(b => ({
        cls: b.className,
        text: b.innerText.replace(/[ \t\r\n]+/g, " ").trim(),
      })),
      reportText: report.innerText.replace(/[ \t\r\n]+/g, " ").trim(),
      failureItems: [...report.querySelectorAll(".failures li")]
        .map(li => li.innerText.replace(/[ \t\r\n]+/g, " ").trim()),
      failuresTitle: (() => {
        const p = report.querySelector(".failures p");
        return p ? p.innerText.replace(/[ \t\r\n]+/g, " ").trim() : null;
      })(),
      filename: text("#filename"),
      submitText: text("#submit-btn"),
      submitDisabled: document.getElementById("submit-btn").disabled,
      fileCount: document.getElementById("file-input").files.length,
      rows: [...document.querySelectorAll("#clients-body tr")].map(tr => ({
        id: tr.dataset.id,
        // td: 0 勾选框, 1 编号, 2 名称, 3 来源, 4 地区, 5 行业, 6 重要日期
        cells: [...tr.querySelectorAll("td")].slice(2).map(td => td.textContent.trim()),
      })),
      emptyOn: document.getElementById("clients-empty").classList.contains("on"),
      tableDisplay: getComputedStyle(document.getElementById("clients-table")).display,
      loadErrorOn: document.getElementById("clients-load-error").classList.contains("on"),
      loadErrorText: text("#clients-load-error"),
    };
  });
}

async function uploadCsv(page, name, content) {
  // 此版本 Puppeteer 的 uploadFile 只接受本地路径：写到临时目录再通过真实文件选择框上传
  const dir = join(TMP, "uploads");
  mkdirSync(dir, {recursive: true});
  const path = join(dir, name);
  writeFileSync(path, content, "utf8");
  const input = await page.$("#file-input");
  await input.uploadFile(path);
  await page.waitForFunction(name => document.getElementById("filename").textContent === name,
    {}, name);
}

async function submitImport(session) {
  const {page, counts} = session;
  const before = counts.importPosts;
  await page.click("#submit-btn");
  await page.waitForSelector("#report .banner", {timeout: 5000});
  // 结果处理结束后导入按钮必须恢复可用
  await page.waitForFunction(() => !document.getElementById("submit-btn").disabled,
    {timeout: 5000});
  await new Promise(r => setTimeout(r, 80)); // 让横幅/列表渲染稳定
  return before;
}

// ---- 报告口径断言 ----------------------------------------------------------

// 成功报告横幅：「新增 X 条，未导入 Y 条。」
function successBanner(snap, imported, failed) {
  return snap.banners.some(b => b.cls.includes("ok") &&
    new RegExp(`新增\\s*${imported}\\s*条，未导入\\s*${failed}\\s*条`).test(b.text));
}

// 「结果无法确认」横幅的共同口径
function expectUnconfirmed(snap, ctx) {
  check(`${ctx}：只有一条错误横幅、无成功/警告横幅`,
    snap.banners.length === 1 && snap.banners[0].cls.includes("bad") &&
    !snap.banners.some(b => b.cls.includes("ok") || b.cls.includes("warn")),
    snap.banners);
  check(`${ctx}：提示结果无法确认、先核对客户列表、再决定是否重新导入`,
    /无法确认/.test(snap.reportText) &&
    snap.reportText.includes("核对客户列表") &&
    snap.reportText.includes("重新导入"),
    snap.reportText);
  check(`${ctx}：不显示任何成功数量（不补造零新增/空明细）`,
    !/新增\s*\d+\s*条/.test(snap.reportText) &&
    !/未导入\s*\d+\s*条/.test(snap.reportText),
    snap.reportText);
  check(`${ctx}：不渲染未导入明细、页面没有 undefined/NaN/[object Object]`,
    snap.failureItems.length === 0 && !snap.failuresTitle &&
    !/undefined|NaN|\[object Object\]/.test(snap.reportText),
    {items: snap.failureItems, text: snap.reportText});
}

function expectButtonAndFileKept(snap, ctx, filename, session) {
  check(`${ctx}：导入按钮恢复可用且文案仍是「导入」`,
    !snap.submitDisabled && snap.submitText === "导入",
    {disabled: snap.submitDisabled, text: snap.submitText});
  check(`${ctx}：已选文件保留（文件名与 file input 都在）`,
    snap.fileCount === 1 && snap.filename === filename,
    {count: snap.fileCount, filename: snap.filename});
  check(`${ctx}：处理结束后不会自动再次提交文件`,
    session.counts.importPosts === 1, `posts=${session.counts.importPosts}`);
}

// ---------------------------------------------------------------------------
// 测试流程
// ---------------------------------------------------------------------------
async function run() {
  const browser = await puppeteer.launch({
    executablePath: process.env.CHROME || "/usr/bin/google-chrome",
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });

  const servers = [];
  try {
    // ===================================================================
    // 场景 A：正常导入并成功刷新列表
    // ===================================================================
    {
      const server = await startServer("normal");
      servers.push(server);
      const {base} = server;
      const seeded = await seed(base, ["已有客户"]);

      const session = await openSession(browser, base);
      const {page} = session;
      const init = await importSnap(page);
      check("A 初始：列表显示一名已有客户、无报告、导入按钮可用",
        init.rows.length === 1 && !init.reportVisible && !init.submitDisabled &&
        init.fileCount === 0, init.rows);

      const csv = buildCsv(
        ["name", "source", "region", "industry", "important_date"],
        [
          ["新客户甲", "展会", "华东", "制造业", "2024-01-01"],
          ["新客户乙", "网络", "华南", "零售业", "2024-05-05"],
        ]);
      await uploadCsv(page, "normal.csv", csv);
      const before = await submitImport(session);
      const snap = await importSnap(page);

      check("A 正常路径：按报告显示新增 2 条、未导入 0 条",
        successBanner(snap, 2, 0), snap.banners);
      check("A 正常路径：零条未导入时不渲染明细区块",
        snap.failureItems.length === 0 && !snap.failuresTitle, snap.reportText);
      check("A 正常路径：无读取失败提示与警告横幅、表格刷新为三名客户",
        !snap.loadErrorOn && !snap.banners.some(b => b.cls.includes("warn")) &&
        snap.rows.length === 3 && snap.rows.some(r => r.cells[0] === "新客户甲") &&
        snap.rows.some(r => r.cells[0] === "新客户乙"),
        {err: snap.loadErrorOn, rows: snap.rows.map(r => r.cells[0])});
      expectButtonAndFileKept(snap, "A 正常路径", "normal.csv", session);

      await new Promise(r => setTimeout(r, 250));
      check("A 正常路径：等待后仍未自动重发（全程仅 1 次导入请求）",
        session.counts.importPosts === before + 1, `posts=${session.counts.importPosts}`);

      // 重新打开页面：读取成功，显示实际保存的资料
      const reopened = await openSession(browser, base);
      const rsnap = await importSnap(reopened.page);
      check("A 重新打开：三名客户真实落库、导入报告区为初始隐藏状态",
        rsnap.rows.length === 3 && !rsnap.reportVisible,
        rsnap.rows.map(r => r.cells[0]));
      check("A 重新打开：导入请求不会因打开页面自动发出",
        reopened.counts.importPosts === 0, `posts=${reopened.counts.importPosts}`);
      await page.close();
      await reopened.page.close();
    }

    // ===================================================================
    // 场景 B：合法的零新增——只有表头
    // ===================================================================
    {
      const server = await startServer("zero");
      servers.push(server);
      const {base} = server;
      const session = await openSession(browser, base);
      const {page} = session;

      const csv = "name,source,region,industry,important_date\n";
      await uploadCsv(page, "header-only.csv", csv);
      await submitImport(session);
      const snap = await importSnap(page);

      check("B 仅表头：显示新增 0 条、未导入 0 条",
        successBanner(snap, 0, 0), snap.banners);
      check("B 仅表头：不渲染未导入明细区块",
        snap.failureItems.length === 0 && !snap.failuresTitle, snap.reportText);
      check("B 仅表头：不能说成拒绝/无法确认，成功横幅在",
        snap.banners.some(b => b.cls.includes("ok")) &&
        !/拒绝|无法确认/.test(snap.reportText), snap.reportText);
      check("B 仅表头：真实空列表正常显示「还没有客户记录」、表格隐藏",
        snap.emptyOn && snap.rows.length === 0 && snap.tableDisplay !== "table",
        {empty: snap.emptyOn, rows: snap.rows.length, display: snap.tableDisplay});
      expectButtonAndFileKept(snap, "B 仅表头", "header-only.csv", session);

      const real = await listClients(base);
      check("B 仅表头：后端确无客户落库", real.clients.length === 0, real.clients);
      await page.close();
    }

    // ===================================================================
    // 场景 C：有效/无效记录混在同一文件的部分成功
    //         重复、字段错误、文件内重名与引号字段内换行同时覆盖，
    //         失败编号按数据记录（表头不计、引号内换行不拆记录）
    // ===================================================================
    {
      const server = await startServer("partial");
      servers.push(server);
      const {base} = server;
      const seeded = await seed(base, ["种子甲"]);
      const seedId = seeded.get("种子甲");

      const session = await openSession(browser, base);
      const {page} = session;

      // 数据记录编号：
      //   1 新甲                 -> 新增
      //   2 种子甲               -> 与已有客户重复
      //   3 新乙/非法日期        -> 字段错误
      //   4 "跨行\n客户"         -> 引号字段内换行：仍只是第 4 条，新增
      //   5 新甲                 -> 与文件内第 1 条重复
      const csv = buildCsv(
        ["name", "source", "region", "industry", "important_date"],
        [
          ["新甲", "展会", "华东", "制造业", "2024-01-01"],
          ["种子甲", "广告", "", "", ""],
          ["新乙", "", "", "", "2025-13-40"],
          ["跨行\n客户", "网络", "华南", "零售业", "2024-05-05"],
          ["新甲", "", "", "", ""],
        ]);
      await uploadCsv(page, "partial.csv", csv);
      await submitImport(session);
      const snap = await importSnap(page);

      check("C 部分成功：按报告显示新增 2 条、未导入 3 条",
        successBanner(snap, 2, 3), snap.banners);
      check("C 部分成功：不能说成整份文件拒绝",
        !/整份文件|拒绝/.test(snap.reportText), snap.reportText);
      check("C 部分成功：明细标题说明编号按原文件数据记录、表头不计入",
        snap.failuresTitle && snap.failuresTitle.includes("表头不计入"),
        snap.failuresTitle);
      check("C 部分成功：恰好三条原因，编号为第 2/3/5 条（引号内换行不拆记录）",
        snap.failureItems.length === 3 &&
        /第\s*2\s*条/.test(snap.failureItems[0]) &&
        /第\s*3\s*条/.test(snap.failureItems[1]) &&
        /第\s*5\s*条/.test(snap.failureItems[2]),
        snap.failureItems);
      check("C 部分成功：第 2 条说明与已有客户重复并给出已有编号",
        snap.failureItems[0].includes("重复") &&
        snap.failureItems[0].includes(String(seedId)),
        snap.failureItems[0]);
      check("C 部分成功：第 3 条说明日期字段问题（2025-13-40 不是真实日期）",
        snap.failureItems[1].includes("2025-13-40") &&
        snap.failureItems[1].includes("日期"),
        snap.failureItems[1]);
      check("C 部分成功：第 5 条说明与文件内第 1 条记录重复",
        snap.failureItems[2].includes("文件内第 1 条") ||
        /文件内第\s*1\s*条/.test(snap.failureItems[2]),
        snap.failureItems[2]);
      check("C 部分成功：引号内换行的第 4 条作为单条客户新增（换行不拆成多条）",
        snap.rows.some(r => r.cells[0].replace(/\s+/g, "") === "跨行客户") &&
        snap.rows.filter(r => r.cells[0].includes("跨行")).length === 1,
        snap.rows.map(r => r.cells[0]));
      check("C 部分成功：列表刷新为 3 名客户（种子甲、新甲、跨行客户），新乙未入库",
        snap.rows.length === 3 &&
        snap.rows.some(r => r.cells[0] === "新甲") &&
        snap.rows.some(r => r.cells[0] === "种子甲") &&
        !snap.rows.some(r => r.cells[0] === "新乙"),
        snap.rows.map(r => r.cells[0]));
      expectButtonAndFileKept(snap, "C 部分成功", "partial.csv", session);

      const real = await listClients(base);
      check("C 部分成功：后端实际新增 2 名、非法日期记录未落库",
        real.clients.length === 3 &&
        real.clients.some(x => x.name === "跨行\n客户") &&
        !real.clients.some(x => x.name === "新乙"),
        real.clients.map(x => x.name));
      await page.close();
    }

    // ===================================================================
    // 场景 D：全部记录因重复/字段问题跳过——0 新增、N 未导入，
    //         仍显示完整数量与原因，不能说成整份文件被拒绝
    // ===================================================================
    {
      const server = await startServer("allskip");
      servers.push(server);
      const {base} = server;
      const seeded = await seed(base, ["种子甲"]);
      const seedId = seeded.get("种子甲");

      const session = await openSession(browser, base);
      const {page} = session;

      // 第 1 条与已有客户重复；第 2 条名称为空白（字段问题）
      const csv = buildCsv(["name"], [["种子甲"], ["   "]]);
      await uploadCsv(page, "all-skipped.csv", csv);
      await submitImport(session);
      const snap = await importSnap(page);

      check("D 全部跳过：仍按成功报告显示新增 0 条、未导入 2 条",
        successBanner(snap, 0, 2), snap.banners);
      check("D 全部跳过：不能说成整份文件被拒绝/资料保持原样",
        !/整份文件|拒绝|保持原样/.test(snap.reportText), snap.reportText);
      check("D 全部跳过：逐条给出两条原因（重复含已有编号、缺少名称）",
        snap.failureItems.length === 2 &&
        /第\s*1\s*条/.test(snap.failureItems[0]) &&
        snap.failureItems[0].includes("重复") &&
        snap.failureItems[0].includes(String(seedId)) &&
        /第\s*2\s*条/.test(snap.failureItems[1]) &&
        snap.failureItems[1].includes("名称"),
        snap.failureItems);
      check("D 全部跳过：列表仍是原来的一名客户，不被清空",
        snap.rows.length === 1 && snap.rows[0].cells[0] === "种子甲" && !snap.emptyOn,
        snap.rows.map(r => r.cells[0]));
      expectButtonAndFileKept(snap, "D 全部跳过", "all-skipped.csv", session);

      const real = await listClients(base);
      check("D 全部跳过：后端客户数不变（仍为 1）", real.clients.length === 1,
        real.clients.map(x => x.name));
      await page.close();
    }

    // ===================================================================
    // 场景 E：已取得有效报告后，随后的客户列表读取失败（四种破坏方式）
    //         ——成功数量、未导入数量与逐条原因保持不变，旧客户行保留
    // ===================================================================
    for (const mode of ["close", "500", "bad-json", "no-clients"]) {
      const server = await startServer("postfail-" + mode);
      servers.push(server);
      const {base} = server;

      // close 模式用场景 C 的部分成功文件：连逐条原因一起验证保留；
      // 其余模式用单条新增文件，聚焦数量与旧行保留。
      const partial = mode === "close";
      const seeded = await seed(base, partial ? ["种子甲"] : ["保留行甲", "保留行乙"]);
      const ctx0 = `E 列表读取失败(${mode})`;

      const session = await openSession(browser, base);
      const {page, modes} = session;
      const beforeRows = (await importSnap(page)).rows.map(r => r.cells[0]);

      let filename;
      if (partial) {
        filename = "partial-after.csv";
        await uploadCsv(page, filename, buildCsv(
          ["name", "source", "region", "industry", "important_date"],
          [
            ["新甲", "展会", "华东", "制造业", "2024-01-01"],
            ["种子甲", "广告", "", "", ""],
            ["新乙", "", "", "", "2025-13-40"],
            ["跨行\n客户", "网络", "华南", "零售业", "2024-05-05"],
            ["新甲", "", "", "", ""],
          ]));
      } else {
        filename = "one-new-" + mode + ".csv";
        await uploadCsv(page, filename, buildCsv(
          ["name", "important_date"],
          [[`新客-${mode}`, "2024-03-03"]]));
      }

      modes.list = mode;
      await submitImport(session);
      modes.list = "ok";
      const snap = await importSnap(page);

      if (partial) {
        check(`${ctx0}：成功报告仍显示新增 2 条、未导入 3 条`,
          successBanner(snap, 2, 3), snap.banners);
        check(`${ctx0}：三条未导入原因原样保留`,
          snap.failureItems.length === 3 &&
          /第\s*2\s*条/.test(snap.failureItems[0]) &&
          /第\s*3\s*条/.test(snap.failureItems[1]) &&
          /第\s*5\s*条/.test(snap.failureItems[2]),
          snap.failureItems);
      } else {
        check(`${ctx0}：成功报告仍显示新增 1 条、未导入 0 条`,
          successBanner(snap, 1, 0), snap.banners);
        check(`${ctx0}：不冒出空的未导入明细`, snap.failureItems.length === 0,
          snap.failureItems);
      }
      check(`${ctx0}：成功结论不被改说成失败/拒绝/无法确认`,
        snap.banners.some(b => b.cls.includes("ok")) &&
        !/无法确认|整份文件|拒绝导入/.test(snap.reportText),
        snap.banners);
      check(`${ctx0}：警告说明列表暂未更新、资料可能不是最新、稍后刷新即可、无需重新导入`,
        snap.banners.some(b => b.cls.includes("warn") &&
          b.text.includes("导入后读取客户列表失败") &&
          b.text.includes("列表暂未更新") &&
          b.text.includes("可能不是最新") &&
          /稍后.*刷新/.test(b.text) &&
          b.text.includes("无需重新导入")),
        snap.banners);
      check(`${ctx0}：页内列表读取失败提示出现`, snap.loadErrorOn, snap.loadErrorText);
      check(`${ctx0}：此前显示的客户行全部保留、不被清空`,
        snap.rows.length === beforeRows.length &&
        JSON.stringify(snap.rows.map(r => r.cells[0])) === JSON.stringify(beforeRows),
        {before: beforeRows, now: snap.rows.map(r => r.cells[0])});
      check(`${ctx0}：不显示空列表提示、表格仍可见`,
        !snap.emptyOn && snap.tableDisplay === "table",
        {empty: snap.emptyOn, display: snap.tableDisplay});
      expectButtonAndFileKept(snap, ctx0, filename, session);

      // 后端实际已落库——成功结论只取决于已确认的报告
      const real = await listClients(base);
      if (partial) {
        check(`${ctx0}：后端实际新增 2 名（含跨行客户）`,
          real.clients.length === 3 &&
          real.clients.some(x => x.name === "跨行\n客户"),
          real.clients.map(x => x.name));
      } else {
        check(`${ctx0}：后端实际新增 1 名`,
          real.clients.length === 3 && real.clients.some(x => x.name === `新客-${mode}`),
          real.clients.map(x => x.name));
      }

      // 重新打开页面读取成功：显示实际保存的资料、撤下失败提示、报告区重置
      const reopened = await openSession(browser, base);
      const rsnap = await importSnap(reopened.page);
      check(`${ctx0}：重新打开后读取失败提示撤下、显示真实客户数`,
        !rsnap.loadErrorOn &&
        rsnap.rows.length === real.clients.length &&
        rsnap.rows.some(r => r.cells[0].replace(/\s+/g, "") ===
          (partial ? "跨行客户" : `新客-${mode}`)),
        {err: rsnap.loadErrorOn, rows: rsnap.rows.map(r => r.cells[0])});
      check(`${ctx0}：重新打开后报告区为初始隐藏状态`,
        !rsnap.reportVisible && rsnap.banners.length === 0, rsnap.banners);
      check(`${ctx0}：重新打开不会自动重新导入`,
        reopened.counts.importPosts === 0, `posts=${reopened.counts.importPosts}`);
      await page.close();
      await reopened.page.close();
    }

    // ===================================================================
    // 场景 F：成功状态但报告不可靠——数量/明细各种不合规
    //         页面不能凭客户列表行数推算新增数量
    // ===================================================================
    {
      const server = await startServer("malformed");
      servers.push(server);
      const {base} = server;
      // 预置两名客户：不可靠报告后列表仍显示两名，页面不得据此显示「新增 2 条」
      await seed(base, ["原有甲", "原有乙"]);

      // 每份文件本身合法，但拦截导入响应，返回各种「HTTP 200 却不可靠」的报告
      const validFile = buildCsv(["name"], [["不会到达后端的新客户"]]);
      const cases = [
        {name: "回复无法解析", body: "<<<not valid json>>>", phrase: "回复内容无法解析"},
        {name: "数量为负数", json: {imported_count: -1, failed_count: 0, failures: []}},
        {name: "数量为小数", json: {imported_count: 1, failed_count: 0.5, failures: []}},
        {name: "数量为文本", json: {imported_count: "2", failed_count: 0, failures: []}},
        {name: "数量为布尔", json: {imported_count: true, failed_count: 0, failures: []}},
        {name: "数量缺失", json: {failed_count: 0, failures: []}},
        {name: "未导入明细缺失", json: {imported_count: 1, failed_count: 0}},
        {name: "明细条数与数量不符",
          json: {imported_count: 0, failed_count: 2, failures: [{row: 1, reason: "x"}]}},
        {name: "明细不是数组",
          json: {imported_count: 0, failed_count: 0, failures: {}}},
        {name: "记录编号为 0",
          json: {imported_count: 0, failed_count: 1,
            failures: [{row: 0, reason: "某原因"}]}},
        {name: "记录编号为负数",
          json: {imported_count: 0, failed_count: 1,
            failures: [{row: -3, reason: "某原因"}]}},
        {name: "记录编号为小数",
          json: {imported_count: 0, failed_count: 1,
            failures: [{row: 1.5, reason: "某原因"}]}},
        {name: "记录编号为文本",
          json: {imported_count: 0, failed_count: 1,
            failures: [{row: "2", reason: "某原因"}]}},
        {name: "原因为空文本",
          json: {imported_count: 0, failed_count: 1, failures: [{row: 1, reason: ""}]}},
        {name: "原因为纯空白",
          json: {imported_count: 0, failed_count: 1, failures: [{row: 1, reason: "   "}]}},
        {name: "原因缺失",
          json: {imported_count: 0, failed_count: 1, failures: [{row: 1}]}},
        {name: "整条明细不是对象",
          json: {imported_count: 0, failed_count: 1, failures: [null]}},
        {name: "回复为 null", json: null},
        {name: "回复是数组", json: []},
      ];

      for (const c of cases) {
        const ctx = `F 不可靠报告（${c.name}）`;
        const session = await openSession(browser, base);
        const {page, modes} = session;
        const init = await importSnap(page);
        check(`${ctx}：初始列表为两名原有客户`, init.rows.length === 2,
          init.rows.map(r => r.cells[0]));

        await uploadCsv(page, "bad-report.csv", validFile);
        modes.importOverride = {
          status: 200,
          body: Object.prototype.hasOwnProperty.call(c, "body")
            ? c.body
            : JSON.stringify(c.json),
        };
        await submitImport(session);
        modes.importOverride = null;
        const snap = await importSnap(page);

        expectUnconfirmed(snap, ctx);
        check(`${ctx}：说明已返回成功状态但结果无法确认、不能按零新增补算`,
          snap.reportText.includes("成功状态") &&
          snap.reportText.includes("不能按零新增"),
          snap.reportText);
        if (c.phrase) {
          check(`${ctx}：指明具体问题（${c.phrase}）`,
            snap.reportText.includes(c.phrase), snap.reportText);
        }
        check(`${ctx}：不凭客户列表行数推算新增数量（列表两名客户≠新增 2 条）`,
          snap.rows.length === 2 && !/新增\s*2\s*条/.test(snap.reportText),
          {rows: snap.rows.map(r => r.cells[0]), text: snap.reportText});
        check(`${ctx}：不显示空列表提示、旧客户行保留`,
          !snap.emptyOn && snap.rows.map(r => r.cells[0])
            .every((n, i) => n === ["原有甲", "原有乙"][i]),
          snap.rows.map(r => r.cells[0]));
        expectButtonAndFileKept(snap, ctx, "bad-report.csv", session);

        await new Promise(r => setTimeout(r, 200));
        check(`${ctx}：之后也不自动重新导入`,
          session.counts.importPosts === 1, `posts=${session.counts.importPosts}`);
        await page.close();
      }

      // 所有不可靠报告的请求都被拦截，后端数据从未被修改
      const real = await listClients(base);
      check("F 收尾：十九份不可靠报告均未触达后端，客户仍是原来的两名",
        real.clients.length === 2 &&
        real.clients.map(x => x.name).join("|") === "原有甲|原有乙",
        real.clients.map(x => x.name));
    }

    // ===================================================================
    // 场景 G：整份文件明确拒绝（真实 HTTP 400）、网络失败与其他非成功状态
    // ===================================================================
    {
      const server = await startServer("reject");
      servers.push(server);
      const {base} = server;
      await seed(base, ["拒绝前已有客户"]);

      // G1 导入请求网络失败：无法确认
      {
        const session = await openSession(browser, base);
        const {page, modes} = session;
        await uploadCsv(page, "network.csv", buildCsv(["name"], [["网络失败新客"]]));
        modes.importAbort = true;
        await submitImport(session);
        modes.importAbort = false;
        const snap = await importSnap(page);

        expectUnconfirmed(snap, "G 网络失败");
        check("G 网络失败：说明是导入请求失败、不声称资料一定未变",
          snap.reportText.includes("导入请求失败"), snap.reportText);
        check("G 网络失败：旧客户行保留、不显示空列表提示",
          snap.rows.length === 1 && snap.rows[0].cells[0] === "拒绝前已有客户" &&
          !snap.emptyOn, snap.rows.map(r => r.cells[0]));
        expectButtonAndFileKept(snap, "G 网络失败", "network.csv", session);
        await page.close();
      }

      // G2 HTTP 500：即使回复可解析，也按无法确认处理
      {
        const session = await openSession(browser, base);
        const {page, modes} = session;
        await uploadCsv(page, "five-hundred.csv", buildCsv(["name"], [["500 新客"]]));
        modes.importOverride = {status: 500, body: JSON.stringify({error: "模拟的服务错误"})};
        await submitImport(session);
        modes.importOverride = null;
        const snap = await importSnap(page);

        expectUnconfirmed(snap, "G 500");
        check("G 500：提示包含 HTTP 500 与服务错误说明",
          snap.reportText.includes("HTTP 500") && snap.reportText.includes("模拟的服务错误"),
          snap.reportText);
        check("G 500：不按整份文件拒绝口径展示",
          !/整份文件/.test(snap.reportText), snap.reportText);
        expectButtonAndFileKept(snap, "G 500", "five-hundred.csv", session);
        await page.close();
      }

      // G3 真实 HTTP 400：整份文件拒绝，错误说明与资料不变
      {
        const session = await openSession(browser, base);
        const {page} = session;
        // 与 bad1.csv 同类的结构损坏：未加引号字段中出现双引号（第 1 条数据记录）
        const badCsv = 'name,source\n甲"乙,展会\n';
        await uploadCsv(page, "bad1.csv", badCsv);
        await submitImport(session);
        const snap = await importSnap(page);

        check("G 400：显示整份文件已拒绝、本次没有新增客户、原有资料保持原样",
          snap.banners.length === 1 && snap.banners[0].cls.includes("bad") &&
          snap.reportText.includes("整份文件已拒绝导入") &&
          snap.reportText.includes("本次没有新增客户") &&
          snap.reportText.includes("原有客户资料保持原样"),
          snap.banners);
        check("G 400：给出后端的具体拒绝原因（双引号结构问题、定位到第 1 条记录）",
          snap.reportText.includes("双引号") && snap.reportText.includes("第 1 条"),
          snap.reportText);
        check("G 400：不显示成功数量、不显示无法确认口径",
          !/新增\s*\d+\s*条/.test(snap.reportText) && !/无法确认/.test(snap.reportText),
          snap.reportText);
        check("G 400：旧表仍是拒绝前的一名客户、无空列表/读取失败提示",
          snap.rows.length === 1 && snap.rows[0].cells[0] === "拒绝前已有客户" &&
          !snap.emptyOn && !snap.loadErrorOn,
          {rows: snap.rows.map(r => r.cells[0]), err: snap.loadErrorOn});
        expectButtonAndFileKept(snap, "G 400", "bad1.csv", session);

        const real = await listClients(base);
        check("G 400：后端未新增客户", real.clients.length === 1,
          real.clients.map(x => x.name));

        // 拒绝后用保留的文件选择重新选一份合法文件导入：现有导入规则照常工作
        await uploadCsv(page, "recover.csv", buildCsv(["name"], [["拒绝后新客"]]));
        await submitImport(session);
        const fixed = await importSnap(page);
        check("G 400 后：合法文件正常导入（新增 1 条），导入规则未受影响",
          successBanner(fixed, 1, 0) &&
          fixed.rows.some(r => r.cells[0] === "拒绝后新客"),
          fixed.banners);
        const real2 = await listClients(base);
        check("G 400 后：后端确为两名客户", real2.clients.length === 2,
          real2.clients.map(x => x.name));
        await page.close();
      }
    }

    await browser.close();
  } finally {
    for (const server of servers) {
      await stopApp(server).catch(() => {});
    }
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

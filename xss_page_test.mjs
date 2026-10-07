#!/usr/bin/env node
/**
 * 首页客户资料特殊字符展示的页面层面回归保障（XSS/注入安全）。
 *
 * 启动真实 app.py 服务（与 smoke_test.py / page_test.mjs 同一后端，不模拟、
 * 不改动接口公开行为与现有导入、批量修改规则），用 Puppeteer 驱动系统 Chrome
 * 打开首页，通过真实文件选择框导入含特殊字符资料的 CSV，并走真实批量修改
 * 保存路径，逐项验证客户名称、来源、地区、行业始终作为普通文字展示：
 *
 * A. 导入路径：合法 CSV 中含尖括号、单双引号、&、标签状/属性状/脚本状片段的
 *    名称与各项资料正常新增，列表逐格显示完整原文——标签状片段不丢失、
 *    引号附近文字不截断、&lt; 这类文字仍按原文显示（不再次解释成另一个字符）、
 *    普通中英文与标点照常；资料不生成图片/链接/按钮/输入控件等额外元素，
 *    不执行其中写着的脚本或事件内容，不改变页面原有的客户行与选择控件结构；
 * B. 已选区域：普通名称与特殊字符名称混排时，勾选后已选说明逐项显示准确的
 *    客户编号与完整名称，文字不会插入新的取消按钮或影响原有按钮；逐条取消
 *    与全选仍按客户编号区分，取消一名只移除该客户，已选数量与剩余名称一致，
 *    其他客户资料保持原样；
 * C. 批量修改路径：把来源、地区设为同类特殊文字保存成功后，列表按同一规则
 *    显示（保护不只在导入路径）；只影响选中客户，保持原值的字段各自保留原
 *    资料，原本未填写的字段继续显示空值提示（—），不出现 null/undefined，
 *    也不被其他客户的文字填充；接口读取的资料仍是原有文本，不为了页面显示
 *    把转义符号写进客户记录；
 * D. 持久展示：重新打开页面后，保存过的特殊字符资料仍按相同规则安全、完整
 *    地显示；正常导入与保存的既有行为（报告数量、成功横幅、勾选清除、字段
 *    复位）继续保留。
 */
import {spawn} from "node:child_process";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";
import {mkdtempSync, mkdirSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import puppeteer from "puppeteer";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, "app.py");
const TMP = mkdtempSync(join(tmpdir(), "clientbook-xss-page-"));
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
// 特殊字符资料样本：覆盖尖括号、单双引号、&、标签状/属性状/脚本状片段，
// 以及 &lt; 这类「本来就是文字」的实体样式内容。每个样本都带有可探测的
// 执行探针（window.__xss.push）：只要页面把资料解释成结构或可执行内容，
// 探针数组就会留下记录。
// ---------------------------------------------------------------------------
const P_SCRIPT = `<script>window.__xss.push("script")</script>`;
const P_IMG = `<img src="x" onerror="window.__xss.push('img')">`;
const P_QUOTES = `他说 "你好" & '再见' <然后>`;
const P_TAG = `<b class="x">加粗?</b>`;
const P_ENTITY = `&lt;b&gt;不是标签&lt;/b&gt;`;
const P_BTN = `</button><button onclick="window.__xss.push('btn')">取消</button>`;
const P_SVG = `"><svg onload="window.__xss.push('svg')">`;
const P_LINES = `多行\n第二行 <i>斜体</i>`;
const P_AMP = `&amp;&lt;&gt;`;

// 批量修改要设置的特殊文字（保存路径与导入路径分开覆盖）
const P_BATCH_IMG = `<img src="y" onerror="window.__xss.push('batch')">`;
const P_BATCH_REGION = `&lt;地区&gt; "引号" & 文本`;

// 导入的四名客户：普通资料、脚本/图片/引号混杂、实体样式文字（可选字段全空）、
// 按钮状名称与 svg/多行/实体样式行业
const CLIENTS = [
  {name: "普通客户甲", source: "展会", region: "华东", industry: "制造业",
    important_date: "2024-01-01"},
  {name: P_SCRIPT, source: P_IMG, region: P_QUOTES, industry: P_TAG,
    important_date: "2024-02-02"},
  {name: P_ENTITY, source: null, region: null, industry: null, important_date: null},
  {name: P_BTN, source: P_SVG, region: P_LINES, industry: P_AMP, important_date: null},
];

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
// CSV 构造与页面驱动
// ---------------------------------------------------------------------------
const csvField = v => `"${String(v).replace(/"/g, '""')}"`;
const buildCsv = (header, rows) =>
  header.map(csvField).join(",") + "\n" +
  rows.map(r => r.map(csvField).join(",")).join("\n") + "\n";

async function listClients(base) {
  const res = await fetch(base + "/api/clients");
  return res.json();
}

// 打开首页并布好执行探针：任何资料片段被当成脚本/事件内容执行时，
// window.__xss 都会留下记录。
async function openPage(browser, base) {
  const page = await browser.newPage();
  await page.evaluateOnNewDocument(() => { window.__xss = []; });
  await page.setCacheEnabled(false);
  await page.goto(base + "/", {waitUntil: "networkidle0"});
  return page;
}

async function uploadCsv(page, name, content) {
  // 此版本 Puppeteer 的 uploadFile 只接受本地路径：写到临时目录再通过真实文件选择框上传
  const dir = join(TMP, "uploads");
  mkdirSync(dir, {recursive: true});
  const path = join(dir, name);
  writeFileSync(path, content, "utf8");
  const input = await page.$("#file-input");
  await input.uploadFile(path);
  await page.waitForFunction(n => document.getElementById("filename").textContent === n,
    {}, name);
}

async function submitImport(page) {
  await page.click("#submit-btn");
  await page.waitForSelector("#report .banner", {timeout: 5000});
  await page.waitForFunction(() => !document.getElementById("submit-btn").disabled,
    {timeout: 5000});
  await new Promise(r => setTimeout(r, 80)); // 让横幅/列表渲染稳定
}

async function saveBatch(page) {
  await page.click("#batch-submit");
  await page.waitForSelector("#batch-report .banner", {timeout: 5000});
  await page.waitForFunction(
    () => document.getElementById("batch-submit").textContent === "保存修改",
    {timeout: 5000});
  await new Promise(r => setTimeout(r, 80));
}

// 页面可见状态快照：单元格文字取未修剪的 textContent（特殊字符逐字符核对，
// 不能 trim 掉内部结构），同时收集结构信息用于「不生成额外元素」的白名单核对。
async function snap(page) {
  return page.evaluate(() => {
    const text = sel => document.querySelector(sel)?.textContent.trim() ?? null;
    const rows = [...document.querySelectorAll("#clients-body tr")].map(tr => ({
      id: tr.dataset.id,
      checked: tr.querySelector(".row-check").checked,
      // td: 0 勾选框, 1 编号, 2 名称, 3 来源, 4 地区, 5 行业, 6 重要日期
      cells: [...tr.querySelectorAll("td")].slice(1).map(td => td.textContent),
      // 每行的全部后代元素标签（含 class），用于白名单核对
      elements: [...tr.querySelectorAll("*")].map(e =>
        e.tagName + (e.className && typeof e.className === "string" ? "." + e.className : "")),
      checkboxCount: tr.querySelectorAll('input[type=checkbox].row-check').length,
      tdCount: tr.querySelectorAll("td").length,
    }));
    const chips = [...document.querySelectorAll("#sel-list .sel-chip")].map(chip => ({
      text: chip.textContent,
      buttons: [...chip.querySelectorAll("button")].map(b => ({
        text: b.textContent, remove: b.dataset.remove ?? null,
      })),
      elements: [...chip.querySelectorAll("*")].map(e => e.tagName),
    }));
    return {
      rows,
      rowCount: document.querySelectorAll("#clients-body tr").length,
      selCount: text("#sel-count"),
      selNoneHint: document.querySelector("#sel-list")?.textContent.includes("尚未勾选任何客户") ?? false,
      selListElements: [...document.querySelectorAll("#sel-list *")].map(e =>
        e.tagName + (e.className && typeof e.className === "string" ? "." + e.className : "")),
      chips,
      checkAllPresent: !!document.getElementById("check-all"),
      checkAllChecked: document.getElementById("check-all").checked,
      submitText: text("#batch-submit"),
      submitDisabled: document.getElementById("batch-submit").disabled,
      banners: [...document.querySelectorAll("#batch-report .banner")].map(b => ({
        cls: b.className,
        text: b.innerText.replace(/[ \t\r\n]+/g, " ").trim(),
      })),
      reportText: document.getElementById("report").innerText.replace(/[ \t\r\n]+/g, " ").trim(),
      tableText: document.getElementById("clients-body").innerText,
      // 全页面结构计数：静态按钮（导入、保存修改）+ 已选芯片的取消按钮，
      // 静态输入控件（文件选择、全选、行勾选、12 个单选、1 个日期输入）+ 3 个文本域
      totalButtons: document.querySelectorAll("button").length,
      totalInputs: document.querySelectorAll("input").length,
      totalTextareas: document.querySelectorAll("textarea").length,
      totalImages: document.querySelectorAll("img").length,
      totalSvgs: document.querySelectorAll("svg").length,
      totalScripts: document.scripts.length,
      totalIframes: document.querySelectorAll("iframe").length,
      totalAnchors: document.querySelectorAll("#clients-body a, #sel-list a").length,
      xss: window.__xss ? [...window.__xss] : ["探针数组不存在"],
    };
  });
}

// 客户行单元格白名单：除单元格本身外，只有行勾选框与空值提示的 span.muted，
// 资料文字不得生成任何元素（图片、链接、按钮、输入控件、加粗标签等）。
const ROW_ALLOWED = new Set(["TD", "INPUT.row-check", "SPAN.muted"]);
function rowStructureOk(row) {
  return row.tdCount === 7 && row.checkboxCount === 1 &&
    row.elements.every(e => ROW_ALLOWED.has(e));
}

// 已选芯片白名单：芯片内只有文字与一个取消按钮
function chipStructureOk(s) {
  return s.chips.every(c =>
    c.buttons.length === 1 && c.buttons[0].text === "×" &&
    c.elements.every(t => t === "BUTTON"));
}

// 全页面不得因客户资料多出可执行/可交互元素
function pageStructureOk(s, selCount) {
  return s.totalImages === 0 && s.totalSvgs === 0 && s.totalIframes === 0 &&
    s.totalAnchors === 0 && s.totalScripts === 1 &&
    s.totalButtons === 2 + selCount &&
    s.totalInputs === 1 + 1 + s.rowCount + 12 + 1 &&
    s.totalTextareas === 3 &&
    s.xss.length === 0;
}

// 按客户编号（导入顺序即编号顺序，从 1 起）取预期资料；空字段显示为 —
const dash = "—";
const expectCell = v => (v === null || v === undefined || v === "") ? dash : v;

function expectRow(s, index, id, client) {
  const row = s.rows[index];
  if (!row) return `缺少第 ${index + 1} 行`;
  const expected = [String(id), expectCell(client.name), expectCell(client.source),
    expectCell(client.region), expectCell(client.industry),
    expectCell(client.important_date)];
  if (row.id !== String(id)) return `第 ${index + 1} 行编号为 ${row.id}，应为 ${id}`;
  for (let i = 0; i < expected.length; i++) {
    if (row.cells[i] !== expected[i]) {
      return `客户 ${id} 第 ${i + 1} 格显示为 ${JSON.stringify(row.cells[i])}，` +
        `应为 ${JSON.stringify(expected[i])}`;
    }
  }
  return null;
}

async function selectRows(page, ids) {
  await page.evaluate(ids => {
    for (const id of ids) {
      document.querySelector(`#clients-body tr[data-id="${id}"] .row-check`).click();
    }
  }, ids);
}

async function chooseSet(page, key, value) {
  await page.evaluate(({key, value}) => {
    const card = document.querySelector(`#batch-fields .bf[data-field="${key}"]`);
    card.querySelector('input[value=set]').click();
    const input = card.querySelector(".bf-value");
    input.value = value;
    input.dispatchEvent(new Event("input", {bubbles: true}));
  }, {key, value});
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
    const server = await startServer("xss");
    servers.push(server);
    const {base} = server;

    // ===================================================================
    // 场景 A：合法 CSV 导入含特殊字符资料——列表逐格完整显示原文，
    //         不生成额外元素、不执行脚本、不改变页面结构
    // ===================================================================
    const page = await openPage(browser, base);
    const csv = buildCsv(
      ["name", "source", "region", "industry", "important_date"],
      CLIENTS.map(c => [c.name, c.source ?? "", c.region ?? "",
        c.industry ?? "", c.important_date ?? ""]));
    await uploadCsv(page, "special.csv", csv);
    await submitImport(page);
    let s = await snap(page);

    check("A 导入报告：新增 4 条、未导入 0 条（特殊字符资料属合法记录）",
      /新增\s*4\s*条，未导入\s*0\s*条/.test(s.reportText), s.reportText);
    check("A 列表：四名客户全部出现、编号与资料一一对应",
      s.rowCount === 4 &&
      [0, 1, 2, 3].every(i => expectRow(s, i, i + 1, CLIENTS[i]) === null),
      [0, 1, 2, 3].map(i => expectRow(s, i, i + 1, CLIENTS[i])).filter(Boolean));
    check("A 列表：标签状片段完整可读、引号附近文字不截断（逐字符一致）",
      s.rows[1].cells[1] === P_SCRIPT && s.rows[1].cells[3] === P_QUOTES &&
      s.rows[1].cells[4] === P_TAG && s.rows[3].cells[1] === P_BTN,
      {name: s.rows[1].cells[1], region: s.rows[1].cells[3],
        industry: s.rows[1].cells[4], btn: s.rows[3].cells[1]});
    check("A 列表：&lt; 样式文字按原文显示，不再解释成另一个字符",
      s.rows[2].cells[1] === P_ENTITY && s.rows[3].cells[4] === P_AMP,
      {entity: s.rows[2].cells[1], amp: s.rows[3].cells[4]});
    check("A 列表：字段内换行与内部空白原样保留",
      s.rows[3].cells[3] === P_LINES, s.rows[3].cells[3]);
    check("A 列表：普通中文、英文与标点按原方式显示",
      s.rows[0].cells[1] === "普通客户甲" && s.rows[0].cells[2] === "展会" &&
      s.rows[0].cells[3] === "华东" && s.rows[0].cells[4] === "制造业" &&
      s.rows[0].cells[5] === "2024-01-01",
      s.rows[0].cells);
    check("A 列表：未填写字段显示空值提示（—），不出现 null/undefined",
      s.rows[2].cells.slice(2).every(c => c === dash) &&
      s.rows[3].cells[5] === dash &&
      !/null|undefined/.test(s.tableText),
      {cells: s.rows[2].cells, text: s.tableText});
    check("A 结构：客户行只有勾选框与空值提示，资料不生成任何元素",
      s.rows.every(rowStructureOk),
      s.rows.map(r => r.elements));
    check("A 结构：页面没有多出图片/链接/脚本/框架，脚本探针未被触发",
      pageStructureOk(s, 0),
      {img: s.totalImages, svg: s.totalSvgs, iframe: s.totalIframes,
        scripts: s.totalScripts, buttons: s.totalButtons,
        inputs: s.totalInputs, textareas: s.totalTextareas, xss: s.xss});
    check("A 结构：原有选择控件保持原样（全选框在、每行一个行勾选框、保存按钮在）",
      s.checkAllPresent && !s.checkAllChecked &&
      s.rows.every(r => r.checkboxCount === 1) &&
      s.submitText === "保存修改" && s.submitDisabled,
      {checkAll: s.checkAllPresent, submit: s.submitText,
        disabled: s.submitDisabled});

    // ===================================================================
    // 场景 B：普通名称与特殊字符名称混排时的已选区域——
    //         编号与名称准确、取消按钮不被注入、逐条取消与全选按编号区分
    // ===================================================================
    await page.click("#check-all");
    s = await snap(page);
    const chipText = (id, c) => `#${id} ${c.name} ×`;
    check("B 全选：已选数量为 4，逐项显示准确编号与完整名称",
      s.selCount === "4" && s.chips.length === 4 &&
      s.chips.every((chip, i) => chip.text === chipText(i + 1, CLIENTS[i])),
      {count: s.selCount, chips: s.chips.map(c => c.text)});
    check("B 全选：特殊字符名称在已选区域同样逐字符完整（含 &lt; 原文）",
      s.chips[1].text === chipText(2, CLIENTS[1]) &&
      s.chips[2].text === chipText(3, CLIENTS[2]) &&
      s.chips[3].text === chipText(4, CLIENTS[3]),
      s.chips.map(c => c.text));
    check("B 全选：每个芯片恰好一个取消按钮（×），按钮状名称不插入新按钮",
      chipStructureOk(s) &&
      s.chips.every((chip, i) => chip.buttons[0].remove === String(i + 1)),
      s.chips.map(c => ({els: c.elements, btns: c.buttons})));
    check("B 全选：已选区域只有芯片与按钮，不生成其他元素，探针仍未触发",
      s.selListElements.every(e => e === "SPAN.sel-chip" || e === "BUTTON") &&
      pageStructureOk(s, 4),
      {els: s.selListElements, buttons: s.totalButtons, xss: s.xss});
    check("B 全选：全选框勾选、保存按钮可用",
      s.checkAllChecked && !s.submitDisabled,
      {checked: s.checkAllChecked, disabled: s.submitDisabled});

    // 逐条取消：点掉第 2 名（脚本状名称）客户的取消按钮
    await page.evaluate(() => {
      document.querySelector('#sel-list [data-remove="2"]').click();
    });
    s = await snap(page);
    check("B 逐条取消：只移除该客户，已选数量与剩余名称一致",
      s.selCount === "3" && s.chips.length === 3 &&
      s.chips[0].text === chipText(1, CLIENTS[0]) &&
      s.chips[1].text === chipText(3, CLIENTS[2]) &&
      s.chips[2].text === chipText(4, CLIENTS[3]),
      {count: s.selCount, chips: s.chips.map(c => c.text)});
    check("B 逐条取消：对应行勾选框取消、其他客户资料与勾选保持原样",
      s.rows[1].checked === false &&
      s.rows[0].checked && s.rows[2].checked && s.rows[3].checked &&
      [0, 1, 2, 3].every(i => expectRow(s, i, i + 1, CLIENTS[i]) === null),
      {checked: s.rows.map(r => r.checked),
        rows: [0, 1, 2, 3].map(i => expectRow(s, i, i + 1, CLIENTS[i])).filter(Boolean)});

    // 用行勾选框重新勾选第 2 名、取消第 1 名：选择仍按编号区分
    await selectRows(page, [2]);
    await selectRows(page, [1]);
    s = await snap(page);
    check("B 行勾选：按编号加选/取消，已选为第 2、3、4 名",
      s.selCount === "3" && s.chips.length === 3 &&
      s.chips[0].text === chipText(2, CLIENTS[1]) &&
      s.chips[1].text === chipText(3, CLIENTS[2]) &&
      s.chips[2].text === chipText(4, CLIENTS[3]) &&
      s.rows[0].checked === false && s.rows[1].checked,
      {count: s.selCount, chips: s.chips.map(c => c.text)});

    // 部分勾选时点全选框补全到全选，再点取消全选，再点重新全选：
    // 控件行为不受特殊字符影响
    await page.click("#check-all"); // 3/4 勾选（半选）→ 补全为全选
    s = await snap(page);
    check("B 半选后点全选：补全为四名全选",
      s.selCount === "4" && s.chips.length === 4 && s.checkAllChecked &&
      s.chips.every((chip, i) => chip.text === chipText(i + 1, CLIENTS[i])),
      {count: s.selCount, chips: s.chips.map(c => c.text)});
    await page.click("#check-all"); // 全选 → 取消全选
    s = await snap(page);
    check("B 取消全选：已选清零、显示未勾选提示、保存按钮不可提交",
      s.selCount === "0" && s.chips.length === 0 && s.selNoneHint &&
      s.submitDisabled && s.rows.every(r => !r.checked),
      {count: s.selCount, hint: s.selNoneHint, disabled: s.submitDisabled});
    await page.click("#check-all"); // 无勾选 → 全选
    s = await snap(page);
    check("B 再次全选：四名客户全部回到已选，芯片与结构依旧安全",
      s.selCount === "4" && s.chips.length === 4 &&
      s.chips.every((chip, i) => chip.text === chipText(i + 1, CLIENTS[i])) &&
      chipStructureOk(s) && pageStructureOk(s, 4),
      {count: s.selCount, chips: s.chips.map(c => c.text), xss: s.xss});

    // ===================================================================
    // 场景 C：批量修改把来源、地区设为特殊文字——保存路径同样受保护；
    //         只影响选中客户，保持原值与空值字段各自保持原样；
    //         接口读取的仍是原有文本（转义符号不写入客户记录）
    // ===================================================================
    await page.click("#check-all"); // 先取消全选
    await selectRows(page, [2, 3]); // 一名特殊字符客户 + 一名实体样式名称客户
    await chooseSet(page, "source", P_BATCH_IMG);
    await chooseSet(page, "region", P_BATCH_REGION);
    await saveBatch(page);
    s = await snap(page);

    check("C 保存：显示成功处理 2 名客户",
      s.banners.some(b => b.cls.includes("ok") &&
        /已成功处理\s*2\s*名客户/.test(b.text)),
      s.banners);
    check("C 保存后：勾选清除、已选归零、保存按钮不可提交",
      s.selCount === "0" && s.chips.length === 0 && s.submitDisabled &&
      s.rows.every(r => !r.checked),
      {count: s.selCount, disabled: s.submitDisabled});

    const afterC = CLIENTS.map(c => ({...c}));
    afterC[1] = {...afterC[1], source: P_BATCH_IMG, region: P_BATCH_REGION};
    afterC[2] = {...afterC[2], source: P_BATCH_IMG, region: P_BATCH_REGION};
    check("C 保存后：选中客户的来源、地区按新文字逐字符显示（与导入同一规则）",
      s.rows[1].cells[2] === P_BATCH_IMG && s.rows[1].cells[3] === P_BATCH_REGION &&
      s.rows[2].cells[2] === P_BATCH_IMG && s.rows[2].cells[3] === P_BATCH_REGION,
      {r2: s.rows[1].cells.slice(2, 4), r3: s.rows[2].cells.slice(2, 4)});
    check("C 保存后：保持原值的字段各自保留原资料，未选中客户完全不变",
      [0, 1, 2, 3].every(i => expectRow(s, i, i + 1, afterC[i]) === null),
      [0, 1, 2, 3].map(i => expectRow(s, i, i + 1, afterC[i])).filter(Boolean));
    check("C 保存后：原本未填写的字段继续显示空值提示，无 null/undefined、不被他人文字填充",
      s.rows[2].cells[4] === dash && s.rows[2].cells[5] === dash &&
      s.rows[3].cells[5] === dash && !/null|undefined/.test(s.tableText),
      {cells: s.rows[2].cells, text: s.tableText});
    check("C 保存后：新文字不生成元素、不执行事件内容，页面结构保持原样",
      s.rows.every(rowStructureOk) && pageStructureOk(s, 0),
      {els: s.rows.map(r => r.elements), xss: s.xss,
        buttons: s.totalButtons, inputs: s.totalInputs});

    const real = await listClients(base);
    const byId = new Map(real.clients.map(c => [String(c.id), c]));
    check("C 接口核对：读取到的资料仍是原有文本，转义符号不写入客户记录",
      real.clients.length === 4 &&
      byId.get("2").source === P_BATCH_IMG && byId.get("2").region === P_BATCH_REGION &&
      byId.get("3").source === P_BATCH_IMG && byId.get("3").region === P_BATCH_REGION &&
      byId.get("2").name === P_SCRIPT && byId.get("3").name === P_ENTITY &&
      byId.get("4").name === P_BTN && byId.get("4").industry === P_AMP &&
      byId.get("1").source === "展会" && byId.get("1").industry === "制造业",
      real.clients.map(c => ({id: c.id, source: c.source, region: c.region})));
    check("C 接口核对：未填写字段接口返回 null，未选中客户资料保持原样",
      byId.get("3").industry === null && byId.get("3").important_date === null &&
      byId.get("4").important_date === null &&
      byId.get("1").region === "华东" && byId.get("4").source === P_SVG &&
      byId.get("4").region === P_LINES,
      real.clients.map(c => ({id: c.id, industry: c.industry, date: c.important_date})));

    // ===================================================================
    // 场景 D：重新打开页面——保存过的特殊字符资料仍按相同规则
    //         安全、完整地显示；正常导入与保存行为继续保留
    // ===================================================================
    const page2 = await openPage(browser, base);
    s = await snap(page2);
    check("D 重新打开：四名客户资料逐格与保存后一致（特殊字符完整可读）",
      s.rowCount === 4 &&
      [0, 1, 2, 3].every(i => expectRow(s, i, i + 1, afterC[i]) === null),
      [0, 1, 2, 3].map(i => expectRow(s, i, i + 1, afterC[i])).filter(Boolean));
    check("D 重新打开：不生成额外元素、不执行脚本，结构白名单依旧成立",
      s.rows.every(rowStructureOk) && pageStructureOk(s, 0),
      {els: s.rows.map(r => r.elements), xss: s.xss});
    check("D 重新打开：勾选特殊字符客户后已选区域仍准确显示编号与完整名称",
      await (async () => {
        await selectRows(page2, [4]);
        const s2 = await snap(page2);
        return s2.selCount === "1" && s2.chips.length === 1 &&
          s2.chips[0].text === chipText(4, afterC[3]) &&
          chipStructureOk(s2) && pageStructureOk(s2, 1);
      })(),
      "见上一快照");

    await page.close();
    await page2.close();
  } finally {
    await Promise.all(servers.map(stopApp));
    await browser.close();
  }

  console.log(`\n共 ${checkCount} 项检查，失败 ${FAILURES.length} 项`);
  if (FAILURES.length) {
    console.log("失败明细：");
    for (const f of FAILURES) console.log("-", f.label, f.detail);
    process.exitCode = 1;
  }
  rmSync(TMP, {recursive: true, force: true});
}

run().catch(err => {
  console.error("测试执行出错：", err);
  process.exitCode = 1;
  rmSync(TMP, {recursive: true, force: true});
});

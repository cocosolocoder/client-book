#!/usr/bin/env node
/**
 * 首页客户资料「始终按客户填写的普通文字展示」的页面层面回归保障。
 *
 * 启动真实 app.py（与 page_test.mjs / import_page_test.mjs 同一后端，不模拟、
 * 不改动任何公开行为），用 Puppeteer 驱动系统 Chrome 打开首页，通过真实文件
 * 选择框上传一份合法 CSV：其中客户名称、来源、地区、行业混有尖括号、单双引号、
 * &、看起来像网页标签 / 属性 / 脚本的片段，以及字面量 "&lt;" / "&amp;" 文本。
 *
 * 覆盖要求：
 * 1. 合法 CSV 导入后客户正常出现在列表：名称与各项资料仍属于对应编号，特殊
 *    字符完整可读，标签状片段不丢失，引号附近文字不截断；普通中英文与标点
 *    继续按原样显示；资料中本来写着的 &lt; / &amp; 仍显示这段原文，不被
 *    再次解释成另一个字符；
 * 2. 客户资料只生成文字：列表与已选客户说明中不额外出现图片、链接、按钮、
 *    输入框等控件，不改变原有的客户行与选择控件；脚本 / 事件内容不执行
 *    （window 标记不被置位、不弹对话框、页面无 JS 异常）；
 * 3. 普通名称与特殊字符名称同时勾选时，已选区域显示准确编号与名称，特殊
 *    文字不会插入新的取消按钮；逐条取消（行内勾选与已选区域移除）与全选
 *    都按客户编号区分记录，取消其中一名只移除该客户，已选数量与剩余名称
 *    一致，其他客户资料保持原样；
 * 4. 批量修改把来源 / 地区 / 行业设为上述文字后，保存成功的列表按同样规则
 *    显示——保护不只在导入路径；设置只影响选中客户，保持原值的字段逐人
 *    保留各自原值、不被其他客户文字填充；清空 / 仅空白写入的字段继续显示
 *    现有空值提示（—），不出现 null、undefined；
 * 5. 接口读回的资料仍是客户填写的原文（不把转义符号写进客户记录）；保存后
 *    勾选清除、原有行与选择控件结构不变；重新打开页面结论相同；
 * 6. 正常导入与保存的既有行为（数量提示、成功后刷新、清空勾选、表单复位）
 *    继续保留。
 */
import {spawn} from "node:child_process";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";
import {mkdtempSync, mkdirSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import puppeteer from "puppeteer";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, "app.py");
const TMP = mkdtempSync(join(tmpdir(), "clientbook-text-safety-"));
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

// 页面源码经 esc() 转义了 & < > " '（属性场景也安全）；但读 innerHTML 时
// 浏览器按片段序列化规则只在文本节点中转义 & < >，引号在文本中没有特殊含义、
// 会原样返回。因此与 innerHTML 比对时使用这个「序列化后」的期望，
// 引号是否被转义由文字完整显示与结构审计间接保证。
const escHtml = s => String(s).replace(/[&<>]/g,
  c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;"}[c]));
const DASH_HTML = '<span class="muted">—</span>';

// 合法 CSV 中的七名客户：普通文本与各种特殊字符文本混排，编号即导入顺序 1..7。
const CLIENTS = [
  {name: "甲公司", source: "展会", region: "华东", industry: "制造业"},
  {
    name: "<b>加粗公司</b>",
    source: '老客"推荐"',
    region: "华北's",
    industry: '<a href="https://example.com">行业链接</a>',
  },
  {
    name: '<img src=x onerror="window.__xssFired=\'name-img\'">',
    source: '<script>window.__xssFired=\'src-script\'</script>',
    region: '"><svg onload="window.__xssFired=\'region-svg\'">',
    industry: "Tom & Jerry",
  },
  {
    name: "实体公司 A&amp;B",
    source: "1 &lt; 2 且 &gt; 0",
    region: '单引号\'双引号"&公司',
    industry: '<button type="button">假按钮</button>',
  },
  {name: '<input value="恶意输入框">', source: "官网", region: "华南", industry: "金融业"},
  {
    name: '引号附近不截断 "中" 间"末尾',
    source: "'单引'夹<击>",
    region: "西南",
    industry: '<iframe src="javascript:alert(1)"></iframe>',
  },
  {name: "逗号,公司", source: "来源,含逗号", region: "华东", industry: "物流"},
];

// 批量修改设置进去的文字：标签 / 属性 / 脚本片段 + 内部换行 + 单双引号 + &。
const BATCH_SOURCE =
  '新来源<img src=x onerror="window.__xssFired=\'batch-src\'">\n第二行 & "双引" \'单引\'';
// 字面实体文本：页面必须显示 "&lt;原样保留&gt;" 这段原文，不能变成尖括号。
const BATCH2_REGION = "&lt;原样保留&gt; 与 <b>";
const WHITESPACE_ONLY = "  \n\t ";

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

function csvField(v) {
  return '"' + String(v).replace(/"/g, '""') + '"';
}

function buildClientsCsv() {
  const header = ["name", "source", "region", "industry"];
  const lines = [header.map(csvField).join(",")];
  for (const c of CLIENTS) {
    lines.push([c.name, c.source, c.region, c.industry].map(csvField).join(","));
  }
  return lines.join("\n") + "\n";
}

async function listClients(base) {
  const res = await fetch(base + "/api/clients");
  if (res.status !== 200) throw new Error("读取客户列表失败：HTTP " + res.status);
  return (await res.json()).clients;
}

async function run() {
  const app = startApp("main");
  let base;
  try {
    base = `http://127.0.0.1:${await app.port}`;
    await waitReady(base);
  } catch (e) {
    await stopApp(app).catch(() => {});
    throw e;
  }

  const browser = await puppeteer.launch({
    executablePath: process.env.CHROME || "/usr/bin/google-chrome",
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });

  // 页面一旦加载就埋好钩子：任何脚本 / 事件内容若被当成可执行内容，
  // __xssFired 会被置位、alert/confirm/prompt 会被记录（而非真的弹窗）。
  const dialogs = [];
  let pageError = null;
  try {
    const page = await browser.newPage();
    await page.evaluateOnNewDocument(() => {
      window.__xssFired = null;
      window.__xssMark = v => { window.__xssFired = String(v); };
      for (const name of ["alert", "confirm", "prompt"]) {
        window[name] = (...args) => { window.__xssFired = name + ":" + args.join("|"); };
      }
    });
    page.on("pageerror", err => { pageError = String(err); });
    page.on("dialog", async d => {
      dialogs.push(d.message());
      await d.dismiss().catch(() => {});
    });

    // -- 通过真实文件选择框上传合法 CSV ------------------------------------
    await page.goto(base + "/", {waitUntil: "networkidle0"});
    const uploadDir = join(TMP, "uploads");
    mkdirSync(uploadDir, {recursive: true});
    const csvPath = join(uploadDir, "special-clients.csv");
    writeFileSync(csvPath, buildClientsCsv(), "utf8");
    await (await page.$("#file-input")).uploadFile(csvPath);
    await page.waitForFunction(
      () => document.getElementById("filename").textContent === "special-clients.csv",
      {timeout: 5000});
    await page.click("#submit-btn");
    await page.waitForFunction(
      () => document.getElementById("report").textContent.includes("新增 7 条"),
      {timeout: 8000});
    await page.waitForSelector("#clients-table.on", {timeout: 5000});
    await page.waitForFunction(
      () => document.querySelectorAll("#clients-body tr").length === 7,
      {timeout: 5000});
    check("导入报告显示新增 7 条、未导入 0 条",
      (await page.evaluate(() => document.getElementById("report").textContent
        .replace(/[ \t\r\n]+/g, " ").trim()))
        .includes("新增 7 条，未导入 0 条"));

    // 页面内的结构化 DOM 审计：逐行逐格返回文本、HTML 原文、子元素与违禁控件。
    const audit = () => page.evaluate(() => {
      const FORBIDDEN = "a,img,svg,iframe,script,form,object,embed,link,style";
      const rows = [...document.querySelectorAll("#clients-body tr")].map(tr => ({
        id: tr.dataset.id,
        cells: [...tr.querySelectorAll("td")].map(td => ({
          text: td.textContent,
          html: td.innerHTML,
          kids: td.querySelectorAll("*").length,
        })),
        checkboxes: [...tr.querySelectorAll("input")].map(i => ({
          cls: i.className, type: i.type, value: i.value,
        })),
        forbidden: [...tr.querySelectorAll(FORBIDDEN + ",button")].map(e => e.tagName),
      }));
      const chips = [...document.querySelectorAll("#sel-list .sel-chip")].map(c => {
        const clone = c.cloneNode(true);
        clone.querySelector("button")?.remove();
        return {
          remove: c.querySelector("[data-remove]")?.dataset.remove ?? null,
          label: clone.textContent.trim(),
          buttons: c.querySelectorAll("button").length,
          inputs: c.querySelectorAll("input").length,
          forbidden: [...c.querySelectorAll(FORBIDDEN)].map(e => e.tagName),
        };
      });
      return {
        marker: window.__xssFired,
        rows,
        chips,
        selCount: document.getElementById("sel-count").textContent,
        bodyNullish: /\b(null|undefined)\b/.test(
          document.getElementById("clients-body").textContent),
        selNullish: /\b(null|undefined)\b/.test(
          document.getElementById("sel-list").textContent),
        rowChecks: document.querySelectorAll("#clients-body input.row-check").length,
        checkAllCount: document.querySelectorAll("#check-all").length,
        textareas: document.querySelectorAll("#batch-fields textarea").length,
        radios: document.querySelectorAll("#batch-fields input[type=radio]").length,
      };
    });

    const assertNoExecution = async tag => {
      // 留出事件循环时间：若转义回归、<img onerror>/<svg onload> 被真的插进
      // DOM，其 error/load 事件需要一个任务周期才会触发标记。
      await new Promise(r => setTimeout(r, 150));
      const snap = await audit();
      check(`[${tag}] 脚本/事件内容未执行（标记未置位）`, snap.marker === null, snap.marker);
      check(`[${tag}] 未弹出任何对话框`, dialogs.length === 0, dialogs);
      check(`[${tag}] 页面无 JS 异常`, pageError === null, pageError);
      return snap;
    };

    // -- 1. 接口读回的是客户填写的原文（转义符号不写入客户记录）-------------
    let apiClients = await listClients(base);
    check("接口返回 7 名客户", apiClients.length === 7, apiClients.length);
    let apiOk = true;
    const apiBad = [];
    apiClients.forEach((c, i) => {
      const want = CLIENTS[i];
      for (const k of ["name", "source", "region", "industry"]) {
        if (c[k] !== want[k]) { apiOk = false; apiBad.push({id: c.id, field: k, got: c[k], want: want[k]}); }
      }
      if (c.important_date !== null) { apiOk = false; apiBad.push({id: c.id, important_date: c.important_date}); }
    });
    check("接口各编号的名称与资料均为原文（尖括号/引号/&/实体文本/逗号完整，无转义落库）",
      apiOk, apiBad);

    // -- 2. 列表逐格按普通文字渲染，不生成任何控件或可执行结构 ---------------
    let snap = await assertNoExecution("导入后列表");
    check("列表行数为 7", snap.rows.length === 7, snap.rows.length);
    check("每行一个 row-check 选择控件，全选控件仍只有一个",
      snap.rowChecks === 7 && snap.checkAllCount === 1,
      {rowChecks: snap.rowChecks, checkAll: snap.checkAllCount});
    check("批量修改表单原有控件不变（3 个文本域、12 个单选项）",
      snap.textareas === 3 && snap.radios === 12,
      {textareas: snap.textareas, radios: snap.radios});
    check("列表文字中不出现 null / undefined", !snap.bodyNullish);
    for (const r of snap.rows) {
      const want = CLIENTS[Number(r.id) - 1];
      check(`编号 ${r.id} 行资料对应 CSV 同序号记录且未截断`,
        r.cells[1].text === String(r.id) &&
        r.cells[2].text === want.name &&
        r.cells[3].text === want.source &&
        r.cells[4].text === want.region &&
        r.cells[5].text === want.industry &&
        r.cells[6].text === "—",
        {id: r.id, cells: r.cells.map(c => c.text)});
      check(`编号 ${r.id} 各数据格无子元素（标签状片段未变成元素）`,
        r.cells.slice(1, 6).every(c => c.kids === 0) && r.cells[6].kids === 1,
        r.cells.map(c => c.kids));
      check(`编号 ${r.id} 各数据格 HTML 为转义后的文字`,
        r.cells[2].html === escHtml(want.name) &&
        r.cells[3].html === escHtml(want.source) &&
        r.cells[4].html === escHtml(want.region) &&
        r.cells[5].html === escHtml(want.industry) &&
        r.cells[6].html === DASH_HTML,
        r.cells.map(c => c.html));
      check(`编号 ${r.id} 行内没有图片/链接/按钮/输入框/脚本等额外控件`,
        r.forbidden.length === 0 &&
        r.checkboxes.length === 1 && r.checkboxes[0].cls === "row-check" &&
        r.checkboxes[0].value === String(r.id),
        {forbidden: r.forbidden, checkboxes: r.checkboxes});
    }
    check("已选区域初始为空提示且无 null/undefined",
      snap.selCount === "0" && snap.chips.length === 0 && !snap.selNullish,
      {count: snap.selCount, chips: snap.chips});

    // 字面实体文本不被再次解释
    {
      const r4 = snap.rows.find(r => r.id === "4");
      check("名称中的 A&amp;B 按原文显示（不被解释成 A&B）",
        r4.cells[2].text === "实体公司 A&amp;B" && r4.cells[2].html === escHtml("实体公司 A&amp;B"));
      check("来源中的 &lt; / &gt; 按原文显示（不被解释成尖括号）",
        r4.cells[3].text === "1 &lt; 2 且 &gt; 0" &&
        r4.cells[3].html === "1 &amp;lt; 2 且 &amp;gt; 0");
    }

    // 全表范围再扫一次：资料没有在表格任何位置生成控件元素
    {
      const scan = await page.evaluate(() => ({
        extra: [...document.querySelectorAll(
          "#clients-table a,#clients-table img,#clients-table svg,#clients-table iframe," +
          "#clients-table script,#clients-table button,#clients-table form," +
          "#clients-table object,#clients-table embed,#clients-table style")]
          .map(e => e.tagName + ":" + e.outerHTML.slice(0, 60)),
        extraInputs: [...document.querySelectorAll("#clients-body input:not(.row-check)")]
          .map(e => e.outerHTML.slice(0, 60)),
      }));
      check("表格内无链接/图片/按钮/脚本等额外元素", scan.extra.length === 0, scan.extra);
      check("表格内除行勾选框外无其他输入控件", scan.extraInputs.length === 0, scan.extraInputs);
    }

    // -- 3. 勾选普通与特殊名称客户：已选区域编号/名称准确、按钮不增生 ----------
    const clickRow = id => page.evaluate(id => {
      document.querySelector(`#clients-body tr[data-id="${id}"] .row-check`).click();
    }, id);
    for (const id of [1, 2, 3, 4, 5]) await clickRow(id);
    snap = await assertNoExecution("勾选五名客户");
    check("已选数量为 5", snap.selCount === "5", snap.selCount);
    check("已选区域按编号顺序显示五个条目",
      snap.chips.map(c => c.remove).join(",") === "1,2,3,4,5",
      snap.chips.map(c => c.remove));
    for (const c of snap.chips) {
      const want = CLIENTS[Number(c.remove) - 1];
      check(`已选条目 #${c.remove} 标签为「编号 + 原文名称」`,
        c.label === `#${c.remove} ${want.name}`, c.label);
      check(`已选条目 #${c.remove} 只有原有的一个取消按钮、无输入控件或额外元素`,
        c.buttons === 1 && c.inputs === 0 && c.forbidden.length === 0,
        {buttons: c.buttons, inputs: c.inputs, forbidden: c.forbidden});
    }

    // 从已选区域移除名称含 <img ...> 的 3 号：只移除该客户
    await page.evaluate(() => {
      document.querySelector('#sel-list .sel-chip [data-remove="3"]').click();
    });
    snap = await assertNoExecution("已选区域移除 3 号");
    check("移除 3 号后已选数量为 4", snap.selCount === "4", snap.selCount);
    check("已选区域剩余编号为 1,2,4,5",
      snap.chips.map(c => c.remove).join(",") === "1,2,4,5", snap.chips.map(c => c.remove));
    {
      const rowState = await page.evaluate(() =>
        Object.fromEntries([...document.querySelectorAll("#clients-body tr")]
          .map(tr => [tr.dataset.id, tr.querySelector(".row-check").checked])));
      check("3 号行勾选已取消，1/2/4/5 行仍勾选，6/7 未勾选",
        !rowState[3] && rowState[1] && rowState[2] && rowState[4] && rowState[5] &&
        !rowState[6] && !rowState[7],
        rowState);
    }

    // 行内逐条取消 2 号（名称 <b>加粗公司</b>）
    await clickRow(2);
    snap = await audit();
    check("行内取消 2 号后已选数量为 3 且剩余 1,4,5",
      snap.selCount === "3" && snap.chips.map(c => c.remove).join(",") === "1,4,5",
      {count: snap.selCount, chips: snap.chips.map(c => c.remove)});

    // 全选 / 全不选按编号区分
    await page.evaluate(() => document.getElementById("check-all").click());
    snap = await audit();
    check("全选后数量为 7，七名客户（含特殊名称）各占一个条目",
      snap.selCount === "7" && snap.chips.length === 7,
      {count: snap.selCount, chips: snap.chips.length});
    await clickRow(5); // 取消名称为 <input ...> 的 5 号
    snap = await audit();
    check("全选后逐条取消 5 号：数量为 6，5 号消失其余保留",
      snap.selCount === "6" && !snap.chips.some(c => c.remove === "5") &&
      snap.chips.length === 6,
      {count: snap.selCount, chips: snap.chips.map(c => c.remove)});
    // 部分选中（6/7）时全选框处于 indeterminate：第一次点击补全为 7，第二次才清空
    await page.evaluate(() => document.getElementById("check-all").click());
    snap = await audit();
    check("部分选中时点击全选先补全为 7", snap.selCount === "7", snap.selCount);
    await page.evaluate(() => document.getElementById("check-all").click());
    snap = await audit();
    check("取消全选后数量归零并恢复空提示",
      snap.selCount === "0" && snap.chips.length === 0 && !snap.selNullish,
      {count: snap.selCount, chips: snap.chips});

    // -- 4. 批量修改：set 特殊文字 / keep 逐人保留 / clear 置空 ---------------
    const setBatchField = (field, op, value) => page.evaluate(({field, op, value}) => {
      const card = document.querySelector(`.bf[data-field="${field}"]`);
      card.querySelector(`input[value="${op}"]`).click();
      if (op === "set") card.querySelector(".bf-value").value = value;
    }, {field, op, value});

    // 选中 2、3、4（特殊资料）与 7（普通资料，含逗号字段）
    for (const id of [2, 3, 4, 7]) await clickRow(id);
    await setBatchField("source", "set", BATCH_SOURCE);
    await setBatchField("industry", "clear");
    // region / important_date 保持初始 keep
    await page.click("#batch-submit");
    await page.waitForFunction(
      () => document.getElementById("batch-report").textContent.includes("已成功处理"),
      {timeout: 8000});
    const batchReport = await page.evaluate(() =>
      document.getElementById("batch-report").textContent.replace(/[ \t\r\n]+/g, " ").trim());
    check("批量保存成功数量为 4", batchReport.includes("已成功处理 4 名客户"), batchReport);

    snap = await assertNoExecution("批量保存后");
    check("保存后勾选清除、已选归零", snap.selCount === "0" && snap.chips.length === 0,
      {count: snap.selCount});
    check("保存后列表仍为 7 行、每行一个原有选择控件",
      snap.rows.length === 7 && snap.rowChecks === 7,
      {rows: snap.rows.length, checks: snap.rowChecks});
    check("保存后表单复位为保持原值（仍 3 文本域 12 单选项）",
      snap.textareas === 3 && snap.radios === 12,
      {textareas: snap.textareas, radios: snap.radios});
    check("列表中不出现 null / undefined", !snap.bodyNullish && !snap.selNullish);

    // 接口核对：set 原文落库、keep 逐人保留、clear 为 null、未选中客户不变
    apiClients = await listClients(base);
    const byId = Object.fromEntries(apiClients.map(c => [c.id, c]));
    {
      const bad = [];
      for (const id of [2, 3, 4, 7]) {
        if (byId[id].source !== BATCH_SOURCE) bad.push(["source", id, byId[id].source]);
        if (byId[id].industry !== null) bad.push(["industry", id, byId[id].industry]);
      }
      const keptRegions = {2: "华北's", 3: CLIENTS[2].region, 4: CLIENTS[3].region, 7: "华东"};
      for (const [id, region] of Object.entries(keptRegions)) {
        if (byId[id].region !== region) bad.push(["region", id, byId[id].region]);
      }
      // 未选中客户 1/5/6 全部资料保持原样
      for (const id of [1, 5, 6]) {
        const want = CLIENTS[id - 1];
        for (const k of ["name", "source", "region", "industry"]) {
          if (byId[id][k] !== want[k]) bad.push([k, id, byId[id][k]]);
        }
      }
      // 名称从不参与修改
      for (const id of [2, 3, 4, 7]) {
        if (byId[id].name !== CLIENTS[id - 1].name) bad.push(["name", id, byId[id].name]);
      }
      check("接口：set 写入原文（含内部换行/引号/标签片段），keep 字段逐人保留，" +
          "clear 为 null，未选中客户与所有名称不变",
        bad.length === 0, bad);
    }

    // 页面对保存后的特殊文字按同一规则渲染
    for (const r of snap.rows) {
      const id = Number(r.id);
      const selectedIds = [2, 3, 4, 7];
      const wantName = CLIENTS[id - 1].name;
      const wantRegion = selectedIds.includes(id)
        ? {2: "华北's", 3: CLIENTS[2].region, 4: CLIENTS[3].region, 7: "华东"}[id]
        : CLIENTS[id - 1].region;
      const wantSource = selectedIds.includes(id) ? BATCH_SOURCE : CLIENTS[id - 1].source;
      // 选中客户行业已清空；未选中的 1/5/6 保留各自原行业（均为文本）
      const wantIndustry = selectedIds.includes(id) ? "—" : CLIENTS[id - 1].industry;
      check(`保存后编号 ${id} 页面文字与当前资料一致`,
        r.cells[2].text === wantName &&
        r.cells[3].text === wantSource &&
        r.cells[4].text === wantRegion &&
        r.cells[5].text === wantIndustry &&
        r.cells[6].text === "—",
        r.cells.map(c => c.text));
      check(`保存后编号 ${id} 仍无子元素/额外控件，HTML 为转义文字`,
        r.cells.slice(1, 5).every(c => c.kids === 0) &&
        (selectedIds.includes(id)
          ? r.cells[5].html === DASH_HTML
          : r.cells[5].kids === 0 && r.cells[5].html === escHtml(wantIndustry)) &&
        r.cells[6].html === DASH_HTML &&
        r.forbidden.length === 0,
        {forbidden: r.forbidden, html: r.cells.map(c => c.html)});
    }
    check("保存后来源格内部换行保留、特殊片段为转义文字",
      snap.rows.find(r => r.id === "2").cells[3].html === escHtml(BATCH_SOURCE),
      snap.rows.find(r => r.id === "2").cells[3].html);

    // -- 5. 第二次保存：仅空白按清空；字面 &lt; 文本设置后仍按原文显示 --------
    for (const id of [1, 5]) await clickRow(id);
    await setBatchField("region", "set", BATCH2_REGION);
    await setBatchField("industry", "set", WHITESPACE_ONLY);
    await page.click("#batch-submit");
    await page.waitForFunction(
      () => document.getElementById("batch-report").textContent.includes("已成功处理"),
      {timeout: 8000});
    {
      const report = await page.evaluate(() =>
        document.getElementById("batch-report").textContent.replace(/\s+/g, " ").trim());
      check("第二次保存成功数量为 2", report.includes("已成功处理 2 名客户"), report);
    }
    apiClients = await listClients(base);
    {
      const byId2 = Object.fromEntries(apiClients.map(c => [c.id, c]));
      const bad = [];
      for (const id of [1, 5]) {
        if (byId2[id].region !== BATCH2_REGION) bad.push(["region", id, byId2[id].region]);
        if (byId2[id].industry !== null) bad.push(["industry", id, byId2[id].industry]);
      }
      if (byId2[1].source !== "展会" || byId2[5].source !== "官网") bad.push(["source-keep"]);
      // 其他客户不被这次操作影响
      if (byId2[2].source !== BATCH_SOURCE || byId2[7].region !== "华东") bad.push(["others"]);
      check("接口：字面 &lt; 文本原样落库，仅空白设置落为 null，keep 的来源逐人保留",
        bad.length === 0, bad);
    }
    snap = await audit();
    {
      const r1 = snap.rows.find(r => r.id === "1");
      const r5 = snap.rows.find(r => r.id === "5");
      check("页面把 &lt;原样保留&gt; 显示为这段原文（不解释成尖括号）",
        r1.cells[4].text === BATCH2_REGION && r5.cells[4].text === BATCH2_REGION &&
        r1.cells[4].html === escHtml(BATCH2_REGION),
        {text: r1.cells[4].text, html: r1.cells[4].html});
      check("仅空白设置后行业显示空值提示而非 null/undefined/空白",
        r1.cells[5].html === DASH_HTML && r5.cells[5].html === DASH_HTML,
        {r1: r1.cells[5].html, r5: r5.cells[5].html});
      check("全表仍无 null/undefined 文本", !snap.bodyNullish);
    }
    await assertNoExecution("第二次保存后");

    // -- 6. 重新打开页面：结论相同，既有正常展示行为不变 ----------------------
    await page.reload({waitUntil: "networkidle0"});
    await page.waitForSelector("#clients-table.on", {timeout: 5000});
    snap = await assertNoExecution("重新打开页面");
    check("重新打开后仍是 7 行、勾选归零",
      snap.rows.length === 7 && snap.selCount === "0" && snap.rowChecks === 7,
      {rows: snap.rows.length, count: snap.selCount});
    {
      const finalApi = Object.fromEntries((await listClients(base)).map(c => [c.id, c]));
      const expected = {
        1: {name: "甲公司", source: "展会", region: BATCH2_REGION, industry: null},
        2: {name: "<b>加粗公司</b>", source: BATCH_SOURCE, region: "华北's", industry: null},
        3: {name: CLIENTS[2].name, source: BATCH_SOURCE, region: CLIENTS[2].region, industry: null},
        4: {name: "实体公司 A&amp;B", source: BATCH_SOURCE, region: CLIENTS[3].region, industry: null},
        5: {name: '<input value="恶意输入框">', source: "官网", region: BATCH2_REGION, industry: null},
        6: {name: CLIENTS[5].name, source: CLIENTS[5].source, region: "西南", industry: CLIENTS[5].industry},
        7: {name: "逗号,公司", source: BATCH_SOURCE, region: "华东", industry: null},
      };
      for (const r of snap.rows) {
        const id = Number(r.id);
        const want = expected[id];
        const cellTexts = [null, r.cells[1].text, r.cells[2].text, r.cells[3].text,
          r.cells[4].text, r.cells[5].text, r.cells[6].text];
        check(`重开后编号 ${id} 页面文字与最终资料一致`,
          cellTexts[1] === String(id) &&
          cellTexts[2] === want.name &&
          cellTexts[3] === (want.source ?? "—") &&
          cellTexts[4] === (want.region ?? "—") &&
          cellTexts[5] === (want.industry ?? "—") &&
          cellTexts[6] === "—",
          cellTexts);
        check(`重开后编号 ${id} 数据格仍只有文字、无新增控件`,
          r.forbidden.length === 0 && r.checkboxes.length === 1,
          {forbidden: r.forbidden, checkboxes: r.checkboxes});
        const api = finalApi[id];
        check(`重开前后接口资料一致且为原文（编号 ${id}）`,
          api.name === want.name && api.source === want.source &&
          api.region === want.region && api.industry === want.industry,
          api);
      }
      check("重开后全表无 null/undefined 文本", !snap.bodyNullish && !snap.selNullish);
    }
  } finally {
    await browser.close();
    await stopApp(app).catch(() => {});
  }

  console.log(`\n${checkCount - FAILURES.length}/${checkCount} 项通过`);
  if (FAILURES.length) {
    console.log("失败项：");
    for (const f of FAILURES) console.log(" -", f.label, f.detail);
    process.exitCode = 1;
  }
}

run().catch(err => {
  console.error(err);
  process.exitCode = 1;
}).finally(() => {
  rmSync(TMP, {recursive: true, force: true});
});

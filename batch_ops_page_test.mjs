#!/usr/bin/env node
/**
 * 首页批量修改「字段操作选择」的页面层面回归保障。
 *
 * 启动真实 app.py 服务（与 smoke_test.py / page_test.mjs 同一后端，不模拟、不改动
 * 接口公开行为），用 Puppeteer 驱动系统 Chrome 打开首页，覆盖「填过内容后重新选择
 * 字段操作」与「明确选择设置却只留下空白」两条主线，验证保存时以各字段最后选定的
 * 「保持原值」「设为填写的值」「清空」为准——输入框残留文字、变成不可填写状态或
 * 留空，都不能自行替代这个选择：
 *
 * 1. 设为填写的值并输入文字后改回「保持原值」：保存时该字段分别保留每名客户自己的
 *    原值，不写入残留文字，也不因输入框不可填写而清空；另一字段按最后选择的操作保存；
 *    发出的请求体中该字段只有 {op:"keep"}，不携带残留 value；
 * 2. 重要日期先填无效日期再改回「保持原值」：不妨碍其他有效修改成功，日期保持原值；
 * 3. 最终选择「清空」：之前留下的文字或无效日期不再校验，保存后为未填写状态
 *    （列表显示 —，接口返回 null）；
 * 4. 最终选择「设为填写的值」但输入为空或只含空白（空格/制表符/换行）：四个字段都
 *    按清空处理，重要日期只填空格不报日期格式错误；原本已为空的客户仍为空，不从
 *    其他客户补入内容；
 * 5. 非空文本只去除前后空白，内部空白与换行原样保留；客户名称、编号与未选中客户
 *    的资料不变；
 * 6. 四个字段最终全部「保持原值」时，即使输入框留下文字也整次拒绝并说明没有修改项；
 *    拒绝后保留当前勾选、操作与填写，不显示成功数量；
 * 7. 重要日期最终选择「设为填写的值」且填写无效日期：整次拒绝，其他字段不先保存；
 *    修正操作选择后可用保留的勾选与填写再次保存成功；
 * 8. 同一字段多次切换操作：以最后选定为准（set→clear→keep 为保持原值；
 *    set→keep→set 为最后一次填写的值；clear→set→clear 为清空）。
 */
import {spawn} from "node:child_process";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";
import {mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import puppeteer from "puppeteer";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, "app.py");
const TMP = mkdtempSync(join(tmpdir(), "clientbook-ops-"));
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

// 直接打后端准备稳定的测试数据
async function seed(base, rows) {
  const lines = rows.map(r => [r.name, r.source ?? "", r.region ?? "", r.industry ?? "", r.date ?? ""]
    .map(v => `"${String(v).replace(/"/g, '""')}"`).join(","));
  const csv = "name,source,region,industry,important_date\n" + lines.join("\n") + "\n";
  const res = await fetch(base + "/api/clients/import", {method: "POST", body: csv});
  const data = await res.json();
  if (res.status !== 200) throw new Error("seed 失败：" + JSON.stringify(data));
  return data.imported.map(x => x.id);
}

async function listClients(base) {
  const res = await fetch(base + "/api/clients");
  return res.json();
}

// ---------------------------------------------------------------------------
// 页面驱动：记录每次批量保存发出的请求体与列表读取次数
// ---------------------------------------------------------------------------
async function openSession(browser, base) {
  const page = await browser.newPage();
  const counts = {batchPosts: 0, listGets: 0};
  const payloads = []; // 每次 POST /api/clients/batch-update 的请求体（已解析）

  await page.setRequestInterception(true);
  page.on("request", request => {
    const url = request.url();
    if (request.method() === "GET" && url.endsWith("/api/clients")) {
      counts.listGets += 1;
      request.continue();
      return;
    }
    if (request.method() === "POST" && url.endsWith("/api/clients/batch-update")) {
      counts.batchPosts += 1;
      payloads.push(JSON.parse(request.postData()));
    }
    request.continue();
  });

  await page.setCacheEnabled(false);
  await page.goto(base + "/", {waitUntil: "networkidle0"});
  return {page, counts, payloads};
}

// 读取批量保存区域的全部可见状态
async function snapshot(page) {
  return page.evaluate(() => {
    const text = sel => document.querySelector(sel)?.textContent.trim() ?? null;
    const rows = [...document.querySelectorAll("#clients-body tr")].map(tr => ({
      id: tr.dataset.id,
      checked: tr.querySelector(".row-check").checked,
      // td: 0 勾选框, 1 编号, 2 名称, 3 来源, 4 地区, 5 行业, 6 重要日期
      cells: [...tr.querySelectorAll("td")].slice(2).map(td => td.textContent.trim()),
    }));
    return {
      selCount: text("#sel-count"),
      rows,
      submitText: text("#batch-submit"),
      submitDisabled: document.getElementById("batch-submit").disabled,
      fields: [...document.querySelectorAll("#batch-fields .bf")].map(card => ({
        key: card.dataset.field,
        op: card.querySelector('input[type=radio]:checked')?.value,
        value: card.querySelector(".bf-value").value,
        disabled: card.querySelector(".bf-value").disabled,
      })),
      banners: [...document.querySelectorAll("#batch-report .banner")].map(b => ({
        cls: b.className,
        text: b.innerText.replace(/[ \t\r\n]+/g, " ").trim(),
      })),
      reportText: document.getElementById("batch-report").innerText.replace(/[ \t\r\n]+/g, " ").trim(),
    };
  });
}

async function selectRows(page, ids) {
  await page.evaluate(ids => {
    for (const id of ids) {
      document.querySelector(`#clients-body tr[data-id="${id}"] .row-check`).click();
    }
  }, ids);
}

async function setOp(page, key, op) {
  await page.evaluate(({key, op}) => {
    document.querySelector(`#batch-fields .bf[data-field="${key}"] input[value=${op}]`).click();
  }, {key, op});
}

async function typeValue(page, key, value) {
  await page.evaluate(({key, value}) => {
    const input = document.querySelector(`#batch-fields .bf[data-field="${key}"] .bf-value`);
    input.value = value;
    input.dispatchEvent(new Event("input", {bubbles: true}));
  }, {key, value});
}

async function chooseSet(page, key, value) {
  await setOp(page, key, "set");
  await typeValue(page, key, value);
}

const chooseKeep = (page, key) => setOp(page, key, "keep");
const chooseClear = (page, key) => setOp(page, key, "clear");

async function saveAndSettle(session) {
  const {page} = session;
  await page.click("#batch-submit");
  await page.waitForSelector("#batch-report .banner", {timeout: 3000});
  await page.waitForFunction(
    () => document.getElementById("batch-submit").textContent === "保存修改",
    {timeout: 5000});
  await new Promise(r => setTimeout(r, 50)); // 让横幅/列表渲染稳定
}

function successBanner(snap, n) {
  return snap.banners.some(b => b.cls.includes("ok") &&
    new RegExp(`已成功处理\\s*${n}\\s*名客户`).test(b.text));
}

// 「全部拒绝」横幅：bad 类、说明整次拒绝且资料保持原样、给出具体原因；
// 不出现任何成功数量。
function rejectedBanner(snap, phrase) {
  return snap.banners.some(b => b.cls.includes("bad") &&
    b.text.includes("全部拒绝") && b.text.includes("保持原样") &&
    b.text.includes(phrase)) &&
    !snap.banners.some(b => b.cls.includes("ok")) &&
    !/已成功处理/.test(snap.reportText);
}

// 保存成功后的清理：勾选清除、已选归零，四字段恢复保持原值、输入清空且不可填写
function cleanedUp(snap) {
  return snap.selCount === "0" &&
    snap.rows.every(r => !r.checked) &&
    snap.fields.every(f => f.op === "keep" && f.value === "" && f.disabled) &&
    snap.submitText === "保存修改" && snap.submitDisabled;
}

// 请求体中某字段的修改说明只有 op、不携带残留 value
function opOnly(spec, op) {
  return spec && spec.op === op && Object.keys(spec).length === 1;
}

function field(snap, key) {
  return snap.fields.find(f => f.key === key);
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

    // 甲乙丙资料各不相同；丙的来源/行业/重要日期原本为空；丁全程不被选中
    const [a, b, c, d] = await seed(base, [
      {name: "操作甲", source: "甲原有来源", region: "甲原地区", industry: "甲原行业", date: "2020-01-15"},
      {name: "操作乙", source: "乙原有来源", region: "乙原地区", industry: "乙原行业", date: "2021-06-30"},
      {name: "操作丙", region: "丙原地区"},
      {name: "操作丁", source: "丁来源", region: "丁地区", industry: "丁行业", date: "2022-02-02"},
    ]);
    const byId = (data, id) => data.clients.find(x => x.id === id);

    const browser = await puppeteer.launch({
      executablePath: process.env.CHROME || "/usr/bin/google-chrome",
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });

    try {
      // ===================================================================
      // 场景 1：设为填写的值并输入文字后改回「保持原值」——残留文字不写入、
      //         输入框不可填写也不清空，每名客户保留自己的原值；
      //         另一字段按最后选择的操作（设为填写的值）保存
      // ===================================================================
      {
        const session = await openSession(browser, base);
        const {page, payloads} = session;
        await selectRows(page, [a, b, c]);
        await chooseSet(page, "source", "  残留来源文字  ");
        await chooseKeep(page, "source"); // 改回保持原值：输入框残留文字且不可填写
        const before = await snapshot(page);
        check("1 改回保持原值后：来源输入框残留文字且不可填写、操作为 keep",
          field(before, "source").op === "keep" &&
          field(before, "source").value === "  残留来源文字  " &&
          field(before, "source").disabled,
          field(before, "source"));

        await chooseSet(page, "region", "  新地区  ");
        await saveAndSettle(session);
        const snap = await snapshot(page);

        check("1 保存成功：按实际选中的 3 名客户显示成功数量",
          successBanner(snap, 3), snap.banners);
        check("1 保存成功：勾选清除、四字段恢复保持原值、输入清空且不可填写",
          cleanedUp(snap), {sel: snap.selCount, fields: snap.fields});
        check("1 请求体：来源只有 {op:keep} 不携带残留文字，地区为 set 原文",
          payloads.length === 1 &&
          JSON.stringify(payloads[0].ids) === JSON.stringify([a, b, c].sort((x, y) => x - y)) &&
          opOnly(payloads[0].updates.source, "keep") &&
          payloads[0].updates.region.op === "set" &&
          payloads[0].updates.region.value === "  新地区  ",
          payloads);
        check("1 列表：来源列仍是各自原值（丙为未填写），地区列已更新",
          snap.rows.find(r => r.id === String(a)).cells[1] === "甲原有来源" &&
          snap.rows.find(r => r.id === String(b)).cells[1] === "乙原有来源" &&
          snap.rows.find(r => r.id === String(c)).cells[1] === "—" &&
          snap.rows.find(r => r.id === String(a)).cells[2] === "新地区" &&
          snap.rows.find(r => r.id === String(c)).cells[2] === "新地区",
          snap.rows);

        const real = await listClients(base);
        check("1 后端：甲乙来源各自保留原值、丙仍为空（残留文字未写入、未清空、不互补）",
          byId(real, a).source === "甲原有来源" &&
          byId(real, b).source === "乙原有来源" &&
          byId(real, c).source === null,
          [byId(real, a).source, byId(real, b).source, byId(real, c).source]);
        check("1 后端：地区按最后选择的操作保存（去前后空白）",
          byId(real, a).region === "新地区" &&
          byId(real, b).region === "新地区" &&
          byId(real, c).region === "新地区",
          real.clients.map(x => x.region));
        check("1 后端：未选中的丁完全不变",
          byId(real, d).source === "丁来源" && byId(real, d).region === "丁地区" &&
          byId(real, d).industry === "丁行业" && byId(real, d).important_date === "2022-02-02",
          byId(real, d));
        await page.close();
      }

      // ===================================================================
      // 场景 2：重要日期先填无效日期再改回「保持原值」——不妨碍其他有效修改
      // ===================================================================
      {
        const session = await openSession(browser, base);
        const {page, payloads} = session;
        await selectRows(page, [a, b]);
        await chooseSet(page, "important_date", "2023-02-29"); // 非闰年，无效
        await chooseKeep(page, "important_date");
        await chooseSet(page, "industry", "  新行业  ");
        await saveAndSettle(session);
        const snap = await snapshot(page);

        check("2 残留无效日期改回保持原值：保存成功（2 名），不报日期错误",
          successBanner(snap, 2) && !snap.banners.some(x => x.cls.includes("bad")),
          snap.banners);
        check("2 请求体：重要日期只有 {op:keep}，不携带残留无效日期",
          payloads.length === 1 && opOnly(payloads[0].updates.important_date, "keep"),
          payloads);
        check("2 列表：行业列已更新，重要日期列保持各自原值",
          snap.rows.find(r => r.id === String(a)).cells[3] === "新行业" &&
          snap.rows.find(r => r.id === String(b)).cells[3] === "新行业" &&
          snap.rows.find(r => r.id === String(a)).cells[4] === "2020-01-15" &&
          snap.rows.find(r => r.id === String(b)).cells[4] === "2021-06-30",
          snap.rows);
        const real = await listClients(base);
        check("2 后端：行业已保存、重要日期各自保持原值",
          byId(real, a).industry === "新行业" && byId(real, b).industry === "新行业" &&
          byId(real, a).important_date === "2020-01-15" &&
          byId(real, b).important_date === "2021-06-30",
          [byId(real, a), byId(real, b)]);
        check("2 保存成功：完成勾选与表单清理", cleanedUp(snap),
          {sel: snap.selCount, fields: snap.fields});
        await page.close();
      }

      // ===================================================================
      // 场景 3：最终选择「清空」——之前留下的文字或无效日期不再校验，
      //         保存后为未填写状态（列表 —，接口 null）
      // ===================================================================
      {
        const session = await openSession(browser, base);
        const {page, payloads} = session;
        await selectRows(page, [a, b]);
        await chooseSet(page, "source", "最终要被清空的残留文字");
        await chooseClear(page, "source");
        await chooseSet(page, "important_date", "2023-13-40"); // 无效日期
        await chooseClear(page, "important_date");
        await saveAndSettle(session);
        const snap = await snapshot(page);

        check("3 最终清空：保存成功（2 名），残留文字与无效日期不再校验",
          successBanner(snap, 2) && !snap.banners.some(x => x.cls.includes("bad")),
          snap.banners);
        check("3 请求体：来源与重要日期都只有 {op:clear}，不携带残留内容",
          payloads.length === 1 &&
          opOnly(payloads[0].updates.source, "clear") &&
          opOnly(payloads[0].updates.important_date, "clear"),
          payloads);
        check("3 列表：来源与重要日期列显示未填写",
          snap.rows.find(r => r.id === String(a)).cells[1] === "—" &&
          snap.rows.find(r => r.id === String(b)).cells[1] === "—" &&
          snap.rows.find(r => r.id === String(a)).cells[4] === "—" &&
          snap.rows.find(r => r.id === String(b)).cells[4] === "—",
          snap.rows);
        const real = await listClients(base);
        check("3 后端：接口返回来源与重要日期为 null",
          byId(real, a).source === null && byId(real, b).source === null &&
          byId(real, a).important_date === null && byId(real, b).important_date === null,
          [byId(real, a), byId(real, b)]);
        check("3 保存成功：完成勾选与表单清理", cleanedUp(snap),
          {sel: snap.selCount, fields: snap.fields});
        await page.close();
      }

      // ===================================================================
      // 场景 4：最终选择「设为填写的值」但只留下空白——四个字段都按清空处理；
      //         重要日期只填空格不报日期格式错误；原本为空的客户仍为空
      // ===================================================================
      {
        const session = await openSession(browser, base);
        const {page, payloads} = session;
        await selectRows(page, [a, b, c]);
        await chooseSet(page, "source", "   ");                 // 仅空格
        await chooseSet(page, "region", " \t \n  \t ");          // 空格/制表符/换行
        await chooseSet(page, "industry", "");                   // 明确选择设置但留空
        await chooseSet(page, "important_date", "   ");          // 仅空格，不得报日期错误
        await saveAndSettle(session);
        const snap = await snapshot(page);

        check("4 全空白输入：按清空处理保存成功（3 名），不报日期格式错误、不拒绝",
          successBanner(snap, 3) && !snap.banners.some(x => x.cls.includes("bad")),
          snap.banners);
        check("4 请求体：四个字段都是 set 且原样携带空白输入（由服务按清空处理）",
          payloads.length === 1 &&
          payloads[0].updates.source.op === "set" &&
          payloads[0].updates.source.value === "   " &&
          payloads[0].updates.region.op === "set" &&
          payloads[0].updates.region.value === " \t \n  \t " &&
          payloads[0].updates.industry.op === "set" &&
          payloads[0].updates.industry.value === "" &&
          payloads[0].updates.important_date.op === "set" &&
          payloads[0].updates.important_date.value === "   ",
          payloads);
        check("4 列表：四名客户四个字段全部显示未填写",
          [a, b, c].every(id => {
            const row = snap.rows.find(r => r.id === String(id));
            return row.cells[1] === "—" && row.cells[2] === "—" &&
              row.cells[3] === "—" && row.cells[4] === "—";
          }), snap.rows);
        const real = await listClients(base);
        check("4 后端：甲乙丙四个字段全部为 null（与明确选择清空结果相同）",
          [a, b, c].every(id => {
            const r = byId(real, id);
            return r.source === null && r.region === null &&
              r.industry === null && r.important_date === null;
          }), real.clients);
        check("4 后端：原本已为空的丙仍为空，未从其他客户补入内容",
          byId(real, c).source === null && byId(real, c).industry === null &&
          byId(real, c).important_date === null,
          byId(real, c));
        check("4 后端：未选中的丁完全不变",
          byId(real, d).source === "丁来源" && byId(real, d).region === "丁地区" &&
          byId(real, d).industry === "丁行业" && byId(real, d).important_date === "2022-02-02",
          byId(real, d));
        check("4 保存成功：完成勾选与表单清理", cleanedUp(snap),
          {sel: snap.selCount, fields: snap.fields});
        await page.close();
      }

      // ===================================================================
      // 场景 5：非空文本只去除前后空白，内部空白与换行按原规则保留；
      //         客户名称、编号不变
      // ===================================================================
      {
        const session = await openSession(browser, base);
        const {page} = session;
        await selectRows(page, [a]);
        await chooseSet(page, "source", "  内部  空白\n第二行\t保留  ");
        await chooseSet(page, "important_date", "  2024-02-29  "); // 去空白后再校验
        await saveAndSettle(session);
        const snap = await snapshot(page);

        check("5 内部空白：保存成功（1 名）", successBanner(snap, 1), snap.banners);
        check("5 列表：来源保留内部空白与换行、只去前后空白，重要日期去空白后保存",
          snap.rows.find(r => r.id === String(a)).cells[1] === "内部  空白\n第二行\t保留" &&
          snap.rows.find(r => r.id === String(a)).cells[4] === "2024-02-29",
          snap.rows.find(r => r.id === String(a)));
        check("5 列表：客户名称与编号不变",
          snap.rows.find(r => r.id === String(a)).cells[0] === "操作甲" &&
          snap.rows.find(r => r.id === String(a)).id === String(a),
          snap.rows.find(r => r.id === String(a)));
        const real = await listClients(base);
        check("5 后端：来源原样保留内部空白与换行，名称不变",
          byId(real, a).source === "内部  空白\n第二行\t保留" &&
          byId(real, a).name === "操作甲" &&
          byId(real, a).important_date === "2024-02-29",
          byId(real, a));
        check("5 后端：未选中的乙丙丁完全不变",
          byId(real, b).source === null && byId(real, c).region === null &&
          byId(real, d).source === "丁来源",
          [byId(real, b), byId(real, c), byId(real, d)]);
        await page.close();
      }

      // ===================================================================
      // 场景 6：四个字段最终全部「保持原值」——即使输入框留下文字，
      //         也整次拒绝并说明没有修改项；保留勾选、操作与填写供修正
      // ===================================================================
      {
        const session = await openSession(browser, base);
        const {page, payloads, counts} = session;
        await selectRows(page, [a, b]);
        await chooseSet(page, "source", "残留但不生效的来源");
        await chooseKeep(page, "source");
        await chooseSet(page, "region", "残留但不生效的地区");
        await chooseKeep(page, "region");
        await chooseSet(page, "industry", "残留但不生效的行业");
        await chooseKeep(page, "industry");
        await chooseSet(page, "important_date", "2030-01-01");
        await chooseKeep(page, "important_date");
        await saveAndSettle(session);
        const snap = await snapshot(page);

        check("6 全部保持原值：整次拒绝并说明没有修改项，不显示成功数量",
          rejectedBanner(snap, "保持原值"), snap.banners);
        check("6 请求体：四个字段都只有 {op:keep}，残留文字不替代操作选择",
          payloads.length === 1 &&
          ["source", "region", "industry", "important_date"]
            .every(k => opOnly(payloads[0].updates[k], "keep")),
          payloads);
        check("6 拒绝后：保留当前勾选（2 名）供修正",
          snap.selCount === "2" &&
          [a, b].every(id => snap.rows.find(r => r.id === String(id))?.checked),
          {sel: snap.selCount, rows: snap.rows.map(r => [r.id, r.checked])});
        check("6 拒绝后：四字段操作与残留填写保留（keep + 残留文字 + 不可填写）",
          [["source", "残留但不生效的来源"], ["region", "残留但不生效的地区"],
           ["industry", "残留但不生效的行业"], ["important_date", "2030-01-01"]]
            .every(([k, v]) => field(snap, k).op === "keep" &&
              field(snap, k).value === v && field(snap, k).disabled),
          snap.fields);
        check("6 拒绝后：按钮恢复「保存修改」且因有勾选可提交",
          snap.submitText === "保存修改" && !snap.submitDisabled,
          {text: snap.submitText, disabled: snap.submitDisabled});
        check("6 拒绝后：不触发列表刷新",
          counts.listGets === 1, `list gets=${counts.listGets}`);
        const real = await listClients(base);
        check("6 拒绝后：客户资料保持原样（残留文字未写入、未清空）",
          byId(real, a).source === "内部  空白\n第二行\t保留" &&
          byId(real, a).important_date === "2024-02-29" &&
          byId(real, b).source === null && byId(real, b).region === null,
          [byId(real, a), byId(real, b)]);
        await page.close();
      }

      // ===================================================================
      // 场景 7：重要日期最终选择「设为填写的值」且填写无效日期——整次拒绝，
      //         其他字段不先保存；修正操作选择后可再次保存成功
      // ===================================================================
      {
        const session = await openSession(browser, base);
        const {page, counts} = session;
        await selectRows(page, [a, b]);
        await chooseSet(page, "source", "拒绝后保留的来源");
        await chooseSet(page, "important_date", "2023-02-29"); // 非闰年，无效
        await saveAndSettle(session);
        const snap = await snapshot(page);

        check("7 无效日期：整次拒绝并给出含无效日期的具体原因，不显示成功数量",
          rejectedBanner(snap, "2023-02-29"), snap.banners);
        check("7 拒绝后：保留勾选（2 名）、来源与日期的 set 操作及已填内容",
          snap.selCount === "2" &&
          field(snap, "source").op === "set" &&
          field(snap, "source").value === "拒绝后保留的来源" &&
          !field(snap, "source").disabled &&
          field(snap, "important_date").op === "set" &&
          field(snap, "important_date").value === "2023-02-29" &&
          !field(snap, "important_date").disabled,
          {sel: snap.selCount, fields: snap.fields});
        check("7 拒绝后：按钮恢复「保存修改」且可提交",
          snap.submitText === "保存修改" && !snap.submitDisabled,
          {text: snap.submitText, disabled: snap.submitDisabled});
        const realRejected = await listClients(base);
        check("7 拒绝后：整次未生效——来源没有先保存，日期保持原值",
          byId(realRejected, a).source === "内部  空白\n第二行\t保留" &&
          byId(realRejected, b).source === null &&
          byId(realRejected, a).important_date === "2024-02-29" &&
          byId(realRejected, b).important_date === null,
          [byId(realRejected, a), byId(realRejected, b)]);

        // 用户把重要日期改回「保持原值」后直接再次保存：保留的勾选与填写可用
        await chooseKeep(page, "important_date");
        await saveAndSettle(session);
        const fixed = await snapshot(page);
        check("7 修正后：用保留的勾选与填写再次保存成功（2 名）并完成清理",
          successBanner(fixed, 2) && cleanedUp(fixed),
          {banners: fixed.banners, sel: fixed.selCount, fields: fixed.fields});
        const real = await listClients(base);
        check("7 修正后：来源按保留的填写落库，重要日期保持原值",
          byId(real, a).source === "拒绝后保留的来源" &&
          byId(real, b).source === "拒绝后保留的来源" &&
          byId(real, a).important_date === "2024-02-29" &&
          byId(real, b).important_date === null,
          [byId(real, a), byId(real, b)]);
        check("7 全程：拒绝不触发列表刷新，仅成功后刷新一次",
          counts.listGets === 2, `list gets=${counts.listGets}`);
        await page.close();
      }

      // ===================================================================
      // 场景 8：同一字段多次切换操作——以最后选定为准
      // ===================================================================
      {
        const session = await openSession(browser, base);
        const {page, payloads} = session;
        await selectRows(page, [b]);
        // 来源：set → clear → keep（最终保持原值，残留文字不生效）
        await chooseSet(page, "source", "第一版来源文字");
        await chooseClear(page, "source");
        await chooseKeep(page, "source");
        // 地区：set → keep → set（最终为最后一次填写的值）
        await chooseSet(page, "region", "地区第一版");
        await chooseKeep(page, "region");
        await chooseSet(page, "region", "  地区最终版  ");
        // 行业：clear → set → clear（最终清空）
        await chooseClear(page, "industry");
        await chooseSet(page, "industry", "行业临时值");
        await chooseClear(page, "industry");
        // 重要日期：set 无效日期 → clear（最终清空，残留无效日期不校验）
        await chooseSet(page, "important_date", "2023-02-29");
        await chooseClear(page, "important_date");
        await saveAndSettle(session);
        const snap = await snapshot(page);

        check("8 多次切换：保存成功（1 名），残留无效日期不校验",
          successBanner(snap, 1) && !snap.banners.some(x => x.cls.includes("bad")),
          snap.banners);
        check("8 请求体：以各字段最后选定的操作为准（keep / set 最终值 / clear / clear）",
          payloads.length === 1 &&
          opOnly(payloads[0].updates.source, "keep") &&
          payloads[0].updates.region.op === "set" &&
          payloads[0].updates.region.value === "  地区最终版  " &&
          opOnly(payloads[0].updates.industry, "clear") &&
          opOnly(payloads[0].updates.important_date, "clear"),
          payloads);
        const real = await listClients(base);
        check("8 后端：来源保持原值（非第一版文字、未被清空）、地区为最终值、行业与日期清空",
          byId(real, b).source === "拒绝后保留的来源" &&
          byId(real, b).region === "地区最终版" &&
          byId(real, b).industry === null &&
          byId(real, b).important_date === null,
          byId(real, b));
        check("8 列表：对应列与后端一致",
          snap.rows.find(r => r.id === String(b)).cells[1] === "拒绝后保留的来源" &&
          snap.rows.find(r => r.id === String(b)).cells[2] === "地区最终版" &&
          snap.rows.find(r => r.id === String(b)).cells[3] === "—" &&
          snap.rows.find(r => r.id === String(b)).cells[4] === "—",
          snap.rows.find(r => r.id === String(b)));
        check("8 保存成功：完成勾选与表单清理", cleanedUp(snap),
          {sel: snap.selCount, fields: snap.fields});
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

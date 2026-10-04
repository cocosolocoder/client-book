#!/usr/bin/env node
/**
 * 首页批量保存结果处理的页面层面回归保障。
 *
 * 启动真实 app.py 服务（与 smoke_test.py 同一后端，不模拟、不改动接口公开行为），
 * 用 Puppeteer 驱动系统 Chrome 打开首页，通过请求拦截分别「破坏」保存成功之后
 * 的那次客户列表读取，逐项验证：
 *
 * 1. 保存已确认成功、但随后客户列表读取失败：
 *      - 连接失败 / HTTP 非成功状态 / 响应无法解析 / 响应缺少 clients 数组
 *    页面仍明确显示「已成功处理 N 名客户」；成功数量以保存回复 updated_count
 *    为准，不按刷新后出现的记录数重算；同时提示列表暂未更新、当前资料可能仍是
 *    保存前内容、稍后刷新即可查看、无需再次保存；
 * 2. 保存确认成功后，无论列表是否读到：勾选清除、已选归零，来源/地区/行业/重要
 *    日期恢复「保持原值」，输入清空并回到不可填写状态；
 * 3. 列表读取失败时旧表格内容（编号、名称、各字段）保留，不清表、不显示
 *    「还没有客户记录」；结束保存等待、按钮恢复且无勾选时不可提交；不重发修改；
 * 4. 随后刷新/重新打开页面读取成功：显示真实资料、撤下读取失败提示；
 *    真实空列表正常显示空列表提示，不被当成读取失败；
 * 5. 保存成功且列表读取成功：显示处理数量、更新相关列、完成同样的勾选与编辑清理；
 * 6. 保存接口明确拒绝（HTTP 400 具体原因）：保留勾选、字段操作与已填内容供修正，
 *    不套用保存成功后的清理与提示；
 * 7. 保存请求尚未返回（等待期）：按钮显示「正在保存…」且不可再次保存，勾选信息、
 *    字段操作与填写内容原样保留、不显示成功数量；等待期内重复点击、输入框回车或直接
 *    触发表单提交都不能产生第二次修改请求，等待提示也不被替换成成功或「未选客户」错误；
 *    等待期内取消原勾选、勾选第三名客户、调整字段操作与输入都正常体现在页面上，但不解除
 *    等待；实际修改对象与字段值始终以第一次保存固化的请求为准（后勾客户不更新、后填值不
 *    替换、未改字段保留各客户原值），结果返回后不自动补交等待期间的改动；400 拒绝时显示
 *    具体原因、资料不变、保留返回结果时页面上的勾选与填写，等待结束后有选中客户才能再次
 *    保存。判定以实际发出的请求（次数与请求体）及后端客户资料为准，不仅凭按钮外观。
 */
import {spawn} from "node:child_process";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";
import {mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import puppeteer from "puppeteer";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, "app.py");
const TMP = mkdtempSync(join(tmpdir(), "clientbook-page-"));
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

// ---------------------------------------------------------------------------
// 页面驱动：请求拦截让 GET /api/clients 在「保存后的刷新」中按模式失败
// ---------------------------------------------------------------------------
async function openSession(browser, base) {
  const page = await browser.newPage();
  const modes = {
    // ok 正常转发；close 连接断开；500 非成功状态；bad-json 无法解析；
    // no-clients 可解析但缺少客户数组
    list: "ok",
    // batch 响应改写：null = 走真实后端；否则用给定 {status, body}
    batchOverride: null,
    // batch 挂起：true 时修改请求先扣在拦截器里不转发，直到 batchGate 放行
    batchHold: false,
  };
  const counts = {batchPosts: 0, listGets: 0};
  // 每次挂起的修改请求记录：{payload, release(override?)}
  const heldBatches = [];
  const gate = {
    held: heldBatches,
    holdOn() { modes.batchHold = true; },
    holdOff() { modes.batchHold = false; },
    // 放行挂起请求：override=null 转发给真实后端；否则用 {status, body} 就地应答
    async release(index = 0, override = null) {
      const held = heldBatches[index];
      if (!held) throw new Error(`没有第 ${index} 个挂起的修改请求（共 ${heldBatches.length} 个）`);
      await held.release(override);
      heldBatches.splice(index, 1);
    },
  };

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
    if (request.method() === "POST" && url.endsWith("/api/clients/batch-update")) {
      counts.batchPosts += 1;
      let payload = null;
      try { payload = JSON.parse(request.postData() || "{}"); } catch { payload = null; }
      const done = () => {
        if (modes.batchOverride) {
          const {status, body} = modes.batchOverride;
          request.respond({status, contentType: "application/json; charset=utf-8", body});
          return;
        }
        request.continue();
      };
      if (modes.batchHold) {
        // 扣住请求不放行：页面应一直处于等待状态，直到测试显式 release
        const entry = {
          payload,
          release: override => new Promise(resolve => {
            if (override) {
              request.respond({
                status: override.status,
                contentType: "application/json; charset=utf-8",
                body: override.body,
              });
            } else {
              request.continue();
            }
            // 等转发/应答真正被浏览器消化，避免后续断言赶在落库前
            setTimeout(resolve, 30);
          }),
        };
        heldBatches.push(entry);
        return;
      }
      done();
      return;
    }
    request.continue();
  });

  await page.setCacheEnabled(false);
  await page.goto(base + "/", {waitUntil: "networkidle0"});
  return {page, modes, counts, gate};
}

// 读取批量保存区域的全部可见状态
async function snapshot(page) {
  return page.evaluate(() => {
    const text = sel => document.querySelector(sel)?.textContent.trim() ?? null;
    const rows = [...document.querySelectorAll("#clients-body tr")].map(tr => ({
      id: tr.dataset.id,
      checked: tr.querySelector(".row-check").checked,
      selected: tr.classList.contains("selected"),
      // td: 0 勾选框, 1 编号, 2 名称, 3 来源, 4 地区, 5 行业, 6 重要日期
      cells: [...tr.querySelectorAll("td")].slice(2).map(td => td.textContent.trim()),
    }));
    return {
      selCount: text("#sel-count"),
      // renderSelection 重建的提示 span 没有保留静态 id，按可见文案识别更贴近用户所见
      selNoneHint: document.querySelector("#sel-list")?.textContent.includes("尚未勾选任何客户") ?? false,
      selChips: [...document.querySelectorAll(".sel-chip")]
        .map(c => c.textContent.replace(/\s*×$/, "").trim()),
      submitText: text("#batch-submit"),
      submitDisabled: document.getElementById("batch-submit").disabled,
      checkAllChecked: document.getElementById("check-all").checked,
      checkAllIndeterminate: document.getElementById("check-all").indeterminate,
      tableDisplay: getComputedStyle(document.getElementById("clients-table")).display,
      emptyOn: document.getElementById("clients-empty").classList.contains("on"),
      loadErrorOn: document.getElementById("clients-load-error").classList.contains("on"),
      loadErrorText: text("#clients-load-error"),
      rows,
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

async function chooseSet(page, key, value) {
  await page.evaluate(({key, value}) => {
    const card = document.querySelector(`#batch-fields .bf[data-field="${key}"]`);
    card.querySelector('input[value=set]').click();
    const input = card.querySelector(".bf-value");
    input.value = value;
    input.dispatchEvent(new Event("input", {bubbles: true}));
  }, {key, value});
}

async function chooseClear(page, key) {
  await page.evaluate(key => {
    document.querySelector(`#batch-fields .bf[data-field="${key}"] input[value=clear]`).click();
  }, key);
}

// 选择「设为填写的值」并用真实键盘输入（而非直接赋值），覆盖 focus/键入过程
async function chooseSetAndType(page, key, value) {
  await page.evaluate(key => {
    document.querySelector(`#batch-fields .bf[data-field="${key}"] input[value=set]`).click();
  }, key);
  await page.focus(`.bf[data-field="${key}"] .bf-value`);
  await page.keyboard.type(value);
}

// 全选输入框现有内容后用键盘替换
async function replaceFieldByTyping(page, key, value) {
  const handle = await page.$(`.bf[data-field="${key}"] .bf-value`);
  await handle.click();
  await page.keyboard.down("Control");
  await page.keyboard.press("A");
  await page.keyboard.up("Control");
  await page.keyboard.press("Backspace");
  await page.keyboard.type(value);
}

async function uncheckRows(page, ids) {
  await page.evaluate(ids => {
    for (const id of ids) {
      const box = document.querySelector(`#clients-body tr[data-id="${id}"] .row-check`);
      if (box && box.checked) box.click();
    }
  }, ids);
}

// 保存按钮 disabled 时真实点击与回车都到不了处理函数；requestSubmit 能绕过 disabled
// 直达提交处理函数——用它专门压处理函数自身的重入保护（若保护缺失就会发出第二次请求）。
async function dispatchFormSubmit(page) {
  await page.evaluate(() => {
    const form = document.getElementById("batch-form");
    form.requestSubmit();
  });
}

async function pressEnterInField(page, key) {
  await page.focus(`.bf[data-field="${key}"] .bf-value`);
  await page.keyboard.press("Enter");
}

async function waitForHeld(gate, n = 1, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (gate.held.length >= n) return;
    await new Promise(r => setTimeout(r, 20));
  }
  throw new Error(`等待中的修改请求未达到 ${n} 个（实际 ${gate.held.length}）`);
}

async function waitSaving(page) {
  await page.waitForFunction(
    () => {
      const btn = document.getElementById("batch-submit");
      return btn.textContent === "正在保存…" && btn.disabled;
    },
    {timeout: 3000});
}

async function waitSettled(page, timeoutMs = 5000) {
  await page.waitForFunction(
    () => document.getElementById("batch-submit").textContent === "保存修改",
    {timeout: timeoutMs});
  await new Promise(r => setTimeout(r, 50)); // 让横幅/列表渲染稳定
}

const FIELD_KEYS = ["source", "region", "industry", "important_date"];

// 校验拦截到的请求体：客户编号集合与逐字段操作/填写值必须与期望完全一致
function payloadProblems(actual, expectedIds, expectedUpdates) {
  const problems = [];
  if (!actual || typeof actual !== "object") {
    return ["请求体不是 JSON 对象：" + JSON.stringify(actual)];
  }
  const ids = Array.isArray(actual.ids) ? [...actual.ids].sort((x, y) => x - y) : null;
  const wantIds = [...expectedIds].sort((x, y) => x - y);
  if (JSON.stringify(ids) !== JSON.stringify(wantIds)) {
    problems.push(`ids=${JSON.stringify(ids)}，期望 ${JSON.stringify(wantIds)}`);
  }
  const updates = actual.updates || {};
  for (const key of FIELD_KEYS) {
    const got = updates[key] || {};
    const want = expectedUpdates[key] || {op: "keep"};
    if (got.op !== want.op) {
      problems.push(`${key}.op=${got.op}，期望 ${want.op}`);
    } else if (want.op === "set" && got.value !== want.value) {
      problems.push(`${key}.value=${JSON.stringify(got.value)}，期望 ${JSON.stringify(want.value)}`);
    }
  }
  return problems;
}

function busyBannerOnly(snap) {
  return snap.banners.length === 1 &&
    snap.banners[0].cls.includes("busy") &&
    snap.banners[0].text.includes("正在保存") &&
    !/已成功处理|全部拒绝|请求失败|请先勾选/.test(snap.reportText);
}

async function saveAndSettle(session) {
  const {page, counts} = session;
  const before = counts.batchPosts;
  await page.click("#batch-submit");
  await page.waitForSelector("#batch-report .banner", {timeout: 3000});
  await page.waitForFunction(
    () => document.getElementById("batch-submit").textContent === "保存修改",
    {timeout: 5000});
  await new Promise(r => setTimeout(r, 50)); // 让横幅/列表提示渲染稳定
  return before;
}

function successBanner(snap, n) {
  return snap.banners.some(b => b.cls.includes("ok") &&
    new RegExp(`已成功处理\\s*${n}\\s*名客户`).test(b.text));
}

function listWarnBanner(snap) {
  return snap.banners.some(b => b.cls.includes("warn") &&
    b.text.includes("读取客户列表失败") &&
    b.text.includes("列表暂未更新") &&
    b.text.includes("可能仍是保存前") &&
    /稍后.*(刷新|重新打开)|重新打开.*刷新/.test(b.text) &&
    b.text.includes("无需再次保存"));
}

function cleanedUp(snap) {
  return snap.selCount === "0" &&
    snap.selNoneHint && snap.selChips.length === 0 &&
    !snap.checkAllChecked && !snap.checkAllIndeterminate &&
    snap.rows.every(r => !r.checked && !r.selected) &&
    snap.fields.every(f => f.op === "keep" && f.value === "" && f.disabled) &&
    snap.submitText === "保存修改" && snap.submitDisabled;
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

    const [a, b, c] = await seed(base, [
      {name: "页测甲", source: "老客户推荐", region: "华东", industry: "制造业", date: "2020-01-15"},
      {name: "页测乙", source: "展会", region: "华南", industry: "零售业", date: "2021-06-30"},
      {name: "页测丙", source: "广告", region: "华北", industry: "互联网", date: "2022-12-01"},
    ]);

    const browser = await puppeteer.launch({
      executablePath: process.env.CHROME || "/usr/bin/google-chrome",
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });

    try {
      // ===================================================================
      // 场景 A：保存成功，但随后列表读取「连接失败」
      // ===================================================================
      {
        const session = await openSession(browser, base);
        const {page, modes} = session;
        const init = await snapshot(page);
        check("A 初始：表格显示三名客户", init.rows.length === 3, init.rows);
        check("A 初始：无读取失败提示", !init.loadErrorOn, init.loadErrorText);
        check("A 初始：已选 0、保存按钮禁用",
          init.selCount === "0" && init.submitDisabled,
          {sel: init.selCount, disabled: init.submitDisabled});
        check("A 初始：四字段均保持原值、输入清空且不可填写",
          init.fields.every(f => f.op === "keep" && f.value === "" && f.disabled), init.fields);

        await selectRows(page, [a, b]);
        await chooseSet(page, "source", "  页面新来源  ");
        await chooseClear(page, "industry");
        const edited = await snapshot(page);
        check("A 填写后：已选 2、按钮可提交、来源可填写、行业选择清空",
          edited.selCount === "2" && !edited.submitDisabled &&
          edited.fields.find(f => f.key === "source").op === "set" &&
          !edited.fields.find(f => f.key === "source").disabled &&
          edited.fields.find(f => f.key === "source").value === "  页面新来源  " &&
          edited.fields.find(f => f.key === "industry").op === "clear",
          edited.fields);

        modes.list = "close";
        const beforePosts = session.counts.batchPosts;
        await saveAndSettle(session);
        modes.list = "ok";
        const snap = await snapshot(page);

        check("A 连接失败：仍明确显示「已成功处理 2 名客户」",
          successBanner(snap, 2), snap.banners);
        check("A 成功措辞不被改说成全部拒绝/请求失败/尚未保存",
          !/全部拒绝|请求失败|尚未保存|没有保存|未保存/.test(snap.reportText),
          snap.reportText);
        check("A 连接失败：警告同时说明列表暂未更新、可能仍是保存前内容、稍后刷新、无需再次保存",
          listWarnBanner(snap), snap.banners);
        check("A 连接失败：页内列表读取失败提示也出现", snap.loadErrorOn, snap.loadErrorText);
        check("A 连接失败：旧表三行编号/名称/字段全部保留",
          snap.rows.length === 3 &&
          JSON.stringify(snap.rows.map(r => r.cells[0])) ===
            JSON.stringify(["页测甲", "页测乙", "页测丙"]),
          snap.rows);
        check("A 连接失败：旧表仍是保存前来源（读取失败未清空也未更新表格）",
          snap.rows.find(r => r.id === String(a)).cells[1] === "老客户推荐" &&
          snap.rows.find(r => r.id === String(b)).cells[1] === "展会",
          snap.rows);
        check("A 连接失败：不显示「还没有客户记录」，表格仍可见",
          !snap.emptyOn && snap.tableDisplay === "table",
          {empty: snap.emptyOn, display: snap.tableDisplay});
        check("A 连接失败：勾选清零、已选归零、四字段恢复保持原值且输入清空禁用、按钮恢复禁用",
          cleanedUp(snap), {sel: snap.selCount, fields: snap.fields, btn: snap.submitText,
            disabled: snap.submitDisabled});
        check("A 连接失败：保存请求只发出一次，未因读取失败重发修改",
          session.counts.batchPosts === beforePosts + 1,
          `batch posts=${session.counts.batchPosts}`);

        // 后端数据确已落库——成功结论只取决于保存回复
        const real = await listClients(base);
        check("A 连接失败：后端来源已保存、行业已清空",
          real.clients.find(x => x.id === a).source === "页面新来源" &&
          real.clients.find(x => x.id === a).industry === null &&
          real.clients.find(x => x.id === b).source === "页面新来源",
          real.clients);
        check("A 连接失败：未勾选客户完全不变",
          real.clients.find(x => x.id === c).source === "广告" &&
          real.clients.find(x => x.id === c).industry === "互联网",
          real.clients.find(x => x.id === c));

        // 随后刷新页面、读取成功：撤下失败提示并显示真实资料
        modes.list = "ok";
        await page.reload({waitUntil: "networkidle0"});
        const refreshed = await snapshot(page);
        check("A 刷新后：读取失败提示撤下", !refreshed.loadErrorOn, refreshed.loadErrorText);
        check("A 刷新后：显示真实保存结果（来源已更新、行业为空）",
          refreshed.rows.find(r => r.id === String(a)).cells[1] === "页面新来源" &&
          refreshed.rows.find(r => r.id === String(a)).cells[3] === "—" &&
          refreshed.rows.find(r => r.id === String(c)).cells[1] === "广告",
          refreshed.rows);
        check("A 刷新后：无勾选残留、四字段保持原值、按钮禁用", cleanedUp(refreshed),
          {sel: refreshed.selCount, fields: refreshed.fields});
        await page.close();
      }

      // ===================================================================
      // 场景 B：保存成功，列表返回 HTTP 500（非成功状态）
      // ===================================================================
      {
        const session = await openSession(browser, base);
        const {page, modes} = session;
        await selectRows(page, [a, b]);
        await chooseSet(page, "region", "  新区号  ");
        modes.list = "500";
        const beforePosts = session.counts.batchPosts;
        await saveAndSettle(session);
        modes.list = "ok";
        const snap = await snapshot(page);

        check("B 500：仍显示已成功处理 2 名", successBanner(snap, 2), snap.banners);
        check("B 500：警告说明列表暂未更新、稍后刷新、无需再次保存",
          listWarnBanner(snap), snap.banners);
        check("B 500：页内失败提示出现", snap.loadErrorOn, snap.loadErrorText);
        check("B 500：旧表三行保留、不显示空列表提示",
          snap.rows.length === 3 && !snap.emptyOn, snap.rows);
        check("B 500：勾选与编辑全部清理、按钮恢复且禁用", cleanedUp(snap),
          {sel: snap.selCount, fields: snap.fields});
        check("B 500：保存请求未重发",
          session.counts.batchPosts === beforePosts + 1, session.counts.batchPosts);
        check("B 500：后端地区确已保存",
          (await listClients(base)).clients.find(x => x.id === a).region === "新区号",
          "后端 region");
        await page.close();
      }

      // ===================================================================
      // 场景 C：保存成功，列表返回无法解析的数据 / 缺少 clients 数组
      // ===================================================================
      for (const mode of ["bad-json", "no-clients"]) {
        const session = await openSession(browser, base);
        const {page, modes} = session;
        await selectRows(page, [a, b]);
        await chooseSet(page, "industry", `  行业-${mode}  `);
        modes.list = mode;
        const beforePosts = session.counts.batchPosts;
        await saveAndSettle(session);
        modes.list = "ok";
        const snap = await snapshot(page);

        check(`C ${mode}：仍以保存回复显示已成功处理 2 名`,
          successBanner(snap, 2), snap.banners);
        check(`C ${mode}：读取失败警告在（列表暂未更新、无需再次保存）`,
          listWarnBanner(snap), snap.banners);
        check(`C ${mode}：页内失败提示出现、旧表保留、不空表`,
          snap.loadErrorOn && snap.rows.length === 3 && !snap.emptyOn,
          {err: snap.loadErrorOn, rows: snap.rows.length, empty: snap.emptyOn});
        check(`C ${mode}：勾选清零、四字段恢复保持原值、输入清空禁用`,
          cleanedUp(snap), {sel: snap.selCount, fields: snap.fields});
        check(`C ${mode}：保存请求未重发`,
          session.counts.batchPosts === beforePosts + 1, session.counts.batchPosts);
        check(`C ${mode}：后端行业确已保存（去前后空白）`,
          (await listClients(base)).clients.find(x => x.id === a).industry ===
            `行业-${mode}`,
          "后端 industry");
        await page.close();
      }

      // 第二次（no-clients）把行业覆盖为 行业-no-clients，供后续场景核对
      const realNow = await listClients(base);
      check("C 收尾：两次保存都真实生效，以后一次回复的处理为准",
        realNow.clients.find(x => x.id === a).industry === "行业-no-clients" &&
        realNow.clients.find(x => x.id === b).industry === "行业-no-clients",
        {a: realNow.clients.find(x => x.id === a).industry,
         b: realNow.clients.find(x => x.id === b).industry});

      // ===================================================================
      // 场景 D：读取失败后不重发（直接计数）；重新打开页面读取成功即恢复
      // ===================================================================
      {
        const session = await openSession(browser, base);
        const {page, modes} = session;
        await selectRows(page, [a, c]);
        await chooseSet(page, "source", "再改一次");
        modes.list = "close";
        const beforePosts = session.counts.batchPosts;
        await saveAndSettle(session);
        modes.list = "ok";
        const snap = await snapshot(page);

        check("D 失败当次：成功数量仍以保存回复为准（2 名）",
          successBanner(snap, 2), snap.banners);
        check("D 失败当次：保存请求全程仅 1 次，读取失败不触发重发",
          session.counts.batchPosts === beforePosts + 1 &&
          session.counts.batchPosts === beforePosts + 1,
          `posts=${session.counts.batchPosts}`);
        check("D 失败当次：旧表仍显示保存前来源，勾选与编辑已清理、按钮禁用",
          snap.rows.find(r => r.id === String(a)).cells[1] === "页面新来源" &&
          snap.rows.find(r => r.id === String(c)).cells[1] === "广告" &&
          cleanedUp(snap),
          snap.rows);

        // 模拟用户重新打开页面（全新标签页）读取成功
        const reopened = await openSession(browser, base);
        const rsnap = await snapshot(reopened.page);
        check("D 重新打开：失败提示撤下", !rsnap.loadErrorOn, rsnap.loadErrorText);
        check("D 重新打开：显示真实来源（a/c 已改、b 保持）",
          rsnap.rows.find(r => r.id === String(a)).cells[1] === "再改一次" &&
          rsnap.rows.find(r => r.id === String(c)).cells[1] === "再改一次" &&
          rsnap.rows.find(r => r.id === String(b)).cells[1] === "页面新来源",
          rsnap.rows);
        check("D 重新打开：无勾选、四字段保持原值、按钮禁用", cleanedUp(rsnap),
          {sel: rsnap.selCount, fields: rsnap.fields});
        await page.close();
        await reopened.page.close();
      }

      // ===================================================================
      // 场景 E：保存成功且列表读取成功（正常路径）
      // ===================================================================
      {
        const session = await openSession(browser, base);
        const {page} = session;
        await selectRows(page, [b, c]);
        await chooseSet(page, "important_date", "2024-02-29");
        const beforePosts = session.counts.batchPosts;
        await saveAndSettle(session);
        const snap = await snapshot(page);

        check("E 正常路径：显示已成功处理 2 名且说明列表已更新",
          snap.banners.some(x => x.cls.includes("ok") &&
            /已成功处理\s*2\s*名客户/.test(x.text) && x.text.includes("列表已更新")),
          snap.banners);
        check("E 正常路径：无读取失败提示与警告横幅",
          !snap.loadErrorOn && !snap.banners.some(x => x.cls.includes("warn")),
          {err: snap.loadErrorOn, banners: snap.banners});
        check("E 正常路径：重要日期列即时更新为 2024-02-29",
          snap.rows.find(r => r.id === String(b)).cells[4] === "2024-02-29" &&
          snap.rows.find(r => r.id === String(c)).cells[4] === "2024-02-29",
          snap.rows);
        check("E 正常路径：勾选清除、已选归零、四字段恢复、输入清空禁用、按钮恢复禁用",
          cleanedUp(snap), {sel: snap.selCount, fields: snap.fields});
        check("E 正常路径：保存请求仅 1 次",
          session.counts.batchPosts === beforePosts + 1, session.counts.batchPosts);
        await page.close();
      }

      // ===================================================================
      // 场景 F：保存接口明确拒绝（400 具体原因）——保留勾选与已填内容
      // ===================================================================
      {
        const session = await openSession(browser, base);
        const {page} = session;
        await selectRows(page, [a, b]);
        await chooseSet(page, "source", "被拒绝也应保留的来源");
        await chooseClear(page, "industry");
        await chooseSet(page, "important_date", "2023-02-29"); // 非闰年 2/29 → 400
        const beforePosts = session.counts.batchPosts;
        await saveAndSettle(session);
        const snap = await snapshot(page);

        check("F 拒绝：显示「全部拒绝」并给出具体原因（含非法日期）",
          snap.banners.some(x => x.cls.includes("bad") &&
            x.text.includes("全部拒绝") && x.text.includes("2023-02-29")),
          snap.banners);
        check("F 拒绝：不显示成功横幅或读取失败警告",
          !snap.banners.some(x => x.cls.includes("ok") || x.cls.includes("warn")),
          snap.banners);
        check("F 拒绝：勾选保留（已选仍为 2、两行复选框仍勾选、全选框为半选状态）",
          snap.selCount === "2" &&
          [a, b].every(id => snap.rows.find(r => r.id === String(id))?.checked) &&
          snap.checkAllIndeterminate,
          {sel: snap.selCount, rows: snap.rows, indeterminate: snap.checkAllIndeterminate});
        check("F 拒绝：来源仍为 set 且已填文本保留、输入可填写；行业仍为 clear；日期仍为 set 且保留非法值",
          snap.fields.find(f => f.key === "source").op === "set" &&
          snap.fields.find(f => f.key === "source").value === "被拒绝也应保留的来源" &&
          !snap.fields.find(f => f.key === "source").disabled &&
          snap.fields.find(f => f.key === "industry").op === "clear" &&
          snap.fields.find(f => f.key === "important_date").op === "set" &&
          snap.fields.find(f => f.key === "important_date").value === "2023-02-29" &&
          !snap.fields.find(f => f.key === "important_date").disabled,
          snap.fields);
        check("F 拒绝：按钮恢复「保存修改」且因仍有勾选保持可提交",
          snap.submitText === "保存修改" && !snap.submitDisabled,
          {text: snap.submitText, disabled: snap.submitDisabled});
        check("F 拒绝：表格未被清理、无空列表/读取失败提示",
          snap.rows.length === 3 && !snap.emptyOn && !snap.loadErrorOn,
          {rows: snap.rows.length, empty: snap.emptyOn, err: snap.loadErrorOn});

        const real = await listClients(base);
        check("F 拒绝：后端未被部分写入（来源保持拒绝前的值、行业未被清空）",
          real.clients.find(x => x.id === a).source === "再改一次" &&
          real.clients.find(x => x.id === b).source === "页面新来源" &&
          real.clients.find(x => x.id === a).industry === "行业-no-clients",
          {a: real.clients.find(x => x.id === a).source,
           b: real.clients.find(x => x.id === b).source});

        // 用户修正日期后再次保存：保留的勾选与填写直接可用，成功后正常清理
        await page.evaluate(() => {
          const card = document.querySelector('#batch-fields .bf[data-field="important_date"]');
          card.querySelector(".bf-value").value = "2024-02-29";
        });
        await saveAndSettle(session);
        const fixed = await snapshot(page);
        check("F 修正后：用保留的勾选与填写再次保存成功（2 名）并完成清理",
          successBanner(fixed, 2) && cleanedUp(fixed),
          {banners: fixed.banners, sel: fixed.selCount, fields: fixed.fields});
        await page.close();
      }

      // ===================================================================
      // 场景 G：成功数量严格以保存回复为准，不按刷新后的记录数计算
      //         （保存回复 5 名，但列表只有 3 行）
      // ===================================================================
      {
        const session = await openSession(browser, base);
        const {page, modes} = session;
        await selectRows(page, [a]);
        await chooseSet(page, "region", "数量以回复为准");
        modes.batchOverride = {status: 200, body: JSON.stringify({updated_count: 5})};
        await saveAndSettle(session);
        const snap = await snapshot(page);

        check("G 回复 5 名/表格 3 行/勾选 1 名：页面显示 5 名且说明列表已更新",
          snap.banners.some(x => x.cls.includes("ok") &&
            /已成功处理\s*5\s*名客户/.test(x.text) && x.text.includes("列表已更新")),
          snap.banners);
        check("G 回复 5 名：勾选与编辑同样完成清理、按钮恢复禁用",
          cleanedUp(snap), {sel: snap.selCount, fields: snap.fields});
        await page.close();
      }

      // ===================================================================
      // 等待期回归（保存请求尚未返回）：独立应用 + 三名资料各异的客户
      //
      //   I：成功路径。首次保存 ids=[p1,p2]、来源 set「  等待期新来源  」、
      //      行业 clear、地区/日期 keep；等待期内重复提交（点击/回车/直达处理函数）、
      //      取消原勾选、勾选 p3、取消全部再重选、调整字段操作与输入——
      //      都只能有这一次请求，处理对象与值以首次固化内容为准，返回后不补交。
      //   J：400 拒绝路径。拒绝后保留返回结果时页面上的勾选/操作/填写，
      //      有勾选才能再次保存；修正后能正常发起新请求。
      //   K：等待结束时已无勾选：成功后按钮保持不可提交，等待期勾过的客户不更新。
      // ===================================================================
      {
        const {proc: pendProc, port: pendPortP} = startApp("pending");
        try {
          const pendBase = `http://127.0.0.1:${await pendPortP}`;
          await waitReady(pendBase);
          const [p1, p2, p3] = await seed(pendBase, [
            {name: "等待甲", source: "老客介绍", region: "华东", industry: "制造业", date: "2020-01-15"},
            {name: "等待乙", source: "展会名片", region: "华南", industry: "零售业", date: "2021-06-30"},
            {name: "等待丙", source: "线上广告", region: "华北", industry: "互联网", date: "2022-12-01"},
          ]);
          const firstUpdates = {
            source: {op: "set", value: "  等待期新来源  "},
            region: {op: "keep"},
            industry: {op: "clear"},
            important_date: {op: "keep"},
          };

          // ---------------------------------------------------------------
          // 场景 I：等待期全行为（成功）
          // ---------------------------------------------------------------
          {
            const session = await openSession(browser, pendBase);
            const {page, gate} = session;
            await selectRows(page, [p1, p2]);
            await chooseSet(page, "source", "  等待期新来源  ");
            await chooseClear(page, "industry");
            const edited = await snapshot(page);
            check("I 填写后：已选 2、按钮可提交、来源带空格文本、行业清空",
              edited.selCount === "2" && !edited.submitDisabled &&
              edited.fields.find(f => f.key === "source").value === "  等待期新来源  " &&
              edited.fields.find(f => f.key === "industry").op === "clear" &&
              edited.fields.find(f => f.key === "region").op === "keep" &&
              edited.fields.find(f => f.key === "important_date").op === "keep",
              edited.fields);

            // 挂起保存请求：先不转发给真实后端
            const beforePosts = session.counts.batchPosts;
            gate.holdOn();
            await page.click("#batch-submit");
            await waitForHeld(gate, 1);
            await waitSaving(page);
            const w1 = await snapshot(page);

            check("I 等待中：按钮显示「正在保存…」且不可再次保存",
              w1.submitText === "正在保存…" && w1.submitDisabled,
              {text: w1.submitText, disabled: w1.submitDisabled});
            check("I 等待中：只显示等待提示，不显示成功数量，也没有拒绝/未选客户错误",
              busyBannerOnly(w1), w1.banners);
            check("I 等待中：选中信息保留（已选 2，两名客户都在）",
              w1.selCount === "2" && w1.selChips.length === 2 &&
              w1.selChips.some(t => t.includes(`#${p1}`)) &&
              w1.selChips.some(t => t.includes(`#${p2}`)) &&
              w1.rows.filter(r => r.checked).map(r => r.id).sort().join(",") ===
                [p1, p2].sort().join(","),
              {count: w1.selCount, chips: w1.selChips,
               checked: w1.rows.filter(r => r.checked).map(r => r.id)});
            check("I 等待中：字段操作与填写内容原样保留（来源 set 文本仍在、行业仍 clear）",
              w1.fields.find(f => f.key === "source").op === "set" &&
              w1.fields.find(f => f.key === "source").value === "  等待期新来源  " &&
              !w1.fields.find(f => f.key === "source").disabled &&
              w1.fields.find(f => f.key === "industry").op === "clear",
              w1.fields);
            check("I 等待中：修改请求只发出 1 次且尚未到达服务（挂起 1 个）",
              session.counts.batchPosts === beforePosts + 1 && gate.held.length === 1,
              `posts=${session.counts.batchPosts}, held=${gate.held.length}`);
            const bodyProblems = payloadProblems(gate.held[0].payload, [p1, p2], firstUpdates);
            check("I 等待中：挂起的请求体正是首次勾选与填写（ids/逐字段操作与值完全一致）",
              bodyProblems.length === 0, bodyProblems);
            const before = await listClients(pendBase);
            check("I 等待中：后端客户资料此刻完全未变（请求尚未放行）",
              before.clients.find(x => x.id === p1).source === "老客介绍" &&
              before.clients.find(x => x.id === p1).industry === "制造业" &&
              before.clients.find(x => x.id === p2).source === "展会名片" &&
              before.clients.find(x => x.id === p3).source === "线上广告",
              before.clients);

            // 等待期内重复提交：真实点击按钮、输入框回车（隐式提交）、绕过 disabled
            // 直达提交处理函数——三种方式都不能产生第二次修改请求。
            await page.click("#batch-submit"); // disabled：真实点击应无效
            // 等待期把重要日期切成 set（允许的字段调整），其单行文本框回车才是真实隐式提交
            await chooseSetAndType(page, "important_date", "2025-01-01");
            await pressEnterInField(page, "important_date");
            await dispatchFormSubmit(page); // requestSubmit 绕过按钮 disabled，直压处理函数
            await new Promise(r => setTimeout(r, 60));
            const w1b = await snapshot(page);
            check("I 重复提交（点击/回车/直达处理函数）：未发出第二次修改请求（计数与挂起数不变）",
              session.counts.batchPosts === beforePosts + 1 && gate.held.length === 1,
              `posts=${session.counts.batchPosts}, held=${gate.held.length}`);
            check("I 重复提交后：按钮仍等待禁用，等待提示未被成功或未选客户错误替换",
              w1b.submitText === "正在保存…" && w1b.submitDisabled && busyBannerOnly(w1b),
              {text: w1b.submitText, banners: w1b.banners});

            // 等待期内改变勾选与字段：页面正常反映，但不解除等待
            await uncheckRows(page, [p1]);      // 取消原来的勾选之一
            await selectRows(page, [p3]);       // 勾选第三名客户
            await replaceFieldByTyping(page, "source", "等待期改的来源"); // 改已提交字段的值
            await chooseSetAndType(page, "region", "等待期地区");         // 把 keep 改成 set
            await new Promise(r => setTimeout(r, 30));
            const w2 = await snapshot(page);
            check("I 等待期改动正常体现：已选为 p2/p3，p1 已取消，来源/地区/日期显示新操作与输入",
              w2.selCount === "2" &&
              w2.rows.find(r => r.id === String(p1)).checked === false &&
              w2.rows.find(r => r.id === String(p2)).checked === true &&
              w2.rows.find(r => r.id === String(p3)).checked === true &&
              w2.selChips.some(t => t.includes(`#${p2}`)) &&
              w2.selChips.some(t => t.includes(`#${p3}`)) &&
              !w2.selChips.some(t => t.includes(`#${p1} `)) &&
              w2.fields.find(f => f.key === "source").value === "等待期改的来源" &&
              w2.fields.find(f => f.key === "region").op === "set" &&
              w2.fields.find(f => f.key === "region").value === "等待期地区" &&
              w2.fields.find(f => f.key === "important_date").value === "2025-01-01",
              {count: w2.selCount, chips: w2.selChips, fields: w2.fields});
            check("I 等待期改动后：按钮仍等待禁用、等待提示不变、请求仍只有 1 个",
              w2.submitText === "正在保存…" && w2.submitDisabled && busyBannerOnly(w2) &&
              session.counts.batchPosts === beforePosts + 1 && gate.held.length === 1,
              {text: w2.submitText, posts: session.counts.batchPosts});

            // 先取消全部勾选再重新选择：仍不能重新提交；全空时直达提交也不能把等待提示
            // 换成「未选客户」错误（batchSaving 守护先于空勾选分支）。
            await uncheckRows(page, [p2, p3]);
            await new Promise(r => setTimeout(r, 30));
            const w3 = await snapshot(page);
            check("I 取消全部勾选：页面已选归零，但按钮等待状态不解除",
              w3.selCount === "0" && w3.submitText === "正在保存…" && w3.submitDisabled,
              {count: w3.selCount, text: w3.submitText});
            await dispatchFormSubmit(page);
            await pressEnterInField(page, "important_date");
            await new Promise(r => setTimeout(r, 30));
            const w3b = await snapshot(page);
            check("I 全空时重复提交：不新增请求，等待提示不被「请先勾选」错误替换",
              session.counts.batchPosts === beforePosts + 1 && gate.held.length === 1 &&
              busyBannerOnly(w3b),
              {posts: session.counts.batchPosts, banners: w3b.banners});
            await selectRows(page, [p1, p2]); // 重新选择
            await dispatchFormSubmit(page);
            await page.click("#batch-submit");
            await new Promise(r => setTimeout(r, 30));
            check("I 重新勾选后再次提交：仍不能重新提交（请求计数与挂起数不变）",
              session.counts.batchPosts === beforePosts + 1 && gate.held.length === 1,
              `posts=${session.counts.batchPosts}, held=${gate.held.length}`);

            // 放行首次（也是唯一一次）请求给真实后端
            gate.holdOff();
            await gate.release(0);
            await waitSettled(page);
            const done = await snapshot(page);

            check("I 放行后：显示本次回复处理数量 2 名且说明列表已更新",
              done.banners.some(x => x.cls.includes("ok") &&
                /已成功处理\s*2\s*名客户/.test(x.text) && x.text.includes("列表已更新")),
              done.banners);
            check("I 放行后：勾选清空、四字段恢复保持原值/输入清空禁用、无勾选按钮不可提交",
              cleanedUp(done), {sel: done.selCount, fields: done.fields,
                text: done.submitText, disabled: done.submitDisabled});
            check("I 放行后：全程修改请求仅 1 次，等待期间改动未被自动补交",
              session.counts.batchPosts === beforePosts + 1,
              `posts=${session.counts.batchPosts}`);

            const after = await listClients(pendBase);
            check("I 后端：p1/p2 按首次请求更新（来源去前后空白、行业清空）",
              after.clients.find(x => x.id === p1).source === "等待期新来源" &&
              after.clients.find(x => x.id === p1).industry === null &&
              after.clients.find(x => x.id === p2).source === "等待期新来源" &&
              after.clients.find(x => x.id === p2).industry === null,
              after.clients);
            check("I 后端：未修改字段保留各客户原有资料（地区、重要日期均不变）",
              after.clients.find(x => x.id === p1).region === "华东" &&
              after.clients.find(x => x.id === p1).important_date === "2020-01-15" &&
              after.clients.find(x => x.id === p2).region === "华南" &&
              after.clients.find(x => x.id === p2).important_date === "2021-06-30",
              after.clients);
            check("I 后端：后来勾选的 p3 未被更新；等待期改填的值一个都未入库",
              after.clients.find(x => x.id === p3).source === "线上广告" &&
              after.clients.find(x => x.id === p3).region === "华北" &&
              after.clients.find(x => x.id === p3).industry === "互联网" &&
              after.clients.find(x => x.id === p3).important_date === "2022-12-01" &&
              JSON.stringify(after.clients).includes("等待期改的来源") === false &&
              JSON.stringify(after.clients).includes("等待期地区") === false &&
              JSON.stringify(after.clients).includes("2025-01-01") === false,
              after.clients);
            check("I 列表：呈现本次已提交修改（来源两行为新值、行业为空），p3 行原样",
              done.rows.find(r => r.id === String(p1)).cells[1] === "等待期新来源" &&
              done.rows.find(r => r.id === String(p1)).cells[3] === "—" &&
              done.rows.find(r => r.id === String(p2)).cells[1] === "等待期新来源" &&
              done.rows.find(r => r.id === String(p3)).cells[1] === "线上广告" &&
              done.rows.find(r => r.id === String(p3)).cells[3] === "互联网",
              done.rows);
            await page.close();
          }

          // ---------------------------------------------------------------
          // 场景 J：等待后被服务明确 400 拒绝——保留返回结果时的页面状态，
          //         等待结束后有选中客户才能再次保存；修正后可发新请求
          // ---------------------------------------------------------------
          {
            const session = await openSession(browser, pendBase);
            const {page, gate} = session;
            await selectRows(page, [p3]);
            await chooseSetAndType(page, "important_date", "2023-02-29"); // 非闰年 → 400
            const beforePosts = session.counts.batchPosts;
            gate.holdOn();
            await page.click("#batch-submit");
            await waitForHeld(gate, 1);
            await waitSaving(page);

            // 等待期：加勾 p1、给来源设值；这些是「返回结果时页面上」的状态
            await selectRows(page, [p1]);
            await chooseSetAndType(page, "source", "拒绝等待期来源");
            await dispatchFormSubmit(page); // 等待期重复提交仍被忽略
            const wj = await snapshot(page);
            check("J 等待中：加勾与填写正常体现但等待不解除、无第二次请求",
              wj.selCount === "2" && wj.submitText === "正在保存…" && wj.submitDisabled &&
              wj.fields.find(f => f.key === "source").value === "拒绝等待期来源" &&
              session.counts.batchPosts === beforePosts + 1 && gate.held.length === 1,
              {count: wj.selCount, fields: wj.fields, posts: session.counts.batchPosts});

            // 放行给真实后端：首次请求 ids=[p3]、日期 2023-02-29 → 整次 400
            const heldProblems = payloadProblems(gate.held[0].payload, [p3], {
              source: {op: "keep"},
              region: {op: "keep"},
              industry: {op: "keep"},
              important_date: {op: "set", value: "2023-02-29"},
            });
            check("J 被拒请求体：仍是首次提交（仅 p3、日期非法），不含等待期改动",
              heldProblems.length === 0, heldProblems);
            gate.holdOff();
            await gate.release(0);
            await waitSettled(page);
            const rj = await snapshot(page);

            check("J 拒绝：显示「全部拒绝」与具体原因（含非法日期 2023-02-29），无成功横幅",
              rj.banners.some(x => x.cls.includes("bad") &&
                x.text.includes("全部拒绝") && x.text.includes("2023-02-29")) &&
              !rj.banners.some(x => x.cls.includes("ok")),
              rj.banners);
            check("J 拒绝：保留返回结果时的勾选（p1/p3）与字段操作、填写，不套用成功后清理",
              rj.selCount === "2" &&
              rj.rows.find(r => r.id === String(p1)).checked === true &&
              rj.rows.find(r => r.id === String(p3)).checked === true &&
              rj.fields.find(f => f.key === "source").op === "set" &&
              rj.fields.find(f => f.key === "source").value === "拒绝等待期来源" &&
              rj.fields.find(f => f.key === "important_date").op === "set" &&
              rj.fields.find(f => f.key === "important_date").value === "2023-02-29",
              {sel: rj.selCount, fields: rj.fields});
            check("J 拒绝：按钮恢复「保存修改」，因仍有选中客户保持可提交",
              rj.submitText === "保存修改" && !rj.submitDisabled,
              {text: rj.submitText, disabled: rj.submitDisabled});
            const unchanged = await listClients(pendBase);
            check("J 拒绝：客户资料保持原样（p3、p1 都未被写入；等待期值未入库）",
              unchanged.clients.find(x => x.id === p3).source === "线上广告" &&
              unchanged.clients.find(x => x.id === p3).important_date === "2022-12-01" &&
              unchanged.clients.find(x => x.id === p1).source === "等待期新来源" &&
              JSON.stringify(unchanged.clients).includes("拒绝等待期来源") === false,
              unchanged.clients);

            // 等待结束后的提交门槛：取消全部勾选则不可提交，重新勾选才可提交
            await uncheckRows(page, [p1, p3]);
            const empty = await snapshot(page);
            check("J 等待结束后：无勾选时按钮保持不可提交，也不自动补交",
              empty.selCount === "0" && empty.submitDisabled &&
              session.counts.batchPosts === beforePosts + 1,
              {sel: empty.selCount, posts: session.counts.batchPosts});
            await selectRows(page, [p3]);
            // 用保留的填写修正日期后再次保存：应能正常发起一次「新」请求
            await replaceFieldByTyping(page, "important_date", "2024-01-01");
            await saveAndSettle(session);
            const fixed = await snapshot(page);
            check("J 修正后：新请求成功（累计第 2 次修改请求，处理 1 名）并完成清理",
              successBanner(fixed, 1) && cleanedUp(fixed) &&
              session.counts.batchPosts === beforePosts + 2,
              {banners: fixed.banners, posts: session.counts.batchPosts});
            const fixedData = await listClients(pendBase);
            check("J 修正后：p3 按页面当前填写更新（来源与日期），证明等待期无自动补交、结束后可正常再保存",
              fixedData.clients.find(x => x.id === p3).source === "拒绝等待期来源" &&
              fixedData.clients.find(x => x.id === p3).important_date === "2024-01-01",
              fixedData.clients.find(x => x.id === p3));
            await page.close();
          }

          // ---------------------------------------------------------------
          // 场景 K：等待结束时已无勾选——成功后按钮保持不可提交；
          //         等待期勾过的第三名客户不在处理对象内
          // ---------------------------------------------------------------
          {
            const session = await openSession(browser, pendBase);
            const {page, gate} = session;
            await selectRows(page, [p1]);
            await chooseSet(page, "region", "K地区");
            const beforePosts = session.counts.batchPosts;
            gate.holdOn();
            await page.click("#batch-submit");
            await waitForHeld(gate, 1);
            await waitSaving(page);

            // 等待期：取消唯一勾选（全空），中途又勾选 p3 再取消——结束时无勾选
            await uncheckRows(page, [p1]);
            await dispatchFormSubmit(page);
            await selectRows(page, [p3]);
            await chooseSetAndType(page, "source", "不应提交给p3");
            await uncheckRows(page, [p3]);
            await dispatchFormSubmit(page);
            const wk = await snapshot(page);
            check("K 等待中：勾选清空后等待不解除、提示不被未选错误替换、请求仍仅 1 次",
              wk.selCount === "0" && wk.submitText === "正在保存…" && wk.submitDisabled &&
              busyBannerOnly(wk) &&
              session.counts.batchPosts === beforePosts + 1 && gate.held.length === 1,
              {count: wk.selCount, banners: wk.banners, posts: session.counts.batchPosts});
            check("K 挂起请求体：处理对象只有首次提交的 p1",
              payloadProblems(gate.held[0].payload, [p1], {
                source: {op: "keep"},
                region: {op: "set", value: "K地区"},
                industry: {op: "keep"},
                important_date: {op: "keep"},
              }).length === 0,
              gate.held[0].payload);

            gate.holdOff();
            await gate.release(0);
            await waitSettled(page);
            const rk = await snapshot(page);
            check("K 放行后：按回复显示处理 1 名，字段清理；无勾选按钮保持不可提交",
              successBanner(rk, 1) && rk.submitDisabled &&
              rk.fields.every(f => f.op === "keep" && f.value === "" && f.disabled),
              {banners: rk.banners, disabled: rk.submitDisabled, fields: rk.fields});
            const kdata = await listClients(pendBase);
            check("K 后端：仅 p1 地区更新；等待期勾过并填值的 p3 未被更新",
              kdata.clients.find(x => x.id === p1).region === "K地区" &&
              kdata.clients.find(x => x.id === p3).region === "华北" &&
              JSON.stringify(kdata.clients).includes("不应提交给p3") === false,
              kdata.clients);
            await page.close();
          }
        } finally {
          await stopApp({proc: pendProc});
        }
      }

      // ===================================================================
      // 场景 H：真实空列表正常显示空列表提示；空库时读取失败不伪造空列表
      // ===================================================================
      {
        const {proc: emptyProc, port: emptyPortP} = startApp("empty");
        try {
          const emptyBase = `http://127.0.0.1:${await emptyPortP}`;
          await waitReady(emptyBase);

          const session = await openSession(browser, emptyBase);
          const {page, modes} = session;
          const snap = await snapshot(page);
          check("H 真实空列表：显示「还没有客户记录」",
            snap.emptyOn && snap.rows.length === 0, {empty: snap.emptyOn, rows: snap.rows});
          check("H 真实空列表：表格隐藏、无读取失败提示",
            snap.tableDisplay !== "table" && !snap.loadErrorOn,
            {display: snap.tableDisplay, err: snap.loadErrorOn});
          check("H 真实空列表：已选 0、保存按钮禁用",
            snap.selCount === "0" && snap.submitDisabled,
            {sel: snap.selCount, disabled: snap.submitDisabled});

          // 空库时首屏读取失败：不得把连接失败误判成真实空列表
          modes.list = "close";
          await page.goto(emptyBase + "/", {waitUntil: "domcontentloaded"});
          await page.waitForSelector("#clients-load-error.on", {timeout: 5000});
          const failSnap = await snapshot(page);
          check("H 空库读取失败：显示读取失败提示", failSnap.loadErrorOn, failSnap.loadErrorText);
          check("H 空库读取失败：不显示「还没有客户记录」、表格不出现",
            !failSnap.emptyOn && failSnap.tableDisplay !== "table",
            {empty: failSnap.emptyOn, display: failSnap.tableDisplay});

          // 恢复读取后刷新：真实空列表提示回来，失败提示撤下
          modes.list = "ok";
          await page.reload({waitUntil: "networkidle0"});
          const back = await snapshot(page);
          check("H 恢复后刷新：真实空列表提示恢复、失败提示撤下",
            back.emptyOn && !back.loadErrorOn,
            {empty: back.emptyOn, err: back.loadErrorOn, text: back.loadErrorText});
          await page.close();
        } finally {
          await stopApp({proc: emptyProc});
        }
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

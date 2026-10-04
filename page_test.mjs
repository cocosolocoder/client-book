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
 *    不套用保存成功后的清理与提示。
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
  };
  const counts = {batchPosts: 0, listGets: 0};

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
      if (modes.batchOverride) {
        const {status, body} = modes.batchOverride;
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

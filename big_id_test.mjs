#!/usr/bin/env node
/**
 * 大客户编号（超出 JS 安全整数范围）的页面层面回归保障。
 *
 * 启动真实 app.py 服务，直接向同一数据目录的 SQLite 写入编号为
 * 9007199254740992 / 9007199254740993 / 9223372036854775807 等的大编号客户
 * （导入接口只能自增编号，无法造出大编号，因此直接写库；页面与接口的公开
 * 行为不模拟、不改动），再用 Puppeteer 驱动系统 Chrome 验证：
 *
 * 1. 列表逐行显示各自完整的十进制编号，名称与资料对应原客户；
 * 2. 单独勾选 9007199254740993 时只选中它，已选区域显示准确编号与名称；
 *    再勾选 9007199254740992 显示两名；取消其中一条只取消对应客户；
 * 3. 全选、逐条取消、已选数量按实际客户区分；
 * 4. 只选 9007199254740993 保存来源修改：只有该客户来源改变，
 *    9007199254740992 及其他客户资料保持原样；成功数量为 1；
 * 5. 最大合法编号 9223372036854775807 的已有客户正常保存，不误判越界；
 * 6. 保存后列表编号仍与原记录一致。
 */
import {spawn} from "node:child_process";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";
import {mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import puppeteer from "puppeteer";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, "app.py");
const TMP = mkdtempSync(join(tmpdir(), "clientbook-bigid-"));
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

const ID_A = "9007199254740992"; // 2^53，JS Number 边界
const ID_B = "9007199254740993"; // 2^53+1，JS Number 会舍入成 ID_A
const ID_MAX = "9223372036854775807"; // 服务允许的最大编号
const ID_SMALL = "7";

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

// 直接用 sqlite3（Python 标准库）向服务同一数据目录写入大编号客户
async function seedBigIds(dataDir) {
  const script = `
import sqlite3, sys
db = sqlite3.connect(sys.argv[1])
db.execute("CREATE TABLE IF NOT EXISTS clients (id INTEGER PRIMARY KEY, name TEXT NOT NULL)")
cols = {row[1] for row in db.execute("PRAGMA table_info(clients)")}
for f in ("source", "region", "industry", "important_date"):
    if f not in cols:
        db.execute("ALTER TABLE clients ADD COLUMN %s TEXT" % f)
rows = [
    (${ID_SMALL}, "小编号客户", "老客户推荐", "华东", "互联网", "2024-02-29"),
    (${ID_A}, "大编号甲", "展会", "华北", "制造业", "2025-01-15"),
    (${ID_B}, "大编号乙", "广告", "华南", "金融业", None),
    (${ID_MAX}, "最大编号客户", "官网", None, None, "2030-12-31"),
]
db.executemany(
    "INSERT INTO clients (id, name, source, region, industry, important_date)"
    " VALUES (?, ?, ?, ?, ?, ?)", rows)
db.commit()
db.close()
`;
  await new Promise((resolve, reject) => {
    const p = spawn("python3", ["-c", script, join(dataDir, "client-book.sqlite")],
      {stdio: ["ignore", "pipe", "pipe"]});
    let err = "";
    p.stderr.on("data", d => { err += d; });
    p.on("exit", code => code === 0 ? resolve() : reject(new Error("seed 失败：" + err)));
  });
}

// 大编号超出 JS 安全整数范围，res.json() 会丢精度：取原文比对编号文本
async function listClientsRaw(base) {
  const res = await fetch(base + "/api/clients");
  return res.text();
}

async function run(app) {
  const port = await app.port;
  const base = `http://127.0.0.1:${port}`;
  await waitReady(base);
  await seedBigIds(join(TMP, "bigid"));

  const browser = await puppeteer.launch({
    executablePath: process.env.CHROME || "/usr/bin/google-chrome",
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  try {
    const page = await browser.newPage();
    page.on("pageerror", err => check("页面无 JS 异常", false, String(err)));
    await page.goto(base + "/", {waitUntil: "networkidle0"});
    await page.waitForSelector("#clients-table.on", {timeout: 8000});

    const snapshot = () => page.evaluate(() => ({
      rows: [...document.querySelectorAll("#clients-body tr")].map(tr => ({
        id: tr.dataset.id,
        checked: tr.querySelector(".row-check").checked,
        cells: [...tr.querySelectorAll("td")].map(td => td.textContent.trim()),
      })),
      count: document.getElementById("sel-count").textContent,
      chips: [...document.querySelectorAll("#sel-list .sel-chip")].map(c => c.textContent.trim()),
      checkAll: document.getElementById("check-all").checked,
    }));

    const clickRow = id => page.evaluate(id => {
      document.querySelector(`#clients-body tr[data-id="${id}"] .row-check`).click();
    }, id);

    // -- 1. 列表显示完整编号、名称与资料对应原客户 --------------------------
    let snap = await snapshot();
    check("列表共 4 行", snap.rows.length === 4, snap.rows.map(r => r.id));
    const rowOf = id => snap.rows.find(r => r.id === id);
    check("编号 2^53 行完整显示", !!rowOf(ID_A) && rowOf(ID_A).cells[1] === ID_A, snap.rows.map(r => r.cells[1]));
    check("编号 2^53+1 行完整显示（未被舍入成 2^53）",
      !!rowOf(ID_B) && rowOf(ID_B).cells[1] === ID_B, snap.rows.map(r => r.cells[1]));
    check("最大编号行完整显示", !!rowOf(ID_MAX) && rowOf(ID_MAX).cells[1] === ID_MAX);
    check("大编号甲名称与资料对应原客户",
      rowOf(ID_A) && rowOf(ID_A).cells[2] === "大编号甲" && rowOf(ID_A).cells[3] === "展会");
    check("大编号乙名称与资料对应原客户",
      rowOf(ID_B) && rowOf(ID_B).cells[2] === "大编号乙" && rowOf(ID_B).cells[3] === "广告");
    check("小编号客户仍正常显示", rowOf(ID_SMALL) && rowOf(ID_SMALL).cells[2] === "小编号客户");
    check("大小编号混排仍按编号顺序展示",
      snap.rows.map(r => r.id).join(",") === [ID_SMALL, ID_A, ID_B, ID_MAX].join(","),
      snap.rows.map(r => r.id));

    // -- 2. 单独勾选 2^53+1：只选中它，已选区域显示准确编号与名称 ------------
    await clickRow(ID_B);
    snap = await snapshot();
    check("只勾选 2^53+1 后已选数量为 1", snap.count === "1", snap.count);
    check("已选区域显示 2^53+1 的准确编号与名称",
      snap.chips.length === 1 && snap.chips[0].includes("#" + ID_B) && snap.chips[0].includes("大编号乙"),
      snap.chips);
    check("2^53 行未被连带选中", !rowOf(ID_A).checked && snap.rows.find(r => r.id === ID_A) && !snap.rows.find(r => r.id === ID_A).checked);

    // -- 再勾选 2^53：两名客户分别显示 --------------------------------------
    await clickRow(ID_A);
    snap = await snapshot();
    check("再勾选 2^53 后已选数量为 2", snap.count === "2", snap.count);
    check("已选区域同时显示两名客户各自编号",
      snap.chips.length === 2 &&
      snap.chips.some(c => c.includes("#" + ID_A) && c.includes("大编号甲")) &&
      snap.chips.some(c => c.includes("#" + ID_B) && c.includes("大编号乙")),
      snap.chips);

    // -- 从已选区域移除 2^53+1：只取消对应客户 ------------------------------
    await page.evaluate(id => {
      document.querySelector(`#sel-list .sel-chip [data-remove="${id}"]`).click();
    }, ID_B);
    snap = await snapshot();
    check("移除 2^53+1 后已选数量为 1", snap.count === "1", snap.count);
    check("已选区域只剩 2^53",
      snap.chips.length === 1 && snap.chips[0].includes("#" + ID_A), snap.chips);
    check("2^53+1 行勾选被取消、2^53 行仍勾选",
      !snap.rows.find(r => r.id === ID_B).checked && snap.rows.find(r => r.id === ID_A).checked);

    // -- 3. 全选与逐条取消 ---------------------------------------------------
    await page.evaluate(() => document.getElementById("check-all").click());
    snap = await snapshot();
    check("全选后已选数量为 4", snap.count === "4", snap.count);
    check("全选后四名客户各自出现在已选区域",
      [ID_SMALL, ID_A, ID_B, ID_MAX].every(id => snap.chips.some(c => c.includes("#" + id))),
      snap.chips);
    await clickRow(ID_MAX);
    snap = await snapshot();
    check("逐条取消最大编号后已选数量为 3", snap.count === "3", snap.count);
    check("最大编号不再出现在已选区域",
      !snap.chips.some(c => c.includes("#" + ID_MAX)), snap.chips);
    // 部分选中状态下点击全选会先补全为全选，再点一次才清空
    await page.evaluate(() => document.getElementById("check-all").click());
    snap = await snapshot();
    check("部分选中时点击全选补全为 4", snap.count === "4", snap.count);
    await page.evaluate(() => document.getElementById("check-all").click());
    snap = await snapshot();
    check("取消全选后已选数量为 0", snap.count === "0", snap.count);

    // -- 4. 只选 2^53+1 保存来源修改：只影响这一名客户 -----------------------
    await clickRow(ID_B);
    await page.evaluate(() => {
      document.querySelector('.bf[data-field="source"] input[value="set"]').click();
      document.querySelector('.bf[data-field="source"] .bf-value').value = "大编号新来源";
      document.getElementById("batch-submit").click();
    });
    await page.waitForFunction(
      () => document.getElementById("batch-report").textContent.includes("已成功处理"),
      {timeout: 8000});
    const reportText = await page.evaluate(
      () => document.getElementById("batch-report").textContent);
    check("保存成功数量为 1", reportText.includes("已成功处理 1 名客户") ||
      reportText.includes("已成功处理 1"), reportText);

    let raw = await listClientsRaw(base);
    check("接口仍返回 2^53 的完整编号", raw.includes('"id": ' + ID_A), raw.slice(0, 400));
    check("接口仍返回 2^53+1 的完整编号", raw.includes('"id": ' + ID_B));
    const after = JSON.parse(raw.replace(/"id": (\d{16,})/g, '"id": "$1"'));
    const byId = {};
    for (const c of after.clients) byId[String(c.id)] = c;
    check("2^53+1 的来源已改为新值", byId[ID_B].source === "大编号新来源", byId[ID_B]);
    check("2^53 的来源保持原样", byId[ID_A].source === "展会", byId[ID_A]);
    check("2^53 的名称保持原样", byId[ID_A].name === "大编号甲");
    check("小编号客户资料保持原样",
      byId[ID_SMALL].source === "老客户推荐" && byId[ID_SMALL].industry === "互联网");
    check("最大编号客户资料保持原样",
      byId[ID_MAX].source === "官网" && byId[ID_MAX].important_date === "2030-12-31");
    check("客户总数不变", after.clients.length === 4);

    // 保存后页面列表已刷新：编号仍与原记录一致
    snap = await snapshot();
    check("保存后列表编号仍与原记录一致",
      snap.rows.map(r => r.id).join(",") === [ID_SMALL, ID_A, ID_B, ID_MAX].join(","),
      snap.rows.map(r => r.id));
    check("保存后勾选已清除", snap.count === "0", snap.count);

    // -- 5. 最大合法编号的已有客户正常保存，不误判越界 -----------------------
    await clickRow(ID_MAX);
    await page.evaluate(() => {
      document.querySelector('.bf[data-field="industry"] input[value="set"]').click();
      document.querySelector('.bf[data-field="industry"] .bf-value').value = "新能源";
      document.getElementById("batch-submit").click();
    });
    await page.waitForFunction(
      () => document.getElementById("batch-report").textContent.includes("已成功处理"),
      {timeout: 8000});
    raw = await listClientsRaw(base);
    const after2 = JSON.parse(raw.replace(/"id": (\d{16,})/g, '"id": "$1"'));
    const byId2 = {};
    for (const c of after2.clients) byId2[String(c.id)] = c;
    check("最大编号客户行业已保存", byId2[ID_MAX].industry === "新能源", byId2[ID_MAX]);
    check("最大编号客户其他资料保持原样",
      byId2[ID_MAX].source === "官网" && byId2[ID_MAX].name === "最大编号客户");
    check("其他客户不受最大编号保存影响",
      byId2[ID_A].source === "展会" && byId2[ID_B].source === "大编号新来源" &&
      byId2[ID_B].industry === "金融业");

    // -- 同时选中两个大编号保存：按两名客户处理 ------------------------------
    await clickRow(ID_A);
    await clickRow(ID_B);
    await page.evaluate(() => {
      document.querySelector('.bf[data-field="region"] input[value="set"]').click();
      document.querySelector('.bf[data-field="region"] .bf-value').value = "西南";
      document.getElementById("batch-submit").click();
    });
    await page.waitForFunction(
      () => document.getElementById("batch-report").textContent.includes("已成功处理"),
      {timeout: 8000});
    const reportText2 = await page.evaluate(
      () => document.getElementById("batch-report").textContent);
    check("同时选中两个大编号时成功数量为 2",
      reportText2.includes("已成功处理 2"), reportText2);
    raw = await listClientsRaw(base);
    const after3 = JSON.parse(raw.replace(/"id": (\d{16,})/g, '"id": "$1"'));
    const byId3 = {};
    for (const c of after3.clients) byId3[String(c.id)] = c;
    check("两个大编号客户的地区都已修改",
      byId3[ID_A].region === "西南" && byId3[ID_B].region === "西南",
      {a: byId3[ID_A].region, b: byId3[ID_B].region});
    check("未选中的最大编号客户地区保持原样（null）",
      byId3[ID_MAX].region === null, byId3[ID_MAX]);
    check("未选中的小编号客户地区保持原样", byId3[ID_SMALL].region === "华东");
  } finally {
    await browser.close();
  }
}

async function main() {
  const app = startApp("bigid");
  try {
    await run(app);
  } finally {
    await stopApp(app).catch(() => {});
  }

  console.log(`\n${checkCount - FAILURES.length}/${checkCount} 项通过`);
  if (FAILURES.length) {
    console.log("失败项：");
    for (const f of FAILURES) console.log(" -", f.label, f.detail);
    process.exitCode = 1;
  }
}

main().catch(err => {
  console.error(err);
  process.exitCode = 1;
}).finally(() => {
  rmSync(TMP, {recursive: true, force: true});
});

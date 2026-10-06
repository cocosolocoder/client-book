#!/usr/bin/env python3
"""长客户名单批量修改的端到端回归测试。

与 smoke_test.py 一样启动真实 app.py、只走公开接口（CSV 导入、客户列表、
批量修改），不模拟任何服务端行为。本文件关注一次提交涉及较多客户时的保障：

- 名单长度跨越多条分块语句（本机 SQLite 的单语句参数上限是 250000，无法用
  真实名单触达分块路径）：测试启动器在子进程内仅把「分块用参数上限」压低到
  64，并强制任何单条语句绑定参数不得超过 64——若分块逻辑回归成单条大
  IN(?,…) 语句，测试会直接报错而不是悄悄通过；
- 1200 名资料互不相同（含未填写字段）的选中客户一次保存：设置来源、清空行业，
  地区与重要日期逐人保留原值；去重计数、名单末尾客户不遗漏、空值不从他人补入；
- 长名单中混入找不到的编号（位于末尾与中部）：即使前面编号全部有效、字段合法，
  也整次 HTTP 400 拒绝并指出缺失编号，不返回处理数量，任何客户不变；
- 保存已经开始、尚未全部完成时数据库出错（执行中途与提交时各一次）：
  HTTP 400 与可读保存失败说明、无处理数量，整笔回滚，重新读取列表无部分保存；
  之后同一批修改重试仍能一次完整成功。

启动器只存在于本测试的临时目录中，不修改仓库里的 app.py，也不改变任何公开
接口行为；不设置启动器时 app.py 与线上运行完全一致。
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

APP_DIR = Path(__file__).resolve().parent
TMP = Path(tempfile.mkdtemp(prefix="clientbook-longlist-"))
LIMIT = 64              # 测试启动器压低后的单语句绑定参数上限
N = 1200               # 选中客户数（超过 LIMIT 近 19 倍，存在性与更新均跨多块）
UNSELECTED = 5         # 未选中对照客户数
FAIL_EXEC_FLAG = TMP / "arm-fail-exec.flag"    # 武装后：第 3 个 UPDATE 分块出错
FAIL_COMMIT_FLAG = TMP / "arm-fail-commit.flag"  # 武装后：提交时出错

# 仅压低分块上限的启动器：导入真实 app 模块后替换其 sqlite3 入口与参数上限取值。
SHIM_LIMIT = r'''
import sys
sys.path.insert(0, __APP_DIR__)
import sqlite3
import app

LIMIT = __LIMIT__


class LimitedConnection(sqlite3.Connection):
    """真实 SQLite 连接：额外拒绝任何绑定参数超过 LIMIT 的单条语句。"""

    def execute(self, sql, parameters=()):
        count = len(parameters)
        if count > LIMIT:
            raise AssertionError(
                "测试启动器：单条语句绑定了 %d 个参数，超过压低下限 %d" % (count, LIMIT))
        return super().execute(sql, parameters)


class _Sqlite:
    DatabaseError = sqlite3.DatabaseError
    OperationalError = sqlite3.OperationalError

    @staticmethod
    def connect(path):
        return LimitedConnection(path)


app.sqlite3 = _Sqlite()
app.sql_variable_limit = lambda database: LIMIT
app.main()
'''

# 在「压低上限」基础上，再按标志文件各注入一次性数据库错误：
# - 武装 exec 标志：第 3 条 UPDATE 分块执行时抛 OperationalError（保存已开始、
#   尚未全部完成）；
# - 武装 commit 标志：所有分块执行成功、事务提交时抛 OperationalError。
# 两类错误都必须被批量修改逻辑整笔回滚，并以 HTTP 400 可读原因回复。
# 标志文件由测试进程在每次请求前创建、连接在触发时自行删除，均为一次性。
SHIM_FAIL = r'''
import os
import sys
sys.path.insert(0, __APP_DIR__)
import sqlite3
import app

LIMIT = __LIMIT__
EXEC_FLAG = __EXEC_FLAG__
COMMIT_FLAG = __COMMIT_FLAG__
state = {"updates": 0}


def take_flag(path):
    try:
        os.remove(path)
        return True
    except OSError:
        return False


class FailConnection(sqlite3.Connection):
    def execute(self, sql, parameters=()):
        count = len(parameters)
        if count > LIMIT:
            raise AssertionError(
                "测试启动器：单条语句绑定了 %d 个参数，超过压低下限 %d" % (count, LIMIT))
        if sql.lstrip().upper().startswith("UPDATE CLIENTS"):
            state["updates"] += 1
            if state["updates"] == 3 and take_flag(EXEC_FLAG):
                state["updates"] = 0
                raise sqlite3.OperationalError("测试启动器注入：保存中途磁盘 I/O 错误")
        return super().execute(sql, parameters)

    def commit(self):
        if take_flag(COMMIT_FLAG):
            state["updates"] = 0
            raise sqlite3.OperationalError("测试启动器注入：提交时磁盘 I/O 错误")
        return super().commit()


class _Sqlite:
    DatabaseError = sqlite3.DatabaseError
    OperationalError = sqlite3.OperationalError

    @staticmethod
    def connect(path):
        return FailConnection(path)


app.sqlite3 = _Sqlite()
app.sql_variable_limit = lambda database: LIMIT
app.main()
'''


def write_shim(name, template):
    path = TMP / name
    path.write_text(
        template.replace("__APP_DIR__", repr(str(APP_DIR)))
        .replace("__LIMIT__", repr(LIMIT))
        .replace("__EXEC_FLAG__", repr(str(FAIL_EXEC_FLAG)))
        .replace("__COMMIT_FLAG__", repr(str(FAIL_COMMIT_FLAG))),
        encoding="utf-8")
    return path


def expect(label, cond, detail=""):
    print(("PASS" if cond else "FAIL"), label, "" if cond else (detail and ("\n      " + str(detail))))
    if not cond:
        expect.failed += 1
expect.failed = 0


# ---------- 客户资料构造：每名选中客户资料互不相同，并含未填写字段 ----------

def profile(index):
    """第 index 名客户（0 起）的导入资料；各字段逐人有别，部分留空。"""
    region = None if index % 7 == 6 else "地区%04d" % index
    industry = None if index % 3 == 2 else "行业%04d" % index
    if index % 5 == 4:
        important_date = None
    else:
        # 1..12 月、1..28 日组合，始终是真实日历日期
        important_date = "%04d-%02d-%02d" % (
            2015 + (index % 9), 1 + (index % 12), 1 + (index % 28))
    return {
        "name": "长名单客户%04d" % index,
        "source": "老来源%04d" % index,
        "region": region,
        "industry": industry,
        "important_date": important_date,
    }


def build_csv():
    lines = ["name,source,region,industry,important_date"]
    total = N + UNSELECTED
    for i in range(total):
        p = profile(i)
        lines.append("%s,%s,%s,%s,%s" % (
            p["name"], p["source"], p["region"] or "",
            p["industry"] or "", p["important_date"] or ""))
    return "\n".join(lines) + "\n"


def seeded_order(count):
    """固定种子的洗牌顺序，让名单顺序与编号顺序不同（含真正的末尾客户）。"""
    order = list(range(count))
    seed = 20260606
    for i in range(count - 1, 0, -1):
        seed = (1103515245 * seed + 12345) % (2 ** 31)
        j = seed % (i + 1)
        order[i], order[j] = order[j], order[i]
    return order


# ---------- 真实服务进程 ----------

def _drain(stream):
    for _ in stream:
        pass


def start_server(shim_path, data_dir):
    proc = subprocess.Popen(
        [sys.executable, str(shim_path),
         "serve", "--host", "127.0.0.1", "--port", "0", "--data-dir", str(data_dir)],
        cwd=str(TMP), stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    import re
    base = None
    deadline = time.time() + 8
    while time.time() < deadline:
        line = proc.stdout.readline()
        if not line:
            if proc.poll() is not None:
                raise RuntimeError("启动器启动失败：%s" % proc.stdout.read())
            time.sleep(0.05)
            continue
        match = re.search(r"http://127\.0\.0\.1:(\d+)", line)
        if match:
            base = "http://127.0.0.1:%s" % match.group(1)
            break
    if base is None:
        raise RuntimeError("未能解析服务端口")
    threading.Thread(target=_drain, args=(proc.stdout,), daemon=True).start()
    for _ in range(50):
        try:
            if request("GET", "/health", base)[0] == 200:
                return proc, base
        except OSError:
            time.sleep(0.1)
    raise RuntimeError("服务未就绪")


def stop_server(proc):
    proc.terminate()
    proc.wait(timeout=5)


# ---------- HTTP 公开接口 ----------

def request(method, path, base, body=None):
    data = body.encode("utf-8") if isinstance(body, str) else None
    req = urllib.request.Request(base + path, data=data, method=method)
    try:
        with urllib.request.urlopen(req) as resp:
            return resp.status, json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        return exc.code, json.loads(exc.read().decode("utf-8"))


def import_clients(base, csv_text):
    req = urllib.request.Request(base + "/api/clients/import",
                                 data=csv_text.encode("utf-8"), method="POST")
    try:
        with urllib.request.urlopen(req) as resp:
            return resp.status, json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        return exc.code, json.loads(exc.read().decode("utf-8"))


def batch_update(base, ids, updates):
    return request("POST", "/api/clients/batch-update", base,
                   json.dumps({"ids": ids, "updates": updates}))


def list_map(base):
    status, data = request("GET", "/api/clients", base)
    assert status == 200, data
    return {c["id"]: c for c in data["clients"]}


def seed_data(base):
    """导入 N+UNSELECTED 名客户，返回 (选中编号列表, 未选中编号列表, 导入后列表)。"""
    status, data = import_clients(base, build_csv())
    assert status == 200 and data["imported_count"] == N + UNSELECTED \
        and data["failed_count"] == 0, data
    imported_ids = [item["id"] for item in data["imported"]]
    selected_ids = imported_ids[:N]
    unselected_ids = imported_ids[N:]
    clients = list_map(base)
    expect("导入后客户总数为 %d" % (N + UNSELECTED), len(clients) == N + UNSELECTED,
           len(clients))
    # 资料确实互不相同，且存在未填写字段
    sample = [clients[cid] for cid in selected_ids[:10]]
    expect("选中客户资料互不相同",
           len({c["source"] for c in sample}) == len(sample)
           and len({c["region"] for c in sample}) == len(sample)
           and any(c["industry"] is None for c in clients.values())
           and any(c["region"] is None for c in clients.values())
           and any(c["important_date"] is None for c in clients.values()))
    return selected_ids, unselected_ids, clients


SET_SOURCE_VALUE = "  长名单统一来源 内部 空白\n第二行\t保留  "
STORED_SOURCE = "长名单统一来源 内部 空白\n第二行\t保留"
KEEP_UPDATES = {
    "source": {"op": "set", "value": SET_SOURCE_VALUE},
    "industry": {"op": "clear"},
    "region": {"op": "keep"},
    "important_date": {"op": "keep"},
}
FOUR_FIELD_UPDATES = {
    "source": {"op": "set", "value": " 第二轮统一来源 "},
    "region": {"op": "set", "value": " 统一地区X "},
    "industry": {"op": "clear"},
    "important_date": {"op": "set", "value": "2024-02-29"},
}


def assert_keep_result(after, before, selected_ids, unselected_ids, *,
                       source=STORED_SOURCE):
    """选中客户：来源设置、行业清空、地区与重要日期逐人保持原值；未选中全不变。"""
    kept_region_distinct = set()
    null_region_kept = null_date_kept = 0
    for cid in selected_ids:
        cur, old = after[cid], before[cid]
        ok = (cur["source"] == source and cur["industry"] is None
              and cur["region"] == old["region"]
              and cur["important_date"] == old["important_date"]
              and cur["name"] == old["name"] and cur["id"] == cid)
        if not ok:
            expect("长名单逐人结果（编号 %d）" % cid, False, (cur, old))
            return
        kept_region_distinct.add(cur["region"])
        null_region_kept += cur["region"] is None
        null_date_kept += cur["important_date"] is None
    expect("长名单每名选中客户结果正确（含名单末尾客户、编号名称不变）", True)
    last_id = selected_ids[-1]
    expect("名单末尾客户同样完成设置/清空且保留自己的地区与日期",
           after[last_id]["source"] == source and after[last_id]["industry"] is None
           and after[last_id]["region"] == before[last_id]["region"]
           and after[last_id]["important_date"] == before[last_id]["important_date"],
           after[last_id])
    expect("保持原值的地区确实逐人保留、未被统一",
           len(kept_region_distinct) > 100, len(kept_region_distinct))
    expect("原本未填写的地区/日期保持为空（空值不从其他客户补入）",
           null_region_kept > 0 and null_date_kept > 0,
           (null_region_kept, null_date_kept))
    expect("未选中客户资料全部保持原样",
           all(after[cid] == before[cid] for cid in unselected_ids))
    expect("客户总数保持不变",
           len(after) == N + UNSELECTED, len(after))


def main():
    shim_limit = write_shim("shim_limit.py", SHIM_LIMIT)
    shim_fail = write_shim("shim_fail.py", SHIM_FAIL)
    data_a = TMP / "data-a"
    data_b = TMP / "data-b"
    overall_ok = True
    try:
        # ===== 场景一：长名单一次保存成功（压低后的上限 64，名单 1200） =====
        proc, base = start_server(shim_limit, data_a)
        try:
            selected_ids, unselected_ids, before = seed_data(base)
            order = [selected_ids[i] for i in seeded_order(N)]

            # 重复编号出现在名单不同位置（首、尾各追加一个已有编号）：
            # 名单长度 1202，去重后仍为 1200；名单末尾客户也在更新范围内。
            payload_ids = order + [order[0], order[-1]]
            status, data = batch_update(base, payload_ids, KEEP_UPDATES)
            expect("长名单保存 200 且计数按去重后的 1200 名",
                   status == 200 and data == {"updated_count": N}, (status, data))
            after = list_map(base)
            assert_keep_result(after, before, selected_ids, unselected_ids)
            expect("来源只去前后空白、内部空白与换行保留（每名客户一致）",
                   all(after[cid]["source"] == STORED_SOURCE for cid in selected_ids)
                   and "\n第二行\t保留" in STORED_SOURCE)
            expect("行业清空后列表接口返回 null（原本有值与原本为空都为 null）",
                   all(after[cid]["industry"] is None for cid in selected_ids))

            # 原值已符合设置内容的客户仍计入数量：原样重发同一批修改。
            status, data = batch_update(base, payload_ids, KEEP_UPDATES)
            expect("原值已符合设置内容仍全部计入（重发仍为 1200）",
                   status == 200 and data == {"updated_count": N}, (status, data))

            # 四个字段同时操作（设置来源/地区与日期、清空行业）：更新分块再留 4 个
            # 赋值参数，走 60 个编号一块的路径，仍是一次提交、一次成功回复。
            snapshot = after
            status, data = batch_update(base, selected_ids, FOUR_FIELD_UPDATES)
            expect("四字段长名单保存 200 且计数 1200",
                   status == 200 and data == {"updated_count": N}, (status, data))
            after = list_map(base)
            expect("四字段操作逐人落库（来源/地区设置、行业清空、闰年日期设置）",
                   all(after[cid]["source"] == "第二轮统一来源"
                       and after[cid]["region"] == "统一地区X"
                       and after[cid]["industry"] is None
                       and after[cid]["important_date"] == "2024-02-29"
                       for cid in selected_ids)
                   and all(after[cid] == snapshot[cid] for cid in unselected_ids),
                   "存在落库不符的客户")

            # ===== 场景二：长名单混入找不到的编号 → 整次拒绝 =====
            ghost = max(before) + 777
            reject_updates = {
                "source": {"op": "set", "value": "不应保存的长名单来源"},
                "industry": {"op": "clear"},
            }
            for label, bad_ids in (
                ("缺失编号在名单末尾（前面编号全部有效）", selected_ids + [ghost]),
                ("缺失编号在名单中部且含重复编号",
                 selected_ids[:600] + [ghost] + selected_ids[600:] + [selected_ids[0]]),
            ):
                before_reject = list_map(base)
                status, data = batch_update(base, bad_ids, reject_updates)
                expect("长名单缺失编号整次 400：" + label,
                       status == 400 and "updated_count" not in data, (status, data))
                expect("拒绝原因可读且指出缺失编号：" + label,
                       isinstance(data.get("error"), str)
                       and bool(data["error"].strip())
                       and "找不到" in data["error"] and str(ghost) in data["error"],
                       data)
                expect("整次拒绝不留任何修改：" + label,
                       list_map(base) == before_reject)
            expect("两次拒绝后未选中客户仍保持原样",
                   all(list_map(base)[cid] == snapshot[cid] for cid in unselected_ids))

            # 去掉不存在的编号后，同一批修改一次成功，不再需要分批确认。
            status, data = batch_update(base, selected_ids, {
                "source": {"op": "set", "value": " 拒绝后恢复来源 "},
                "industry": {"op": "clear"},
                "region": {"op": "keep"},
                "important_date": {"op": "keep"},
            })
            expect("修正名单后长名单一次保存成功 1200",
                   status == 200 and data == {"updated_count": N}, (status, data))
            after = list_map(base)
            expect("修正后末尾客户也完成保存",
                   after[selected_ids[-1]]["source"] == "拒绝后恢复来源"
                   and after[selected_ids[-1]]["industry"] is None)
            expect("保持原值的地区与日期仍逐人保留（四字段操作后的值）",
                   all(after[cid]["region"] == "统一地区X"
                       and after[cid]["important_date"] == "2024-02-29"
                       for cid in selected_ids))
        finally:
            stop_server(proc)

        # ===== 场景三：保存开始后数据库出错 → 400、整笔回滚、重试可成功 =====
        # 先用只压上限的启动器导入数据，再换成会注入数据库错误的启动器打开同一库。
        proc, base = start_server(shim_limit, data_b)
        try:
            fail_selected, fail_unselected, before_fail = seed_data(base)
            expect("失败场景客户总数 %d" % (N + UNSELECTED),
                   len(before_fail) == N + UNSELECTED)
        finally:
            stop_server(proc)

        proc, base = start_server(shim_fail, data_b)
        try:
            fail_updates = {
                "source": {"op": "set", "value": " 失败批次统一来源 "},
                "industry": {"op": "clear"},
            }

            # (a) 第 3 个更新分块执行时数据库出错：前两个分块的改动必须随回滚撤销。
            FAIL_EXEC_FLAG.touch()
            status, data = batch_update(base, fail_selected, fail_updates)
            expect("保存中途数据库错误返回 400",
                   status == 400 and "updated_count" not in data, (status, data))
            expect("保存失败原因可读",
                   isinstance(data.get("error"), str) and bool(data["error"].strip())
                   and "保存失败" in data["error"], data)
            expect("中途失败后整笔回滚、无部分保存",
                   list_map(base) == before_fail)
            expect("一次性触发后执行标志已解除", not FAIL_EXEC_FLAG.exists())

            # (b) 武装提交标志：所有分块执行成功但提交时出错，同样必须整笔回滚。
            FAIL_COMMIT_FLAG.touch()
            status, data = batch_update(base, fail_selected, fail_updates)
            expect("提交时数据库错误返回 400 且无处理数量",
                   status == 400 and "updated_count" not in data
                   and isinstance(data.get("error"), str)
                   and "保存失败" in data["error"], (status, data))
            expect("提交失败后整笔回滚、无部分保存",
                   list_map(base) == before_fail)
            expect("一次性触发后提交标志已解除", not FAIL_COMMIT_FLAG.exists())

            # 不带错误标志的正常请求在同一进程内仍可成功……此处先验证未选中客户。
            expect("失败后未选中客户始终不变",
                   all(list_map(base)[cid] == before_fail[cid]
                       for cid in fail_unselected))
        finally:
            stop_server(proc)

        # 重启真实（仅压上限）后端打开同一数据库：回滚结果持久、没有半截保存，
        # 随后同一批修改一次提交即可完整成功。
        proc, base = start_server(shim_limit, data_b)
        try:
            expect("重启后仍无任何部分保存", list_map(base) == before_fail)
            status, data = batch_update(base, fail_selected, fail_updates)
            expect("失败后同一批修改重试一次成功、计数 1200",
                   status == 200 and data == {"updated_count": N}, (status, data))
            after_fail = list_map(base)
            assert_keep_result(after_fail, before_fail, fail_selected, fail_unselected,
                               source="失败批次统一来源")
        finally:
            stop_server(proc)

    except Exception as exc:  # 测试设施自身异常也算失败
        overall_ok = False
        import traceback
        traceback.print_exc()
        expect("测试执行未抛出异常", False, repr(exc))

    shutil.rmtree(TMP, ignore_errors=True)
    print("\n%s" % ("=" * 46))
    if expect.failed == 0 and overall_ok:
        print("长名单回归全部通过")
        return 0
    print("%d 项失败" % expect.failed)
    return 1


if __name__ == "__main__":
    sys.exit(main())

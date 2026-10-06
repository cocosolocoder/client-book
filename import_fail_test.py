#!/usr/bin/env python3
"""CSV 导入在数据库保存阶段失败时的端到端原子性回归测试。

与 smoke_test.py / long_list_test.py 一样启动真实 app.py、只走公开接口
（CSV 导入、客户列表、批量修改），不模拟任何服务端业务行为。本文件关注
「服务已开始保存本次有效新客户之后数据库出错」的确定性结果：

- 某条客户写入中途失败（前几条有效新客户已写入）：整次导入 HTTP 400，
  error 为非空中文说明、明确指出数据库保存失败且本次没有新增客户，
  响应不含新增/未导入数量或任何成功报告；
- 全部客户已写入但最终提交失败：同样 400、无数量、整笔撤销；
- 失败后重新读取客户列表：本次文件中的任何新客户都不存在，原有客户的
  编号、名称与各项资料保持原样，重启后端打开同一数据库仍无残留；
- 失败之后的正常导入与批量修改不会把失败文件的客户顺带提交保存；
- 数据库恢复后重新提交同一文件：原本有效的新客户正常新增，重复名称、
  无效日期、缺少名称仍按记录级规则逐条报告且编号/原因准确，失败时的
  回滚不会让这些客户被误报为已有重复。

数据库错误由仅存在于临时目录的启动器注入（与 long_list_test.py 同样的
标志文件 + 一次性 sqlite3 真实连接包装方式）：不修改 app.py，也不改变
任何公开接口行为。
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
TMP = Path(tempfile.mkdtemp(prefix="clientbook-import-fail-"))
EXEC_FLAG = TMP / "arm-fail-exec.flag"     # 武装后：写入指定客户时出错
COMMIT_FLAG = TMP / "arm-fail-commit.flag"  # 武装后：本次提交时出错

# 写入中途失败的目标客户名称：该客户 INSERT 执行前注入一次性磁盘 I/O 错误，
# 其前面的有效新客户已经写入（必须随回滚一起撤销），后面的记录不再处理。
MIDWAY_TARGET = "保存中途失败目标客户"

# 启动器：用真实 sqlite3 连接，仅按标志文件在「指定客户写入前」或
# 「发生过客户 INSERT 的提交时」各注入一次 OperationalError。
# 标志只触发一次（触发时自行删除）；提交错误以本连接已发生客户 INSERT
# 为门槛，避免误伤建表阶段的提交。
SHIM_FAIL = r'''
import os
import sys
sys.path.insert(0, __APP_DIR__)
import sqlite3
import app

EXEC_FLAG = __EXEC_FLAG__
COMMIT_FLAG = __COMMIT_FLAG__
MIDWAY_TARGET = __MIDWAY_TARGET__
state = {"inserts": 0}


class FailConnection(sqlite3.Connection):
    def execute(self, sql, parameters=()):
        if sql.lstrip().upper().startswith("INSERT INTO CLIENTS"):
            state["inserts"] += 1
            # 只在写入指定客户、且标志存在时触发一次：不依赖客户条数，
            # 同一文件里有效/无效记录混排也能稳定命中「保存已开始、尚未完成」。
            if (isinstance(parameters, dict) and parameters.get("name") == MIDWAY_TARGET
                    and os.path.exists(EXEC_FLAG)):
                os.remove(EXEC_FLAG)
                raise sqlite3.OperationalError("测试启动器注入：客户写入中途磁盘 I/O 错误")
        return super().execute(sql, parameters)

    def commit(self):
        if state["inserts"] > 0 and os.path.exists(COMMIT_FLAG):
            os.remove(COMMIT_FLAG)
            raise sqlite3.OperationalError("测试启动器注入：提交时磁盘 I/O 错误")
        return super().commit()


class _Sqlite:
    DatabaseError = sqlite3.DatabaseError
    OperationalError = sqlite3.OperationalError

    @staticmethod
    def connect(path):
        return FailConnection(path)


app.sqlite3 = _Sqlite()
app.main()
'''


def write_shim():
    path = TMP / "shim_fail.py"
    path.write_text(
        SHIM_FAIL.replace("__APP_DIR__", repr(str(APP_DIR)))
        .replace("__EXEC_FLAG__", repr(str(EXEC_FLAG)))
        .replace("__COMMIT_FLAG__", repr(str(COMMIT_FLAG)))
        .replace("__MIDWAY_TARGET__", repr(MIDWAY_TARGET)),
        encoding="utf-8")
    return path


def expect(label, cond, detail=""):
    print(("PASS" if cond else "FAIL"), label,
          "" if cond else (detail and ("\n      " + str(detail))))
    if not cond:
        expect.failed += 1
expect.failed = 0


# ---------- 测试文件 ----------

# 文件一：有效新客户与重复名称、无效日期、缺少名称混排。
# 数据记录编号（表头不计）：
#   1 新客户甲                 有效新增
#   2 新客户乙                 有效新增
#   3 原客户甲                 与已有客户重复
#   4 坏日期客户               重要日期不是真实日历日期
#   5 （缺少名称）             name 列为空
#   6 保存中途失败目标客户      有效新增（写入中途失败的注入点；前两条已写入）
#   7 新客户丁                 有效新增（失败时不会执行到）
FILE_ONE = (
    "name,source,region,industry,important_date\n"
    "新客户甲,展会,华东,制造业,2024-01-01\n"
    "新客户乙,网络,华南,零售业,2024-05-05\n"
    "原客户甲,广告,,,\n"
    "坏日期客户,,,,2025-13-40\n"
    ",展会,华东,制造业,2024-02-02\n"
    "%s,渠道,西南,能源业,2024-06-06\n"
    "新客户丁,直邮,西北,物流业,2024-07-07\n"
) % MIDWAY_TARGET
FILE_ONE_VALID = ["新客户甲", "新客户乙", MIDWAY_TARGET, "新客户丁"]
FILE_ONE_GHOSTS = FILE_ONE_VALID

# 文件二：提交阶段失败——有效记录都会写入，最终提交时出错。
#   1 提交甲     有效新增
#   2 原客户乙   与已有客户重复
#   3 提交坏日期 无效日期
#   4 （缺名称）
#   5 提交乙     有效新增
FILE_TWO = (
    "name,important_date\n"
    "提交甲,2024-08-08\n"
    "原客户乙,\n"
    "提交坏日期,2024-99-99\n"
    ",2024-09-09\n"
    "提交乙,2024-09-09\n"
)
FILE_TWO_VALID = ["提交甲", "提交乙"]
FILE_TWO_GHOSTS = FILE_TWO_VALID

SEED_CSV = (
    "name,source,region,industry,important_date\n"
    "原客户甲,老来源,华东,制造业,2020-01-01\n"
    "原客户乙,老来源二,华北,零售业,2021-02-02\n"
)
ORIGINAL_NAMES = ["原客户甲", "原客户乙"]
FAILED_FILE_NAMES = set(FILE_ONE_GHOSTS) | set(FILE_TWO_GHOSTS)

CARRY_CSV = "name,source\n顺带保存客户,展会\n"
CARRY_NAME = "顺带保存客户"
CARRY_TWO_CSV = "name\n顺带保存客户二\n"
CARRY_TWO_NAME = "顺带保存客户二"


# ---------- 真实服务进程 ----------

def _drain(stream):
    for _ in stream:
        pass


def start_server(script, data_dir):
    proc = subprocess.Popen(
        [sys.executable, str(script),
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
            raw = resp.read().decode("utf-8")
            return resp.status, json.loads(raw)
    except urllib.error.HTTPError as exc:
        return exc.code, json.loads(exc.read().decode("utf-8"))


def import_clients(base, csv_text):
    return request("POST", "/api/clients/import", base, csv_text)


def batch_update(base, ids, updates):
    return request("POST", "/api/clients/batch-update", base,
                   json.dumps({"ids": ids, "updates": updates}))


def list_map(base):
    status, data = request("GET", "/api/clients", base)
    assert status == 200, data
    return {c["id"]: c for c in data["clients"]}


def names_of(clients):
    return sorted(c["name"] for c in clients.values())


# ---------- 断言 ----------

def assert_save_failure_rejection(ctx, status, data, original_ids, before, after):
    """保存阶段失败：400 + 非空中文 error，且无任何成功报告字段。"""
    expect(ctx + "：HTTP 400", status == 400, status)
    err = data.get("error") if isinstance(data, dict) else None
    expect(ctx + "：回复只有非空文本 error 说明",
           isinstance(data, dict) and set(data) == {"error"}
           and isinstance(err, str) and bool(err.strip()), data)
    expect(ctx + "：原因为中文说明",
           bool(err) and any("一" <= ch <= "鿿" for ch in err), err)
    expect(ctx + "：原因明确指出数据库保存失败、本次没有新增客户",
           bool(err) and "数据库保存失败" in err and "本次没有新增客户" in err, err)
    expect(ctx + "：不返回新增/未导入数量或成功记录报告",
           isinstance(data, dict) and not any(
               k in data for k in ("imported_count", "failed_count", "imported",
                                   "failures", "updated_count")),
           data)
    expect(ctx + "：客户总数与编号集合与失败前一致（本次新客户一个不留）",
           len(after) == len(before) and sorted(after) == sorted(before),
           (sorted(before), sorted(after)))
    expect(ctx + "：失败文件中的新客户全部不存在",
           not (FAILED_FILE_NAMES & {c["name"] for c in after.values()}),
           names_of(after))
    for cid in original_ids:
        expect(ctx + "：原有客户 #%s 的编号、名称与各项资料逐字段保持原样" % cid,
               cid in after and after[cid] == before[cid], (before.get(cid), after.get(cid)))


def assert_no_ghosts(ctx, clients, extra_ok=()):
    present = {c["name"] for c in clients.values()}
    ghosts = FAILED_FILE_NAMES & present
    expect(ctx + "：失败文件中的客户没有被顺带保存", not ghosts, sorted(ghosts))
    for name in extra_ok:
        expect(ctx + "：正常操作的客户「%s」存在" % name, name in present, sorted(present))


def main():
    shim = write_shim()
    data_dir = TMP / "data"
    overall_ok = True
    try:
        # ===== 0. 用真实 app 种子两名原有客户，记录失败前快照 =====
        proc, base = start_server(APP_DIR / "app.py", data_dir)
        try:
            status, data = import_clients(base, SEED_CSV)
            assert status == 200 and data["imported_count"] == 2, data
            original_ids = [item["id"] for item in data["imported"]]
            before_seed = list_map(base)
            expect("种子：原有客户两名、资料各不相同",
                   len(before_seed) == 2 and
                   [before_seed[cid]["name"] for cid in original_ids] == ORIGINAL_NAMES)
        finally:
            stop_server(proc)

        # ===== 1/2. 换成会注入数据库错误的启动器打开同一数据库 =====
        proc, base = start_server(shim, data_dir)
        try:
            # ---- 1. 某条客户写入中途失败（前面已有有效新客户写入）----
            before = list_map(base)
            EXEC_FLAG.touch()
            status, data = import_clients(base, FILE_ONE)
            assert_save_failure_rejection(
                "写入中途失败", status, data, original_ids, before, list_map(base))
            expect("写入中途失败：exec 标志一次性触发后已解除", not EXEC_FLAG.exists())

            # 失败之后的正常导入与批量修改不能把失败文件的客户顺带提交。
            status, data = import_clients(base, CARRY_CSV)
            expect("失败后正常导入仍成功（1 新增）",
                   status == 200 and data["imported_count"] == 1
                   and data["failed_count"] == 0, data)
            carry_id = data["imported"][0]["id"]
            after_carry = list_map(base)
            assert_no_ghosts("写入中途失败后再导入", after_carry, [CARRY_NAME])

            status, data = batch_update(base, [carry_id],
                                        {"region": {"op": "set", "value": " 华中 "}})
            expect("失败后批量修改正常成功、返回处理数量",
                   status == 200 and data == {"updated_count": 1}, data)
            after_batch = list_map(base)
            assert_no_ghosts("写入中途失败后再批量修改", after_batch, [CARRY_NAME])
            expect("批量修改只影响正常客户、原有客户不变",
                   after_batch[carry_id]["region"] == "华中"
                   and all(after_batch[cid] == before_seed[cid] for cid in original_ids),
                   "资料被顺带修改")
        finally:
            stop_server(proc)

        # ---- 重启真实后端打开同一数据库：回滚结果持久、无半截保存 ----
        proc, base = start_server(APP_DIR / "app.py", data_dir)
        try:
            restarted = list_map(base)
            expect("写入中途失败后重启：仍无失败文件客户残留",
                   not (FAILED_FILE_NAMES & {c["name"] for c in restarted.values()}),
                   names_of(restarted))
            expect("写入中途失败后重启：正常操作结果保留、原有客户不变",
                   names_of(restarted) == sorted(ORIGINAL_NAMES + [CARRY_NAME]),
                   names_of(restarted))
        finally:
            stop_server(proc)

        # ---- 2. 全部客户已写入但最终提交失败 ----
        proc, base = start_server(shim, data_dir)
        try:
            before = list_map(base)
            COMMIT_FLAG.touch()
            status, data = import_clients(base, FILE_TWO)
            assert_save_failure_rejection(
                "最终提交失败", status, data, original_ids, before, list_map(base))
            expect("最终提交失败：commit 标志一次性触发后已解除", not COMMIT_FLAG.exists())

            status, data = import_clients(base, CARRY_TWO_CSV)
            expect("提交失败后正常导入仍成功（1 新增）",
                   status == 200 and data["imported_count"] == 1, data)
            after_carry2 = list_map(base)
            assert_no_ghosts("最终提交失败后再导入", after_carry2,
                             [CARRY_NAME, CARRY_TWO_NAME])

            carry2_id = next(
                cid for cid, c in after_carry2.items() if c["name"] == CARRY_TWO_NAME)
            status, data = batch_update(base, [carry2_id],
                                        {"industry": {"op": "set", "value": " 物流 "}})
            expect("提交失败后批量修改正常成功",
                   status == 200 and data == {"updated_count": 1}, data)
            after_batch2 = list_map(base)
            assert_no_ghosts("最终提交失败后再批量修改", after_batch2,
                             [CARRY_NAME, CARRY_TWO_NAME])
        finally:
            stop_server(proc)

        # 重启真实后端：提交失败同样没有任何残留。
        proc, base = start_server(APP_DIR / "app.py", data_dir)
        try:
            restarted = list_map(base)
            expect("最终提交失败后重启：仍无失败文件客户残留",
                   not (FAILED_FILE_NAMES & {c["name"] for c in restarted.values()}),
                   names_of(restarted))
            expect("最终提交失败后重启：库内仅有两名原有客户与两次顺带操作客户",
                   names_of(restarted) ==
                   sorted(ORIGINAL_NAMES + [CARRY_NAME, CARRY_TWO_NAME]),
                   names_of(restarted))
            pre_retry = restarted

            # ===== 3. 数据库恢复后重新提交同一文件：有效客户正常新增 =====
            # 文件一：4 名有效新客户新增，重复/坏日期/缺名称逐条报告；
            # 失败时回滚的客户不能被误报为已有重复。
            status, data = import_clients(base, FILE_ONE)
            expect("重试文件一：200 且新增 4、未导入 3",
                   status == 200 and data["imported_count"] == 4
                   and data["failed_count"] == 3
                   and [x["name"] for x in data["imported"]] == FILE_ONE_VALID,
                   data)
            expect("重试文件一：新增编号对应数据记录 1/2/6/7（不是按处理条数凑数）",
                   [x["row"] for x in data["imported"]] == [1, 2, 6, 7], data)
            failures = {(f["row"]): f["reason"] for f in data["failures"]}
            expect("重试文件一：未导入编号为第 3/4/5 条",
                   sorted(failures) == [3, 4, 5], sorted(failures))
            expect("重试文件一：第 3 条按与已有客户重复报告并给出原有编号",
                   "重复" in failures[3] and str(original_ids[0]) in failures[3]
                   and "未更新" in failures[3], failures.get(3))
            expect("重试文件一：第 4 条按无效真实日期报告（保留原值）",
                   "2025-13-40" in failures[4] and "真实日历日期" in failures[4],
                   failures.get(4))
            expect("重试文件一：第 5 条按缺少名称报告",
                   "缺少名称" in failures[5], failures.get(5))
            expect("重试文件一：回滚过的客户没有被误报为已有重复",
                   all("重复" not in item.get("reason", "") for item in data["imported"])
                   and all(any(c["name"] == n for c in list_map(base).values())
                           for n in FILE_ONE_VALID),
                   "有效客户未全部正常落库")

            # 文件二：同样正常新增 2 名、逐条报告 3 条记录级失败。
            status, data = import_clients(base, FILE_TWO)
            expect("重试文件二：200 且新增 2、未导入 3，提交失败客户不被误报重复",
                   status == 200 and data["imported_count"] == 2
                   and data["failed_count"] == 3
                   and [x["name"] for x in data["imported"]] == FILE_TWO_VALID
                   and [x["row"] for x in data["imported"]] == [1, 5],
                   data)
            failures2 = {f["row"]: f["reason"] for f in data["failures"]}
            expect("重试文件二：第 2 条与原有客户重复、第 3 条日期无效、第 4 条缺名称",
                   sorted(failures2) == [2, 3, 4]
                   and str(original_ids[1]) in failures2[2]
                   and "2024-99-99" in failures2[3] and "缺少名称" in failures2[4],
                   failures2)

            final = list_map(base)
            expect("重试后客户总数 = 原有 2 + 顺带 2 + 文件一 4 + 文件二 2 = 10",
                   len(final) == 10, len(final))
            expect("重试后失败文件中的客户本次已全部真实存在",
                   FAILED_FILE_NAMES <= {c["name"] for c in final.values()},
                   names_of(final))
            expect("重试后原有客户编号、名称与各项资料仍保持种子时原样",
                   all(final[cid] == pre_retry[cid] == before_seed[cid]
                       for cid in original_ids),
                   "原有客户被改动")
            expect("重试后顺带保存的两名客户及其修改保留",
               final[next(c for c, r in final.items() if r["name"] == CARRY_NAME)]["region"]
                   == "华中"
               and final[next(c for c, r in final.items()
                              if r["name"] == CARRY_TWO_NAME)]["industry"] == "物流")
        finally:
            stop_server(proc)

    except Exception as exc:
        overall_ok = False
        import traceback
        traceback.print_exc()
        expect("测试执行未抛出异常", False, repr(exc))

    shutil.rmtree(TMP, ignore_errors=True)
    print("\n%s" % ("=" * 46))
    if expect.failed == 0 and overall_ok:
        print("导入保存失败原子性回归全部通过")
        return 0
    print("%d 项失败" % expect.failed)
    return 1


if __name__ == "__main__":
    sys.exit(main())

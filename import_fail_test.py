#!/usr/bin/env python3
"""CSV 导入保存阶段数据库出错的端到端回归测试。

与 smoke_test.py / long_list_test.py 一样启动真实 app.py、只走公开接口
（CSV 导入、客户列表、批量修改），不模拟任何服务端业务逻辑。本文件关注
「服务已开始保存本次文件中的有效新客户之后数据库出错」的确定性结果：

- 某条客户写入失败（第 3 条 INSERT 执行时真实磁盘 I/O 错误，前两条已写入）；
- 全部客户已写入但最终提交失败（commit 时真实磁盘 I/O 错误）；
两种情况都必须：
  * 返回 HTTP 400 与非空中文 error（明确指出数据库保存失败、本次没有新增
    客户），回复不含 imported_count/failed_count/imported/failures，不把
    已处理条数当成已保存数量；
  * 本次文件中的任何新客户都不保留（失败文件同时含重复名称、无效日期、
    缺少名称记录时，通过检查的新客户同样全部撤销），原有客户编号、名称与
    各项资料保持原样，不是 200 部分成功；
  * 同一连接上随后的客户列表读取、另外一次正常导入与批量修改都不会顺带
    把失败文件的客户提交出来；
  * 重启后端打开同一数据库后仍无残留；数据库恢复后重新提交同一文件，
    原本有效的新客户正常新增，不会因失败时的残留被误报为已有重复。

启动器只存在于本测试的临时目录中（monkeypatch 仅发生在测试子进程内），
不修改仓库里的 app.py，也不改变任何公开接口行为。
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
APP = APP_DIR / "app.py"
TMP = Path(tempfile.mkdtemp(prefix="clientbook-importfail-"))
FAIL_EXEC_FLAG = TMP / "arm-import-fail-exec.flag"      # 武装后：第 3 条 INSERT 出错
FAIL_COMMIT_FLAG = TMP / "arm-import-fail-commit.flag"  # 武装后：提交时出错

# 在真实 SQLite 连接上按标志文件各注入一次性数据库错误：
# - exec 标志：第 3 条 INSERT INTO clients 执行时抛 OperationalError
#   （保存已开始、前两条新客户已写入、尚未全部完成）；
# - commit 标志：本连接下一次 commit 抛 OperationalError
#   （所有 INSERT 已执行成功、最终提交失败）。
# 标志文件由测试进程在请求前创建、连接在触发时自行删除，均为一次性。
SHIM_FAIL = r'''
import os
import sys
sys.path.insert(0, __APP_DIR__)
import sqlite3
import app

EXEC_FLAG = __EXEC_FLAG__
COMMIT_FLAG = __COMMIT_FLAG__
state = {"inserts": 0}


def take_flag(path):
    try:
        os.remove(path)
        return True
    except OSError:
        return False


class FailConnection(sqlite3.Connection):
    def execute(self, sql, parameters=()):
        if sql.lstrip().upper().startswith("INSERT INTO CLIENTS"):
            state["inserts"] += 1
            if state["inserts"] == 3 and take_flag(EXEC_FLAG):
                state["inserts"] = 0
                raise sqlite3.OperationalError("测试启动器注入：客户写入中途磁盘 I/O 错误")
        return super().execute(sql, parameters)

    def commit(self):
        if take_flag(COMMIT_FLAG):
            state["inserts"] = 0
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


def write_shim(name, template):
    path = TMP / name
    path.write_text(
        template.replace("__APP_DIR__", repr(str(APP_DIR)))
        .replace("__EXEC_FLAG__", repr(str(FAIL_EXEC_FLAG)))
        .replace("__COMMIT_FLAG__", repr(str(FAIL_COMMIT_FLAG))),
        encoding="utf-8")
    return path


def expect(label, cond, detail=""):
    print(("PASS" if cond else "FAIL"), label,
          "" if cond else (detail and ("\n      " + str(detail))))
    if not cond:
        expect.failed += 1
expect.failed = 0


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


def request(method, path, base, body=None):
    data = body.encode("utf-8") if isinstance(body, str) else None
    req = urllib.request.Request(base + path, data=data, method=method)
    try:
        with urllib.request.urlopen(req) as resp:
            return resp.status, json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        try:
            return exc.code, json.loads(exc.read().decode("utf-8"))
        except (ValueError, OSError):
            return exc.code, None
    except (urllib.error.URLError, OSError):
        # 连接被服务端直接中断（如保存异常未被捕获）：没有状态码也没有回复体，
        # 交给断言判为失败，而不是让测试本身抛异常退出。
        return None, None


def import_csv(base, csv_text):
    return request("POST", "/api/clients/import", base, csv_text)


def batch_update(base, ids, updates):
    return request("POST", "/api/clients/batch-update", base,
                   json.dumps({"ids": ids, "updates": updates}))


def list_map(base):
    status, data = request("GET", "/api/clients", base)
    assert status == 200, data
    return {c["id"]: c for c in data["clients"]}


# 失败文件：同时含有通过检查的新客户、与已有客户重复、无效日期、缺少名称、
# 文件内重名。数据记录编号（表头不计）：
#   1 新客甲  有效（第 1 条 INSERT）
#   2 原有甲  与已有客户重复 → 记录级失败
#   3 新客乙  重要日期 2025-13-40 无效 → 记录级失败
#   4 新客丙  有效（第 2 条 INSERT）
#   5 （空名称）→ 记录级失败
#   6 新客甲  与文件内第 1 条重复 → 记录级失败
#   7 新客丁  有效（第 3 条 INSERT：exec 注入在此条出错）
FAILED_VALID_NAMES = ["新客甲", "新客丙", "新客丁"]
FAILED_FILE = (
    "name,source,region,industry,important_date\n"
    "新客甲,展会,华东,制造业,2024-01-01\n"
    "原有甲,广告,华北,能源,2020-01-01\n"
    "新客乙,官网,华南,零售业,2025-13-40\n"
    "新客丙,网络,华南,零售业,2024-05-05\n"
    ",展会,华东,制造业,2024-02-02\n"
    "新客甲,,,,\n"
    "新客丁,门店,西北,能源,2023-03-03\n"
)


def assert_failure_response(label, status, data):
    expect(label + "：返回 HTTP 400", status == 400, (status, data))
    error = data.get("error") if isinstance(data, dict) else None
    expect(label + "：error 为非空中文说明",
           isinstance(error, str)
           and bool(error.strip()) and any("一" <= ch <= "鿿" for ch in error),
           data)
    expect(label + "：原因明确指出数据库保存失败",
           isinstance(error, str) and "保存失败" in error, error)
    expect(label + "：原因明确说明本次没有新增客户",
           isinstance(error, str)
           and ("没有新增" in error or "未新增" in error)
           and "撤销" in error, error)
    # 不返回新增数量、未导入数量或任何成功记录报告，也不能把此前处理过的
    # 条数（imported 明细）当成已保存数量。
    expect(label + "：回复不含任何成功数量与成功/失败记录报告",
           isinstance(data, dict)
           and "imported_count" not in data and "failed_count" not in data
           and "imported" not in data and "failures" not in data
           and set(data.keys()) == {"error"}, data)


def assert_no_residue(label, after, before):
    expect(label + "：客户列表与失败前完全一致（编号、名称、各项资料原样）",
           after == before,
           {"before": sorted((c["id"], c["name"]) for c in before.values()),
            "after": sorted((c["id"], c["name"]) for c in after.values())})
    present = {c["name"] for c in after.values()}
    expect(label + "：失败文件中通过检查的新客户一个都没有留下",
           not (present & set(FAILED_VALID_NAMES)), sorted(present))
    expect(label + "：连字段错误的记录也没有留下",
           "新客乙" not in present, sorted(present))


def run_failure_scenario(label, data_dir, shim, arm):
    """完整跑一遍：干净后端种入原有客户 → 注入失败 → 同进程后续操作 → 重启重试。"""
    # 1) 真实后端准备两名资料完整的原有客户，记录失败前快照。
    proc, base = start_server(APP, data_dir)
    try:
        status, data = import_csv(base, "name,source,region,industry,important_date\n"
                                        "原有甲,老来源甲,华北,能源,2019-01-01\n"
                                        "原有乙,老来源乙,华南,教育,2018-02-02\n")
        assert status == 200 and data["imported_count"] == 2, data
        before = list_map(base)
        assert {c["name"] for c in before.values()} == {"原有甲", "原有乙"}
    finally:
        stop_server(proc)

    # 2) 换成会注入数据库错误的启动器，打开同一数据库。
    proc, base = start_server(shim, data_dir)
    try:
        arm()  # 武装一次性错误
        status, data = import_csv(base, FAILED_FILE)
        assert_failure_response(label, status, data)

        # 失败后立即在同一连接上读取列表：无残留。
        assert_no_residue(label + "（失败后立即读取）", list_map(base), before)
        expect(label + "：一次性错误标志已解除",
               not FAIL_EXEC_FLAG.exists() and not FAIL_COMMIT_FLAG.exists())

        # 3) 同一连接上再做一次完全无关的正常导入：它的提交不能把失败文件
        #    已回滚的客户顺带提交出来。
        status, data = import_csv(base, "name,source\n补救新客,补救来源\n")
        expect(label + "：随后的正常导入仍 200 且只新增它自己的 1 条",
               status == 200 and data["imported_count"] == 1
               and data["failed_count"] == 0
               and [x["name"] for x in data["imported"]] == ["补救新客"],
               (status, data))
        after_import = list_map(base)
        present_import = {c["name"] for c in after_import.values()}
        expect(label + "：正常导入后失败文件客户仍一个都没出现",
               not (present_import & (set(FAILED_VALID_NAMES) | {"新客乙"})),
               sorted(present_import))
        expect(label + "：正常导入后恰为 3 名（原有两名 + 补救新客），原有客户资料不变",
               {c["name"] for c in after_import.values()} ==
               {"补救新客", "原有甲", "原有乙"}
               and all(after_import[cid] == before[cid] for cid in before),
               sorted((c["id"], c["name"]) for c in after_import.values()))
        rescue = next(c for c in after_import.values() if c["name"] == "补救新客")
        expect(label + "：补救新客按本次文件保存（source 落库、其余字段为空）",
               rescue["source"] == "补救来源" and rescue["region"] is None
               and rescue["industry"] is None and rescue["important_date"] is None,
               rescue)

        # 4) 同一连接上执行批量修改：同样不能顺带保存失败文件的客户。
        ids = sorted(after_import)
        status, data = batch_update(base, ids, {"industry": {"op": "clear"}})
        expect(label + "：随后的批量修改仍 200 且按当前真实客户计数",
               status == 200 and data == {"updated_count": 3}, (status, data))
        after_batch = list_map(base)
        present_after_batch = {c["name"] for c in after_batch.values()}
        expect(label + "：批量修改后失败文件客户仍未出现",
               not (present_after_batch & (set(FAILED_VALID_NAMES) | {"新客乙"})),
               sorted(present_after_batch))
        expect(label + "：批量修改只作用于真实存在的客户（行业清空、共 3 名）",
               {c["name"] for c in after_batch.values()} ==
               {"补救新客", "原有甲", "原有乙"}
               and all(c["industry"] is None for c in after_batch.values()),
               sorted((c["name"], c["industry"]) for c in after_batch.values()))
    finally:
        stop_server(proc)

    # 5) 重启真实后端打开同一数据库：回滚结果持久，没有半截保存。
    proc, base = start_server(APP, data_dir)
    try:
        restarted = list_map(base)
        expect(label + "：重启后仍无失败文件残留（共 3 名：原有两名 + 补救新客）",
            {c["name"] for c in restarted.values()} ==
            {"补救新客", "原有甲", "原有乙"},
            sorted(c["name"] for c in restarted.values()))
        expect(label + "：重启后原有客户资料保持原样",
            all(restarted[cid]["name"] == before[cid]["name"]
                and restarted[cid]["source"] == before[cid]["source"]
                and restarted[cid]["region"] == before[cid]["region"]
                and restarted[cid]["important_date"] == before[cid]["important_date"]
                and restarted[cid]["id"] == cid
                for cid in before),
            [restarted.get(cid) for cid in before])

        # 6) 数据库恢复后重新提交同一文件：原本有效的 3 条正常新增，
        #    不被误报为与失败残留重复；记录级失败仍按原规则准确报告。
        status, data = import_csv(base, FAILED_FILE)
        expect(label + "：恢复后重传同一文件为 200（不是再次拒绝）",
               status == 200, (status, data))
        expect(label + "：原本有效的 3 条新客户正常新增",
               data["imported_count"] == 3 and data["failed_count"] == 4
               and {x["name"] for x in data["imported"]} == set(FAILED_VALID_NAMES),
               data)
        failures = {f["row"]: f["reason"] for f in data["failures"]}
        expect(label + "：记录级失败编号准确（第 2/3/5/6 条，表头不计）",
               sorted(failures) == [2, 3, 5, 6], failures)
        original_id = next(cid for cid, c in restarted.items() if c["name"] == "原有甲")
        expect(label + "：第 2 条仍按与已有客户重复报告（指向原有客户编号）",
               "重复" in failures[2] and str(original_id) in failures[2], failures.get(2))
        expect(label + "：第 3 条仍按无效日期报告",
               "2025-13-40" in failures[3] and "日历" in failures[3], failures.get(3))
        expect(label + "：第 5 条仍按缺少名称报告", "名称" in failures[5], failures.get(5))
        expect(label + "：第 6 条仍按与文件内第 1 条重复报告",
               "第 1 条" in failures[6], failures.get(6))
        # 关键：三条有效记录都没有被报成与「失败时残留客户」重复。
        expect(label + "：有效记录没有被误报为已有重复",
               all(not any(name in reason for reason in failures.values())
                   for name in FAILED_VALID_NAMES),
               failures)

        final = list_map(base)
        expect(label + "：重传后列表包含全部 3 条新客户，资料按文件保存",
               {c["name"] for c in final.values()} ==
               {"补救新客", "原有甲", "原有乙", "新客丁", "新客丙", "新客甲"},
               sorted(c["name"] for c in final.values()))
        jia = next(c for c in final.values() if c["name"] == "新客甲")
        expect(label + "：新客甲来源/地区/行业/日期按文件落库",
               (jia["source"], jia["region"], jia["industry"], jia["important_date"])
               == ("展会", "华东", "制造业", "2024-01-01"), jia)
    finally:
        stop_server(proc)


def main():
    shim_fail = write_shim("shim_import_fail.py", SHIM_FAIL)
    overall_ok = True
    try:
        # 场景一：某条客户写入失败（第 3 条 INSERT 时真实磁盘 I/O 错误）
        run_failure_scenario(
            "写入中途失败",
            TMP / "data-exec",
            shim_fail,
            lambda: FAIL_EXEC_FLAG.touch())

        # 场景二：全部客户已写入但最终提交失败（commit 时真实磁盘 I/O 错误）
        run_failure_scenario(
            "最终提交失败",
            TMP / "data-commit",
            shim_fail,
            lambda: FAIL_COMMIT_FLAG.touch())
    except Exception as exc:
        overall_ok = False
        import traceback
        traceback.print_exc()
        expect("测试执行未抛出异常", False, repr(exc))

    shutil.rmtree(TMP, ignore_errors=True)
    print("\n%s" % ("=" * 46))
    if expect.failed == 0 and overall_ok:
        print("导入保存失败回归全部通过")
        return 0
    print("%d 项失败" % expect.failed)
    return 1


if __name__ == "__main__":
    sys.exit(main())

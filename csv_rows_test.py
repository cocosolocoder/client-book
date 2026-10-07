#!/usr/bin/env python3
"""CSV 导入数据记录编号的端到端回归测试。

与 smoke_test.py / import_fail_test.py 一样启动真实 app.py、只走公开接口
（CSV 导入、客户列表），不模拟任何服务端行为。本文件保护导入报告中
「数据记录编号」的含义与空行、换行符、引号字段的现有导入规则：

- 编号从表头后的第一条数据记录开始（表头不计）；带引号字段内的换行
  （含连续多次换行）始终属于同一条记录，不增加编号；
- 同一份资料用 LF、CRLF、单独 CR 或混合的记录换行导入，新增数量、
  未导入数量、逐条记录编号与原因完全一致；
- 表头之前、数据记录之间及文件末尾的完全空行（没有任何字段字符的一行）
  都不算数据记录：不生成缺少名称的失败项，也不使后面的编号增加；
  只有空格的名称与用一对双引号明确填写的空名称仍是数据记录，其他列合法时
  报告该条缺少名称，后续记录继续编号；
- 带引号的名称/来源中的逗号、转义双引号与多次换行始终属于同一条客户；
  字段内部的 CRLF 或单独 CR 保存后统一为 LF，内部逗号、双引号与空白保留，
  字段首尾仍按现有规则去除空白；
- 整份拒绝（如未闭合引号）按实际数据记录位置说明结构损坏：HTTP 400 与
  可读原因，损坏位置之前的合法新客户也不保存，原有列表保持原样；
- 没有末尾换行的合法最后一条正常参与导入。
"""
import json
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

APP = Path(__file__).resolve().parent / "app.py"
TMP = Path(tempfile.mkdtemp(prefix="clientbook-csvrows-"))


def expect(label, cond, detail=""):
    print(("PASS" if cond else "FAIL"), label,
          "" if cond else (detail and ("\n      " + str(detail))))
    if not cond:
        expect.failed += 1
expect.failed = 0


def _drain(stream):
    """持续读空服务进程的 stdout/stderr 管道，避免服务阻塞在写日志上。"""
    for _ in stream:
        pass


def start_server(data_dir):
    proc = subprocess.Popen(
        [sys.executable, str(APP),
         "serve", "--host", "127.0.0.1", "--port", "0", "--data-dir", str(data_dir)],
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    import re
    base = None
    deadline = time.time() + 8
    while time.time() < deadline:
        line = proc.stdout.readline()
        if not line:
            if proc.poll() is not None:
                raise RuntimeError("服务启动失败：%s" % proc.stdout.read())
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


def request(method, path, base, text=None):
    data = text.encode("utf-8") if isinstance(text, str) else None
    req = urllib.request.Request(base + path, data=data, method=method)
    try:
        with urllib.request.urlopen(req) as resp:
            return resp.status, json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        return exc.code, json.loads(exc.read().decode("utf-8"))


def import_csv(base, csv_text):
    return request("POST", "/api/clients/import", base, csv_text)


def list_clients(base):
    status, data = request("GET", "/api/clients", base)
    assert status == 200, data
    return data["clients"]


# ===== 换行符等价性：同一份逻辑资料，四种记录换行写法 =====
# 逻辑内容（空字符串为完全空行）：表头前空行、跨行引号字段（字段内部含 CRLF）、
# 记录之间与末尾的完全空行、只有空格的名称、文件内重名、无效日期、有效记录。
# 数据记录编号（表头不计，空行不计）：
#   1 换行\n客户A  有效（来源字段内部 CRLF 保存后统一为 LF）
#   2 （空格名称） 缺少名称
#   3 换行\n客户A  与文件内第 1 条重复
#   4 客户B       重要日期 2025-13-40 无效
#   5 客户C       有效
LOGICAL_LINES = [
    "", "",
    "name,source,important_date",
    '"换行\n客户A","线上\r\n渠道",2024-02-29',
    "",
    " ,展会,2024-01-01",
    '"换行\n客户A",官网,',
    "", "",
    "客户B,门店,2025-13-40",
    "客户C,广告,2025-05-05",
    "",
]


def build_uniform(sep):
    return sep.join(LOGICAL_LINES)


def build_mixed():
    seps = ["\r\n", "\r", "\n"]
    parts = [LOGICAL_LINES[0]]
    for i, line in enumerate(LOGICAL_LINES[1:]):
        parts.append(seps[i % len(seps)])
        parts.append(line)
    return "".join(parts)


def scenario_line_endings():
    variants = [
        ("LF", build_uniform("\n")),
        ("CRLF", build_uniform("\r\n")),
        ("CR", build_uniform("\r")),
        ("混合", build_mixed()),
    ]
    outcomes = []
    for index, (label, text) in enumerate(variants):
        proc, base = start_server(TMP / ("data-eol-%d" % index))
        try:
            status, data = import_csv(base, text)
            expect("换行符 %s：导入 200" % label, status == 200, (status, data))
            expect("换行符 %s：2 新增 3 未导入" % label,
                   data.get("imported_count") == 2 and data.get("failed_count") == 3,
                   data)
            expect("换行符 %s：新增明细编号为第 1、5 条（表头与空行不计）" % label,
                   [x["row"] for x in data.get("imported", [])] == [1, 5]
                   and [x["name"] for x in data.get("imported", [])] ==
                   ["换行\n客户A", "客户C"],
                   data.get("imported"))
            failures = {f["row"]: f["reason"] for f in data.get("failures", [])}
            expect("换行符 %s：失败编号为第 2、3、4 条（空行不产生失败项）" % label,
                   sorted(failures) == [2, 3, 4], data.get("failures"))
            expect("换行符 %s：第 2 条按缺少名称报告" % label,
                   "名称" in failures.get(2, ""), failures.get(2))
            expect("换行符 %s：第 3 条说明与文件内第 1 条重复" % label,
                   "第 1 条" in failures.get(3, ""), failures.get(3))
            expect("换行符 %s：第 4 条按无效日期报告" % label,
                   "2025-13-40" in failures.get(4, ""), failures.get(4))
            clients = list_clients(base)
            expect("换行符 %s：列表只增加第 1、5 条两名客户" % label,
                   [c["name"] for c in clients] == ["换行\n客户A", "客户C"], clients)
            first = clients[0] if clients else {}
            expect("换行符 %s：字段内部 CRLF 保存后统一为 LF、跨行名称完整" % label,
                   first.get("source") == "线上\n渠道"
                   and first.get("name") == "换行\n客户A"
                   and first.get("important_date") == "2024-02-29"
                   and first.get("region") is None and first.get("industry") is None,
                   first)
            outcomes.append((data, clients))
        finally:
            stop_server(proc)
    for label, _ in variants[1:]:
        index = [v[0] for v in variants].index(label)
        expect("换行符 %s：报告与 LF 完全一致（数量、编号、原因、id）" % label,
               outcomes[index][0] == outcomes[0][0],
               {"lf": outcomes[0][0], label: outcomes[index][0]})
        expect("换行符 %s：保存的客户资料与 LF 完全一致" % label,
               outcomes[index][1] == outcomes[0][1],
               {"lf": outcomes[0][1], label: outcomes[index][1]})


def scenario_main():
    proc, base = start_server(TMP / "data-main")
    try:
        # 1) 准备两名资料互不相同的已有客户（验证导入后已有客户保持原样）。
        status, data = import_csv(
            base,
            "name,source,region,industry,important_date\n"
            "已有甲,老来源甲,华北,能源,2019-01-01\n"
            "已有乙,老来源乙,华南,教育,2018-02-02\n")
        assert status == 200 and data["imported_count"] == 2, data
        existing = list_clients(base)
        existing_ids = [c["id"] for c in existing]

        # 2) 任务示例：第一条为跨行客户，之后夹着完全空行；第二条名称为空；
        #    第三条与第一条同名；第四条是另一名有效客户。
        status, data = import_csv(
            base,
            "name,source,region,industry,important_date\n"
            '"跨行客户\n甲","来源,含""引号""",华东,制造业,2024-01-01\n'
            "\n"
            "\n"
            ",展会,华南,零售业,2024-02-02\n"
            '"跨行客户\n甲",官网,华北,互联网,2024-03-03\n'
            "客户乙,广告,西南,餐饮,2024-04-04\n")
        expect("示例文件：200 且 2 新增 2 未导入",
               status == 200 and data.get("imported_count") == 2
               and data.get("failed_count") == 2, (status, data))
        expect("示例文件：新增明细编号为第 1、4 条",
               [x["row"] for x in data.get("imported", [])] == [1, 4]
               and [x["name"] for x in data.get("imported", [])] ==
               ["跨行客户\n甲", "客户乙"],
               data.get("imported"))
        failures = {f["row"]: f["reason"] for f in data.get("failures", [])}
        expect("示例文件：失败定位到第 2、3 条（空行不编号）",
               sorted(failures) == [2, 3], data.get("failures"))
        expect("示例文件：第 2 条按缺少名称报告",
               "名称" in failures.get(2, ""), failures.get(2))
        expect("示例文件：第 3 条说明与文件内第 1 条重复",
               "第 1 条" in failures.get(3, ""), failures.get(3))
        clients = list_clients(base)
        expect("示例文件：列表只增加这两名客户",
               [c["id"] for c in clients][:2] == existing_ids
               and [c["name"] for c in clients][2:] == ["跨行客户\n甲", "客户乙"],
               clients)
        expect("示例文件：已有客户编号与资料保持原样",
               clients[:2] == existing, clients[:2])
        new_one = clients[2]
        expect("示例文件：跨行客户资料按文件保存（逗号与转义引号保留）",
               new_one["name"] == "跨行客户\n甲"
               and new_one["source"] == '来源,含"引号"'
               and new_one["region"] == "华东"
               and new_one["industry"] == "制造业"
               and new_one["important_date"] == "2024-01-01", new_one)

        # 3) 完全空行（表头之前、记录之间、文件末尾）都不算数据记录；
        #    只有空格的名称、显式 "" 空名称与纯空格行仍是数据记录并参与编号。
        status, data = import_csv(
            base,
            "\n"
            "\n"
            "name,source\n"
            "空行甲,展会\n"      # 记录 1
            "\n"
            "  ,展会\n"          # 记录 2：只有空格的名称 → 缺少名称
            '"",官网\n'          # 记录 3：显式 "" 空名称 → 缺少名称
            "   \n"              # 记录 4：纯空格行（无逗号）→ 列数不符，仍占编号
            "\n"
            "空行乙,广告\n"      # 记录 5
            "\n"
            "\n")
        expect("空行文件：200 且 2 新增 3 未导入",
               status == 200 and data.get("imported_count") == 2
               and data.get("failed_count") == 3, (status, data))
        expect("空行文件：新增明细编号为第 1、5 条（表头前/记录间/末尾空行不计）",
               [x["row"] for x in data.get("imported", [])] == [1, 5]
               and [x["name"] for x in data.get("imported", [])] == ["空行甲", "空行乙"],
               data.get("imported"))
        failures = {f["row"]: f["reason"] for f in data.get("failures", [])}
        expect("空行文件：失败只来自第 2、3、4 条，空行不产生缺少名称失败项",
               sorted(failures) == [2, 3, 4], data.get("failures"))
        expect("空行文件：空格名称与显式空名称都按缺少名称报告",
               "名称" in failures.get(2, "") and "名称" in failures.get(3, ""),
               failures)
        expect("空行文件：纯空格行算数据记录（第 4 条列数不符）",
               "列数不符" in failures.get(4, ""), failures.get(4))
        names = [c["name"] for c in list_clients(base)]
        expect("空行文件：列表只新增空行甲、空行乙",
               names[-2:] == ["空行甲", "空行乙"], names)

        # 4) 引号字段内容：逗号、转义双引号与连续多次换行属于同一条客户；
        #    字段内部 CRLF/CR 统一为 LF，内部空白保留，字段首尾去空白。
        status, data = import_csv(
            base,
            "name,source\n"
            '"引号, 客户","  来源,含逗号 ""引号""\r\n第二行\r第三行  "\n'
            '"多行\n\n\n客户",官网\n'
            '"  普通客户  ",门店\n')
        expect("引号内容：200 且 3 新增（多次换行不拆记录）",
               status == 200 and data.get("imported_count") == 3
               and data.get("failed_count") == 0, (status, data))
        expect("引号内容：新增编号为第 1、2、3 条",
               [x["row"] for x in data.get("imported", [])] == [1, 2, 3],
               data.get("imported"))
        by_name = {c["name"]: c for c in list_clients(base)}
        quoted = by_name.get("引号, 客户", {})
        expect("引号内容：内部逗号/双引号/空白保留，CRLF 与 CR 统一为 LF，首尾去空白",
               quoted.get("source") == '来源,含逗号 "引号"\n第二行\n第三行', quoted)
        multiline = by_name.get("多行\n\n\n客户", {})
        expect("引号内容：连续多次换行的名称完整保存",
               multiline.get("source") == "官网", multiline)
        expect("引号内容：名称首尾空白按现有规则去除",
               by_name.get("普通客户", {}).get("source") == "门店",
               by_name.get("普通客户"))

        # 5) 整份拒绝：有效跨行记录与完全空行之后出现未闭合引号，
        #    按实际数据记录位置（第 2 条）说明结构损坏；任何客户都不新增。
        snapshot = list_clients(base)
        status, data = import_csv(
            base,
            "name,source\n"
            '"损坏\n客户",展会\n'
            "\n"
            "\n"
            '"未闭合,官网\n')
        expect("未闭合引号：HTTP 400 且有可读原因",
               status == 400 and isinstance(data.get("error"), str)
               and bool(data["error"].strip()), (status, data))
        expect("未闭合引号：按实际数据记录位置说明结构损坏（第 2 条，空行不计）",
               "结构损坏" in data.get("error", "")
               and "第 2 条" in data.get("error", "")
               and "未闭合" in data.get("error", ""), data.get("error"))
        after = list_clients(base)
        expect("未闭合引号：损坏前的合法新客户也不保存，原有列表保持原样",
               after == snapshot
               and "损坏\n客户" not in {c["name"] for c in after}, after)
        # 表头位置的结构损坏同样指出位置。
        status, data = import_csv(base, '"name,source\n甲,展会\n')
        expect("表头未闭合引号：400 且位置说明为表头",
               status == 400 and "表头" in data.get("error", "")
               and "未闭合" in data.get("error", ""), (status, data))
        expect("表头损坏后列表仍保持原样", list_clients(base) == snapshot)

        # 6) 没有末尾换行的合法最后一条正常参与导入（含跨行引号记录）。
        status, data = import_csv(
            base,
            "name,source\n"
            "末条甲,展会\n"
            "\n"
            '"末条\n乙",官网')
        expect("无末尾换行：200 且 2 新增",
               status == 200 and data.get("imported_count") == 2
               and data.get("failed_count") == 0, (status, data))
        expect("无末尾换行：最后一条编号为第 2 条（空行不计）",
               [x["row"] for x in data.get("imported", [])] == [1, 2]
               and [x["name"] for x in data.get("imported", [])] == ["末条甲", "末条\n乙"],
               data.get("imported"))
        names = [c["name"] for c in list_clients(base)]
        expect("无末尾换行：两名客户都进入列表",
               names[-2:] == ["末条甲", "末条\n乙"], names)
    finally:
        stop_server(proc)


def main():
    overall_ok = True
    try:
        scenario_line_endings()
        scenario_main()
    except Exception as exc:
        overall_ok = False
        import traceback
        traceback.print_exc()
        expect("测试执行未抛出异常", False, repr(exc))

    shutil.rmtree(TMP, ignore_errors=True)
    print("\n%s" % ("=" * 46))
    if expect.failed == 0 and overall_ok:
        print("数据记录编号回归全部通过")
        return 0
    print("%d 项失败" % expect.failed)
    return 1


if __name__ == "__main__":
    sys.exit(main())

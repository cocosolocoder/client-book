#!/usr/bin/env python3
"""CSV 导入记录编号与跨行字段的端到端回归测试。

与 smoke_test.py / import_fail_test.py 一样启动真实 app.py、只调用公开接口
（CSV 导入、客户列表），不模拟任何服务端业务逻辑。本文件保护导入报告中的
「数据记录编号」以及跨行字段落库内容：

- 同一份资料分别使用 LF、CRLF、单独 CR 或混合的记录换行时，新增数量、未导入
  数量与记录编号完全一致；编号从表头后的第一条数据记录开始，表头不计；
- 表头之前、数据记录之间、文件末尾的完全空行不算数据记录，不生成缺少名称的
  失败项，也不使后面的编号增加；只有空格的名称与用一对双引号明确填写的空
  名称仍是数据记录（其他列合法时报告缺少名称，后续记录继续编号）；
- 带引号的名称/来源中的逗号、转义双引号与多次换行始终属于同一条记录；字段
  内部 CRLF/CR 保存后统一为 LF，内部逗号、双引号与空白保留，字段首尾空白
  仍按现有规则去除，客户列表能读到完整内容；
- 综合场景：第一条为跨行新客户，其后夹完全空行，第二条名称为空，第三条与
  第一条同名，第四条为另一名有效客户且无末尾换行——报告新增 2 条、未导入
  2 条，失败分别定位第 2、3 条（第 3 条说明与文件内第 1 条重复），新增明细
  的原文件编号为第 1、4 条，列表只增加这两名客户，已有客户编号与资料不变；
- 整份拒绝时编号含义不变：有效跨行记录与完全空行之后出现未闭合引号，按实际
  数据记录位置（第 2 条）说明结构损坏，返回 HTTP 400 与可读中文原因；即使
  损坏位置之前有合法新客户也没有任何新增，原有列表保持原样；
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

APP_DIR = Path(__file__).resolve().parent
APP = APP_DIR / "app.py"
TMP = Path(tempfile.mkdtemp(prefix="clientbook-rows-"))

LF, CR, CRLF = b"\n", b"\r", b"\r\n"

# 综合场景中第一条跨行客户的两个字段（均带引号）：
# 名称内含 LF、CRLF 两种字段内换行、逗号、转义双引号，首尾各有空白；
# 来源内含单独 CR，首尾各有空白。落库后内部 CRLF/CR 都归一为 LF，
# 字段首尾空白按现有规则去除，其余内容原样保留。
R1 = b'" \xe8\xb7\xa8\xe8\xa1\x8c\xe5\xae\xa2\xe6\x88\xb7\n\xe7\x94\xb2\xe8\xa1\x8c\r\n'
R1 += b'\xe4\xb9\x99\xe8\xa1\x8c, \xe5\x88\xab""\xe5\x8f\xb7 "," \xe5\xb1\x95\r\xe4\xbc\x9a \xe6\xba\x90 "'
R2 = b'"",\xe5\xae\x98\xe7\xbd\x91'                                  # 明确的引号空名称
R3 = (b'" \xe8\xb7\xa8\xe8\xa1\x8c\xe5\xae\xa2\xe6\x88\xb7\n\xe7\x94\xb2\xe8\xa1\x8c\r\n'
      b'\xe4\xb9\x99\xe8\xa1\x8c, \xe5\x88\xab""\xe5\x8f\xb7 ",\xe6\x9d\xa5\xe6\xba\x90B')  # 与第 1 条同名
R4 = b"\xe6\xad\xa3\xe5\xb8\xb8\xe5\xae\xa2\xe6\x88\xb7,\xe5\xae\x98\xe7\xbd\x91"          # 无末尾换行

NAME_MULTILINE = "跨行客户\n甲行\n乙行, 别\"号"
SOURCE_MULTILINE = "展\n会 源"
NAME_NORMAL = "正常客户"
NAME_EXISTING = "原有客户"


def expect(label, cond, detail=""):
    print(("PASS" if cond else "FAIL"), label,
          "" if cond else (detail and ("\n      " + str(detail))))
    if not cond:
        expect.failed += 1
expect.failed = 0


def _drain(stream):
    for _ in stream:
        pass


def start_server(data_dir):
    proc = subprocess.Popen(
        [sys.executable, str(APP),
         "serve", "--host", "127.0.0.1", "--port", "0", "--data-dir", str(data_dir)],
        cwd=str(TMP), stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
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
            urllib.request.urlopen(base + "/health", timeout=2).read()
            break
        except OSError:
            time.sleep(0.1)
    return proc, base


def post_csv(base, content):
    req = urllib.request.Request(base + "/api/clients/import", data=content, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return resp.status, json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        return exc.code, json.loads(exc.read().decode("utf-8"))


def get_clients(base):
    with urllib.request.urlopen(base + "/api/clients", timeout=10) as resp:
        return json.loads(resp.read().decode("utf-8"))["clients"]


def build_scenario(separators):
    """按给定的五个记录分隔符拼出综合场景文件（记录 4 无末尾换行）。

    separators 依次为：表头后、记录 1 后、（完全空行之后）、记录 2 后、
    记录 3 后的分隔符；记录 1 与空行之间使用不同分隔符即可制造混合换行。
    """
    t_header, t_after_r1, t_after_blank, t_after_r2, t_after_r3 = separators
    return b"".join([
        b"name,source", t_header,
        R1, t_after_r1,
        b"", t_after_blank,          # 数据记录之间的完全空行
        R2, t_after_r2,
        R3, t_after_r3,
        R4,                          # 合法最后一条，没有末尾换行
    ])


def check_scenario(base, variant_label):
    """对同一资料的一种记录换行拼法执行完整断言。"""
    # 先登记一名已有客户，验证编号与资料在导入前后保持原样。
    seed = ("name,source\n%s,老来源\n" % NAME_EXISTING).encode("utf-8")
    code, report = post_csv(base, seed)
    expect("[%s] 前置已有客户登记成功" % variant_label,
           code == 200 and isinstance(report, dict)
           and report.get("imported_count") == 1, report)
    before = get_clients(base)
    expect("[%s] 前置列表恰有一名客户" % variant_label, len(before) == 1, before)
    existing = before[0] if before else None

    code, report = post_csv(base, build_scenario_variant[variant_label])
    expect("[%s] 综合场景 HTTP 200" % variant_label, code == 200, report)
    expect("[%s] 新增 2 / 未导入 2" % variant_label,
           report.get("imported_count") == 2 and report.get("failed_count") == 2, report)

    imported = report.get("imported") if isinstance(report, dict) else None
    failures = report.get("failures") if isinstance(report, dict) else None
    imported = imported if isinstance(imported, list) else []
    failures = failures if isinstance(failures, list) else []
    fail_by_row = {f.get("row"): f.get("reason", "") for f in failures
                   if isinstance(f, dict)}
    expect("[%s] 新增明细原文件编号为第 1、4 条" % variant_label,
           [(x.get("row"), x.get("name")) for x in imported
            if isinstance(x, dict)] ==
           [(1, NAME_MULTILINE), (4, NAME_NORMAL)], imported)
    expect("[%s] 失败定位第 2、3 条" % variant_label,
           sorted(fail_by_row) == [2, 3], failures)
    expect("[%s] 第 2 条报告缺少名称" % variant_label,
           "缺少名称" in fail_by_row.get(2, "") and "name" in fail_by_row.get(2, ""),
           fail_by_row.get(2))
    expect("[%s] 第 3 条说明与文件内第 1 条重复" % variant_label,
           fail_by_row.get(3) == "名称与文件内第 1 条记录重复",
           fail_by_row.get(3))

    # 列表只增加这两名客户；已有客户编号与资料保持原样。
    clients = get_clients(base)
    expect("[%s] 列表恰好增加两名客户" % variant_label, len(clients) == 3, clients)
    by_name = {c["name"]: c for c in clients}
    expect("[%s] 已有客户编号与资料不变" % variant_label,
           by_name.get(NAME_EXISTING) == existing, (by_name.get(NAME_EXISTING), existing))

    ml = by_name.get(NAME_MULTILINE)
    expect("[%s] 跨行客户完整名称落库（内部换行归一 LF、逗号引号保留、首尾空白去除）"
           % variant_label,
           ml is not None and ml["name"] == NAME_MULTILINE, ml)
    expect("[%s] 跨行来源落库（内部 CR 归一 LF、首尾空白去除、内部空白保留）"
           % variant_label,
           ml is not None and ml["source"] == SOURCE_MULTILINE, ml)
    expect("[%s] 跨行客户只保存一次（第 3 条未覆盖、未重复新增）" % variant_label,
           list(by_name).count(NAME_MULTILINE) == 1, list(by_name))
    expect("[%s] 第 3 条不同来源没有覆盖第 1 条资料" % variant_label,
           ml is not None and ml["source"] == SOURCE_MULTILINE
           and ml["source"] != "来源B", ml)
    norm = by_name.get(NAME_NORMAL)
    expect("[%s] 第 4 条客户正常保存" % variant_label,
           norm is not None and norm.get("source") == "官网"
           and (ml is None or norm["id"] != ml["id"]), norm)
    # 报告里的编号与列表实际编号一致。
    saved_ids = {x.get("row"): x.get("id") for x in imported if isinstance(x, dict)}
    expect("[%s] 新增明细编号与列表一致" % variant_label,
           ml is not None and norm is not None
           and saved_ids.get(1) == ml["id"] and saved_ids.get(4) == norm["id"],
           (saved_ids, ml, norm))
    return clients


# 同一份资料的四种记录换行拼法；前三种各自统一，第四种逐边界混用。
build_scenario_variant = {
    "LF":   build_scenario((LF, LF, LF, LF, LF)),
    "CRLF": build_scenario((CRLF, CRLF, CRLF, CRLF, CRLF)),
    "CR":   build_scenario((CR, CR, CR, CR, CR)),
    "mixed": build_scenario((CRLF, LF, CR, CRLF, LF)),
}


def check_damage(base, label, content, location_text):
    """结构损坏：400 + 可读原因 + 按数据记录位置说明 + 列表保持原样。"""
    before = get_clients(base)
    code, body = post_csv(base, content)
    expect("[%s] 结构损坏返回 400" % label, code == 400, body)
    err = body.get("error") if isinstance(body, dict) else None
    expect("[%s] 原因为非空中文可读文本" % label,
           isinstance(err, str) and bool(err.strip()) and "结构损坏" in err, err)
    expect("[%s] 原因按实际数据记录位置说明（%s）" % (label, location_text),
           isinstance(err, str) and location_text in err and "未闭合" in err, err)
    expect("[%s] 回复不含任何数量或逐条报告" % label,
           isinstance(body, dict) and not {"imported_count", "failed_count",
                                           "imported", "failures"} & set(body), body)
    after = get_clients(base)
    expect("[%s] 损坏前的合法新客户也没有新增，列表保持原样" % label, after == before,
           (before, after))


def main():
    procs = []
    variant_clients = {}
    try:
        # ===== 1. 同一资料四种记录换行：数量与编号完全一致 =====
        for variant in ("LF", "CRLF", "CR", "mixed"):
            data_dir = TMP / ("data-" + variant)
            proc, base = start_server(data_dir)
            procs.append((proc, data_dir))
            variant_clients[variant] = check_scenario(base, variant)

        # 四种换行下列表内容也必须逐字节一致。
        ref = variant_clients["LF"]
        for variant in ("CRLF", "CR", "mixed"):
            expect("换行一致性：%s 与 LF 的最终客户列表完全相同" % variant,
                   variant_clients[variant] == ref,
                   (variant_clients[variant], ref))

        # LF 版本重启后跨行内容仍完整（内部 LF 已真实落库）。
        proc_lf, dir_lf = next(p for p in procs if p[1].name == "data-LF")
        proc_lf.terminate(); proc_lf.wait(timeout=5)
        procs = [p for p in procs if p[0] is not proc_lf]
        proc, base = start_server(dir_lf)
        procs.append((proc, dir_lf))
        reopened = get_clients(base)
        expect("重启后跨行客户内容仍完整",
           {c["name"]: c.get("source") for c in reopened} ==
           {NAME_EXISTING: "老来源", NAME_MULTILINE: SOURCE_MULTILINE,
            NAME_NORMAL: "官网"}, reopened)

        # ===== 2. 空行、空格名、引号空名的编号规则（另起干净数据目录）=====
        proc, base = start_server(TMP / "data-extra")
        procs.append((proc, TMP / "data-extra"))

        # 表头之前、记录之间与文件末尾的完全空行都不计编号、不产生缺少名称失败。
        code, report = post_csv(base, b"\n\r\n" + b"name,source\n\n"
                                b"\xe7\x94\xb2,\xe5\xb1\x95\xe4\xbc\x9a\n\n"
                                b"\xe4\xb9\x99,\xe5\xae\x98\xe7\xbd\x91\n\n")
        expect("各处完全空行不计数据记录", code == 200
               and report["imported_count"] == 2 and report["failed_count"] == 0
               and [x["row"] for x in report["imported"]] == [1, 2], report)

        # 只有空格的名称仍是数据记录：第 1 条报缺少名称，空行不增编号，
        # 后一条有效客户编号继续为第 2 条。
        code, report = post_csv(
            base, "name,source\n   ,展会\n\n空格后客户,官网\n".encode("utf-8"))
        imp = report.get("imported") if isinstance(report, dict) else None
        fails = report.get("failures") if isinstance(report, dict) else None
        imp = imp if isinstance(imp, list) else []
        fails = fails if isinstance(fails, list) else []
        expect("纯空格名称算数据记录且后续继续编号", code == 200
               and report.get("imported_count") == 1 and report.get("failed_count") == 1
               and bool(fails) and fails[0].get("row") == 1
               and "缺少名称" in fails[0].get("reason", "")
               and bool(imp) and imp[0].get("row") == 2, report)

        # 一对双引号明确填写的空名称同样算数据记录。
        code, report = post_csv(
            base, 'name,source\n"",展会\n引号空名后客户,官网\n'.encode("utf-8"))
        imp = report.get("imported") if isinstance(report, dict) else None
        fails = report.get("failures") if isinstance(report, dict) else None
        imp = imp if isinstance(imp, list) else []
        fails = fails if isinstance(fails, list) else []
        expect("引号空名称算数据记录且后续继续编号", code == 200
               and report.get("imported_count") == 1 and report.get("failed_count") == 1
               and bool(fails) and fails[0].get("row") == 1
               and "缺少名称" in fails[0].get("reason", "")
               and bool(imp) and imp[0].get("row") == 2, report)

        # 没有末尾换行的合法最后一条正常参与导入。
        code, report = post_csv(base, "name\n无换行结尾客户".encode("utf-8"))
        expect("无末尾换行的最后一条正常导入", code == 200
               and report["imported_count"] == 1
               and report["imported"][0]["row"] == 1, report)

        # 跨行字段内多种换行归一：内部 CRLF/CR → LF，续行前导空白等内部空白保留，
        # 逗号、转义双引号保留，仅字段首尾空白去除。
        tricky = ('name,source\n" 甲, ""x"" \n 乙 "," s\r t "\n普通2,v\n').encode("utf-8")
        code, report = post_csv(base, tricky)
        expect("跨行转义字段导入 2 条", code == 200
               and [x["row"] for x in report["imported"]] == [1, 2], report)
        clients = {c["name"]: c for c in get_clients(base)}
        tricky_c = clients.get('甲, "x" \n 乙')
        expect("字段内部换行/逗号/引号/空白按规则保留并归一",
               tricky_c is not None and tricky_c["source"] == "s\n t", tricky_c)

        # ===== 3. 整份拒绝时编号含义不变：损坏位置按数据记录编号说明 =====
        # 先放一名已有客户；随后文件中第一条是合法跨行新客户、夹完全空行，
        # 第二条数据记录引号未闭合——必须 400、指到第 2 条，且合法新客户不落库。
        post_csv(base, "name,source\n损坏对照客户,对照来源\n".encode("utf-8"))
        damage_common = b'"\xe7\x94\xb2\n\xe4\xb9\x99",\xe5\xb1\x95\xe4\xbc\x9a'  # 合法跨行记录
        check_damage(base, "LF",
                     b"name,source\n" + damage_common + b"\n\n" + b'"\xe5\x9d\x8f',
                     "第 2 条数据记录")
        check_damage(base, "CRLF",
                     b"name,source\r\n" + damage_common.replace(b"\n", b"\r\n")
                     + b"\r\n\r\n" + b'"\xe5\x9d\x8f',
                     "第 2 条数据记录")
        check_damage(base, "CR",
                     b"name,source\r" + damage_common.replace(b"\n", b"\r")
                     + b"\r\r" + b'"\xe5\x9d\x8f',
                     "第 2 条数据记录")
        # 表头之前的空行不计编号：第一条数据记录即损坏时指到第 1 条。
        check_damage(base, "表头前空行",
                     b"\n\r\nname,source\n" + b'"\xe5\x9d\x8f',
                     "第 1 条数据记录")
    finally:
        for proc, _dir in procs:
            proc.terminate()
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()
        shutil.rmtree(TMP, ignore_errors=True)

    print(f"\n{'='*40}\n{'全部通过' if expect.failed == 0 else f'{expect.failed} 项失败'}")
    return 1 if expect.failed else 0


if __name__ == "__main__":
    sys.exit(main())

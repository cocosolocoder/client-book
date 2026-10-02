#!/usr/bin/env python3
"""端到端冒烟测试：启动真实 HTTP 服务，覆盖需求各场景。"""
import json
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request
import urllib.error
from pathlib import Path

BASE = None
TMP = Path(tempfile.mkdtemp(prefix="clientbook-test-"))


def req(method, path, body=None, raw=False):
    data = body if raw else (body.encode("utf-8") if isinstance(body, str) else None)
    r = urllib.request.Request(BASE + path, data=data, method=method)
    try:
        with urllib.request.urlopen(r) as resp:
            return resp.status, json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode("utf-8"))


def import_csv(content, *, bom=False):
    data = content.encode("utf-8")
    if bom:
        data = b"\xef\xbb\xbf" + data
    r = urllib.request.Request(BASE + "/api/clients/import", data=data, method="POST")
    try:
        with urllib.request.urlopen(r) as resp:
            return resp.status, json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode("utf-8"))


def expect(label, cond, detail=""):
    print(("PASS" if cond else "FAIL"), label, detail)
    if not cond:
        expect.failed += 1
expect.failed = 0


def main():
    port = 0
    data_dir = TMP / "data"
    proc = subprocess.Popen(
        [sys.executable, str(Path(__file__).parent / "app.py"),
         "serve", "--host", "127.0.0.1", "--port", "0", "--data-dir", str(data_dir)],
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    global BASE
    BASE = None
    import re as _re
    deadline = time.time() + 5
    while time.time() < deadline:
        line = proc.stdout.readline()
        if not line:
            if proc.poll() is not None:
                print("服务启动失败：", proc.stdout.read())
                return 1
            time.sleep(0.05)
            continue
        m = _re.search(r"http://127\.0\.0\.1:(\d+)", line)
        if m:
            BASE = f"http://127.0.0.1:{m.group(1)}"
            break
    if BASE is None:
        print("未能解析服务端口")
        return 1
    try:
        for _ in range(50):
            try:
                req("GET", "/health")
                break
            except OSError:
                time.sleep(0.1)
        else:
            print(proc.stdout.read())
            return 1

        # 1. 健康检查与初始空列表
        s, d = req("GET", "/health")
        expect("health 200", s == 200 and d == {"status": "ok", "product": "ClientBook"}, d)
        s, d = req("GET", "/api/clients")
        expect("初始列表为空且外层结构保持", s == 200 and d == {"clients": []}, d)

        # 2. 基本导入：BOM、表头乱序、省略可选列
        s, d = import_csv(
            "important_date,name,region\r\n2024-02-29, 甲公司 , 华东 \r\n,乙公司,华北\n",
            bom=True)
        expect("基本导入 200/2 新增", s == 200 and d["imported_count"] == 2 and d["failed_count"] == 0, d)
        expect("稳定 id 返回", [x["id"] for x in d["imported"]] and d["imported"][0]["row"] == 1, d)

        # 3. 列表含新字段，空白已去除，缺列字段为 null
        s, d = req("GET", "/api/clients")
        first = d["clients"][0]
        expect("列表新字段齐全", set(first) == {"id", "name", "source", "region", "industry", "important_date"}, first)
        expect("名称去空白", first["name"] == "甲公司", first)
        expect("闰年日期接受", first["important_date"] == "2024-02-29", first)
        expect("省略列为 null", first["source"] is None and first["industry"] is None, first)
        expect("空日期为 null", d["clients"][1]["important_date"] is None, d["clients"][1])

        # 4. 逐行错误：列数不符/缺名称/坏日期，有效记录仍新增
        s, d = import_csv(
            'name,source,important_date\n'
            '丙公司,展会,2025-01-01\n'          # 成功（编号3）
            '丁公司,官网,2025-13-40\n'          # 坏日期
            ' ,广告,2025-01-01\n'               # 缺名称
            '戊公司,电话,2025/01/01\n'           # 格式错
            '己公司,邮件,\n'                    # 成功（日期为空）
            '庚公司,门店,2023-02-29,extra\n'     # 多一列
        )
        expect("部分成功 200", s == 200, d)
        expect("2 新增 4 失败", d["imported_count"] == 2 and d["failed_count"] == 4, d)
        rows = {f["row"]: f["reason"] for f in d["failures"]}
        expect("失败编号=数据记录行号", sorted(rows) == [2, 3, 4, 6], rows)
        expect("坏日期原因具体", "2025-13-40" in rows[2] and "日历" in rows[2], rows.get(2))
        expect("缺名称原因具体", "name" in rows[3], rows.get(3))
        expect("日期格式错原因具体", "2025/01/01" in rows[4] and "YYYY-MM-DD" in rows[4], rows.get(4))
        expect("列数不符原因具体", "列数不符" in rows[6] and "4" in rows[6], rows.get(6))

        # 5. 与已有客户重复（去空白、英文不区分大小写）
        s, d = import_csv("name\n 甲公司 \n  乙公司\n")
        expect("已有重复 0 新增", s == 200 and d["imported_count"] == 0 and d["failed_count"] == 2, d)
        expect("报告已有客户编号", "已有客户编号 1" in d["failures"][0]["reason"], d["failures"][0])

        # 6. 文件内重复：先到先得，报告与哪条重复；字段不同不覆盖
        s, d = import_csv(
            'name,source,region\n'
            'Acme Ltd,展会,华南\n'      # 新增
            '丙公司,x,y\n'             # 与已有（编号3）重复
            'ACME ltd,官网,华北\n'     # 与文件内第1条重复，不覆盖
            '辛公司,,西南\n'           # 新增
        )
        expect("文件内去重 2 新增", d["imported_count"] == 2 and d["failed_count"] == 2, d)
        expect("已有重复指向客户编号", "已有客户编号 3" in d["failures"][0]["reason"], d["failures"])
        expect("报告文件内重复指向第1条", "第 1 条" in d["failures"][1]["reason"], d["failures"])
        s, clients = req("GET", "/api/clients")
        acme = [c for c in clients["clients"] if c["name"] == "Acme Ltd"][0]
        expect("重复不覆盖已保存信息", acme["source"] == "展会" and acme["region"] == "华南", acme)

        # 7. 前面记录字段错误不阻止后面同名有效记录
        s, d = import_csv(
            'name,important_date\n'
            '壬公司,not-a-date\n'   # 失败
            '壬公司,2025-05-05\n'   # 同名但前面未导入 → 成功
        )
        expect("前错不阻挡后同名", d["imported_count"] == 1 and d["failures"][0]["row"] == 1, d)

        # 7b. 英文大小写不敏感的已有客户重复
        acme_id = [c["id"] for c in req("GET", "/api/clients")[1]["clients"] if c["name"] == "Acme Ltd"][0]
        s, d = import_csv("name\nacme ltd\n")
        expect("英文大小写不敏感重复", d["imported_count"] == 0 and
               ("已有客户编号 %d" % acme_id) in d["failures"][0]["reason"], d)

        # 8. 引号、字段内逗号与换行
        s, d = import_csv(
            'name,source,industry\n'
            '"史密斯, 有限公司","线上\n渠道","制造""业"\n'
            '普通公司,线下,零售\n'
        )
        expect("引号字段导入", d["imported_count"] == 2 and d["failed_count"] == 0, d)
        s, clients = req("GET", "/api/clients")
        smith = [c for c in clients["clients"] if c["name"].startswith("史密斯")][0]
        expect("字段内逗号保留", smith["name"] == "史密斯, 有限公司", smith)
        expect("字段内换行保留", smith["source"] == "线上\n渠道", smith)
        expect("双引号转义", smith["industry"] == '制造"业', smith)
        expect("记录编号不因换行错位", d["imported"][1]["row"] == 2, d["imported"])

        # 9. 文件级错误 → 400，列表不变
        before = req("GET", "/api/clients")[1]
        cases = {
            "缺 name 列": "source,region\n展会,华东\n",
            "表头重复": "name,name,source\n甲,乙,展\n",
            "未知列": "name,unknown_col\n甲\n",
            "编码错误": None,
            "结构损坏-未闭合引号": 'name,source\n"甲,展会\n',
            "空文件": "",
        }
        raw_bad = {"编码错误": b"\xff\xfe name,\x00"}
        for label, content in cases.items():
            if content is None:
                r = urllib.request.Request(BASE + "/api/clients/import",
                                           data=raw_bad[label], method="POST")
                try:
                    with urllib.request.urlopen(r) as resp:
                        code, body = resp.status, json.loads(resp.read())
                except urllib.error.HTTPError as e:
                    code, body = e.code, json.loads(e.read())
            else:
                code, body = import_csv(content)
            expect(f"文件级 400：{label}", code == 400 and "error" in body, body)
        after = req("GET", "/api/clients")[1]
        expect("拒绝后列表保持原样", after == before)

        # 10. 仅合法表头 → 0 新增 200
        s, d = import_csv("name,source,region,industry,important_date\n")
        expect("空数据零新增", s == 200 and d["imported_count"] == 0 and d["failed_count"] == 0, d)

        # 11. 错误行为兼容
        s, d = req("GET", "/nope")
        expect("未知路径 404", s == 404 and d == {"error": "not found"}, d)
        s, d = req("DELETE", "/api/clients")
        expect("旧路径 405 且 Allow GET", s == 405, d)
        s, d = req("GET", "/api/clients/import")
        expect("import 用 GET → 405", s == 405, d)
        s, d = req("POST", "/health")
        expect("health POST → 405", s == 405, d)

        # 12. 空列表提示 & 首页含上传表单
        with urllib.request.urlopen(BASE + "/") as resp:
            page = resp.read().decode("utf-8")
        expect("首页含文件选择与提交", 'type="file"' in page and "/api/clients/import" in page)
        expect("首页保留空列表提示文案", "还没有客户记录" in page)

        print("\n重启服务验证持久化…")
    finally:
        proc.terminate()
        proc.wait(timeout=5)

    # 重启
    proc = subprocess.Popen(
        [sys.executable, str(Path(__file__).parent / "app.py"),
         "serve", "--host", "127.0.0.1", "--port", "0", "--data-dir", str(data_dir)],
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    try:
        import re as _re
        for _ in range(100):
            line = proc.stdout.readline()
            m = _re.search(r"http://127\.0\.0\.1:(\d+)", line or "")
            if m:
                BASE = f"http://127.0.0.1:{m.group(1)}"
                break
        for _ in range(50):
            try:
                _, d = req("GET", "/health")
                break
            except OSError:
                time.sleep(0.1)
        _, d = req("GET", "/api/clients")
        names = [c["name"] for c in d["clients"]]
        expect("重启后数据仍在", len(names) == 9, names)
        expect("重启后新字段仍在", d["clients"][0]["region"] == "华东", d["clients"][0])
    finally:
        proc.terminate()
        proc.wait(timeout=5)
        shutil.rmtree(TMP, ignore_errors=True)

    print(f"\n{'='*40}\n{'全部通过' if expect.failed == 0 else f'{expect.failed} 项失败'}")
    return 1 if expect.failed else 0


if __name__ == "__main__":
    sys.exit(main())

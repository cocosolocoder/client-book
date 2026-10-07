#!/usr/bin/env python3
"""端到端冒烟测试：启动真实 HTTP 服务，覆盖需求各场景。"""
import json
import shutil
import subprocess
import sys
import tempfile
import threading
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


def _drain(stream):
    """持续读空服务进程的 stdout/stderr 管道。

    服务对每个请求都会写一行日志；启动之后若无人读取，管道写满（本环境仅
    8 KiB）会让服务阻塞在写日志上，表现为测试无故卡死。
    """
    for _ in stream:
        pass


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
    threading.Thread(target=_drain, args=(proc.stdout,), daemon=True).start()
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

        # 9b. 引号结构损坏：未加引号字段含引号 / 结束引号后多余字符 / 引号未闭合
        # 均为整份拒绝（400），不保存任何记录；错误信息区分类型并指出表头或第 N 条数据记录
        quote_cases = [
            ("表头-未加引号字段含引号", '甲"乙,source\n', "未加引号", "表头"),
            ("数据记录-未加引号字段含引号", 'name,source\n甲,展会\n乙"丙,官网\n', "未加引号", "第 2 条"),
            ("表头-结束引号后多余字符", '"甲公司"x,source\n', "结束引号", "表头"),
            ("数据记录-结束引号后多余字符", 'name,source\n"甲"x,展会\n', "结束引号", "第 1 条"),
            ("结束引号后空格", 'name,source\n"甲" ,展会\n', "结束引号", "第 1 条"),
            ("引号未闭合", 'name,source\n"甲,展会\n', "未闭合", "第 1 条"),
            ("无行尾换行-引号未闭合", 'name,source\n"甲,展会', "未闭合", "第 1 条"),
        ]
        for label, content, kind, loc in quote_cases:
            code, body = import_csv(content)
            expect("引号结构损坏 400：" + label, code == 400 and "error" in body, body)
            expect("错误类型具体：" + label, kind in body["error"], body["error"])
            expect("错误位置具体：" + label, loc in body["error"], body["error"])
        # 即使前面已有合法记录，结构损坏也整份拒绝，不保存任何记录
        before = req("GET", "/api/clients")[1]
        code, body = import_csv('name,source\n甲,展会\n乙"丙,官网\n')
        expect("结构损坏整份拒绝 400", code == 400 and "error" in body, body)
        after = req("GET", "/api/clients")[1]
        expect("结构损坏不保存任何记录", after == before)
        # 引号字段内的换行不增加数据记录编号
        code, body = import_csv('name,source\n"甲\n乙",展会\n丙"丁,官网\n')
        expect("引号内换行不增记录编号", code == 400 and "第 2 条" in body["error"], body)
        # 合法用例仍正常：末尾空字段、引号空字段、无行尾换行、表头加引号
        code, body = import_csv('name,source\n子,\n')
        expect("末尾空字段不丢失", code == 200 and body["imported_count"] == 1, body)
        code, body = import_csv('name,source\n丑,""\n')
        expect("引号空字段按空值处理", code == 200 and body["imported_count"] == 1, body)
        code, body = import_csv('name,source\n寅,展会')
        expect("无行尾换行可导入", code == 200 and body["imported_count"] == 1, body)
        code, body = import_csv('"name","source"\n卯,展会\n')
        expect("表头加引号合法", code == 200 and body["imported_count"] == 1, body)
        s, clients = req("GET", "/api/clients")
        zi = [c for c in clients["clients"] if c["name"] == "子"][0]
        chou = [c for c in clients["clients"] if c["name"] == "丑"][0]
        expect("末尾空字段按空值", zi["source"] is None, zi)
        expect("引号空字段按空值", chou["source"] is None, chou)

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
        threading.Thread(target=_drain, args=(proc.stdout,), daemon=True).start()
        for _ in range(50):
            try:
                _, d = req("GET", "/health")
                break
            except OSError:
                time.sleep(0.1)
        _, d = req("GET", "/api/clients")
        names = [c["name"] for c in d["clients"]]
        expect("重启后数据仍在", len(names) == 13, names)
        expect("重启后新字段仍在", d["clients"][0]["region"] == "华东", d["clients"][0])

        # ===== 批量修改 =====
        def batch_update(ids, updates):
            body = json.dumps({"ids": ids, "updates": updates}).encode("utf-8")
            r = urllib.request.Request(BASE + "/api/clients/batch-update", data=body,
                                       method="POST",
                                       headers={"Content-Type": "application/json"})
            try:
                with urllib.request.urlopen(r) as resp:
                    return resp.status, json.loads(resp.read().decode("utf-8"))
            except urllib.error.HTTPError as e:
                return e.code, json.loads(e.read().decode("utf-8"))

        def client_by_id(cid):
            return [c for c in req("GET", "/api/clients")[1]["clients"] if c["id"] == cid][0]

        # 13. 准备三名资料互不相同的客户
        s, d = import_csv(
            "name,source,region,industry,important_date\n"
            "批测甲,老客户推荐,华东,制造业,2020-01-15\n"
            "批测乙,展会,华南,零售业,2021-06-30\n"
            "批测丙,广告,华北,互联网,2022-12-01\n"
        )
        expect("批测客户导入 3 新增", s == 200 and d["imported_count"] == 3, d)
        id_a, id_b, id_c = (x["id"] for x in d["imported"])
        before_a = client_by_id(id_a)
        before_b = client_by_id(id_b)
        before_c = client_by_id(id_c)
        expect("批测客户资料互不相同",
               before_a["source"] != before_b["source"]
               and before_a["region"] != before_b["region"]
               and before_a["important_date"] != before_b["important_date"],
               (before_a, before_b))

        # 14. 只修改选中的两名：来源去前后空白（内部空白与换行保留）、行业清空、
        #     地区与重要日期保持原值；未选中客户完全不变
        new_source = "  新来源 含内部 空白\n第二行\t保留  "
        s, d = batch_update([id_a, id_b], {
            "source": {"op": "set", "value": new_source},
            "industry": {"op": "clear"},
            "region": {"op": "keep"},
            "important_date": {"op": "keep"},
        })
        expect("批量修改 200 且处理 2 名", s == 200 and d == {"updated_count": 2}, (s, d))
        after_a = client_by_id(id_a)
        after_b = client_by_id(id_b)
        expect("来源去除前后空白", after_a["source"] == "新来源 含内部 空白\n第二行\t保留"
               and after_b["source"] == after_a["source"], (after_a, after_b))
        expect("来源内部空白与换行保留", "\n第二行" in after_a["source"]
               and "含内部 空白" in after_a["source"], after_a["source"])
        expect("行业清空为 null", after_a["industry"] is None and after_b["industry"] is None,
               (after_a, after_b))
        expect("地区各自保持原值", after_a["region"] == "华东" and after_b["region"] == "华南",
               (after_a, after_b))
        expect("日期各自保持原值", after_a["important_date"] == "2020-01-15"
               and after_b["important_date"] == "2021-06-30", (after_a, after_b))
        expect("编号与名称不变", after_a["id"] == id_a and after_a["name"] == "批测甲"
               and after_b["id"] == id_b and after_b["name"] == "批测乙", (after_a, after_b))
        expect("未选中客户完全不变", client_by_id(id_c) == before_c, client_by_id(id_c))

        # 15. 重复编号只算一名；原值已等于设置值的客户仍计入；
        #     保持原值的字段省略修改说明后非空值不丢失
        s, d = batch_update([id_a, id_a, id_b, id_a],
                            {"source": {"op": "set", "value": "新来源 含内部 空白\n第二行\t保留"}})
        expect("重复编号去重计数", s == 200 and d == {"updated_count": 2}, (s, d))
        after_a = client_by_id(id_a)
        expect("省略修改说明的字段不丢值", after_a["region"] == "华东"
               and after_a["important_date"] == "2020-01-15", after_a)
        expect("省略后行业仍为 null", after_a["industry"] is None, after_a)
        expect("重复提交未选中客户仍不变", client_by_id(id_c) == before_c, client_by_id(id_c))

        # 16. 闰年日期合法，列表按 YYYY-MM-DD 返回
        s, d = batch_update([id_a], {"important_date": {"op": "set", "value": "2024-02-29"}})
        expect("闰年日期接受", s == 200 and d == {"updated_count": 1}, (s, d))
        expect("日期按 YYYY-MM-DD 返回", client_by_id(id_a)["important_date"] == "2024-02-29",
               client_by_id(id_a))

        # 17. 拒绝：日期无效（2023-02-29）→ 400，整次不生效
        snapshot = req("GET", "/api/clients")[1]
        s, d = batch_update([id_a, id_b], {
            "source": {"op": "set", "value": "不应保存的来源"},
            "industry": {"op": "clear"},
            "important_date": {"op": "set", "value": "2023-02-29"},
        })
        expect("无效日期 400", s == 400 and "error" in d and "updated_count" not in d, (s, d))
        expect("无效日期原因具体", "2023-02-29" in d["error"] and "日历" in d["error"], d)
        expect("无效日期整次不生效", req("GET", "/api/clients")[1] == snapshot)

        # 18. 拒绝：选中编号混有不存在的客户 → 400，整次不生效
        ghost = max(c["id"] for c in snapshot["clients"]) + 1000
        s, d = batch_update([id_a, id_b, ghost], {
            "source": {"op": "set", "value": "不应保存的来源"},
            "industry": {"op": "clear"},
        })
        expect("不存在编号 400", s == 400 and "error" in d and "updated_count" not in d, (s, d))
        expect("不存在编号原因具体", str(ghost) in d["error"], d)
        expect("不存在编号整次不生效", req("GET", "/api/clients")[1] == snapshot)
        expect("拒绝后未选中客户仍不变", client_by_id(id_c) == before_c, client_by_id(id_c))

        # ===== 字段「最终操作选择」回归 =====
        # 保存时只以各字段最后选定的 keep/set/clear 为准；输入残留、禁用状态或留空
        # 都不能自行替代这个选择。
        # 19. 准备三名资料互不相同的客户，其中丙的行业导入时即为空（用于验证空值
        #     不会从其他选中客户补入内容）
        s, d = import_csv(
            "name,source,region,industry,important_date\n"
            "选甲,s1,r1,i1,2020-03-03\n"
            "选乙,s2,r2,i2,2021-04-04\n"
            "选丙,s3,r3,,2022-05-05\n"
        )
        expect("最终操作回归客户导入 3 新增", s == 200 and d["imported_count"] == 3, d)
        id_x, id_y, id_z = (x["id"] for x in d["imported"])
        expect("选丙行业初始为空", client_by_id(id_z)["industry"] is None, client_by_id(id_z))

        # 20. 先「设为填写的值」再改成「保持原值」：最终 keep 时修改说明里残留的
        #     设置文本既不写入，也不会因输入框已不可填写而清空；重要日期残留的是
        #     无效日期（2023-02-29）也不校验、不报错，不妨碍同次地区的有效修改。
        #     两名客户各自保留自己的原值，不能被写成同一个残留值。
        s, d = batch_update([id_x, id_y], {
            "source": {"op": "keep", "value": "残留文字不应写入"},
            "region": {"op": "set", "value": "  共同地区  "},
            "industry": {"op": "keep", "value": "残留行业"},
            "important_date": {"op": "keep", "value": "2023-02-29"},
        })
        expect("最终 keep+另一字段 set：200 处理 2 名",
               s == 200 and d == {"updated_count": 2}, (s, d))
        x_now, y_now, z_now = client_by_id(id_x), client_by_id(id_y), client_by_id(id_z)
        expect("keep 忽略残留文本：来源仍是各自原值",
               x_now["source"] == "s1" and y_now["source"] == "s2", (x_now, y_now))
        expect("keep 不因输入不可填写而清空：行业仍是各自原值",
               x_now["industry"] == "i1" and y_now["industry"] == "i2", (x_now, y_now))
        expect("keep 不校验残留无效日期：各自日期保留",
               x_now["important_date"] == "2020-03-03"
               and y_now["important_date"] == "2021-04-04", (x_now, y_now))
        expect("另一字段按其最后操作保存（去前后空白、两人相同）",
               x_now["region"] == "共同地区" and y_now["region"] == "共同地区",
               (x_now, y_now))
        expect("keep 残留不波及未选中客户",
               z_now["source"] == "s3" and z_now["region"] == "r3", z_now)

        # 21. 最终选择「清空」：即使修改说明里带着之前留下的文字或无效日期，
        #     保存后也一律为未填写（null），不再校验那些残留内容。
        s, d = batch_update([id_x, id_y], {
            "source": {"op": "clear", "value": "残留文字"},
            "important_date": {"op": "clear", "value": "2023-02-29"},
        })
        expect("最终 clear：200 处理 2 名", s == 200 and d == {"updated_count": 2}, (s, d))
        x_now, y_now = client_by_id(id_x), client_by_id(id_y)
        expect("clear 忽略残留文字：来源为 null",
               x_now["source"] is None and y_now["source"] is None, (x_now, y_now))
        expect("clear 忽略残留无效日期：日期为 null 且不报日期错误",
               x_now["important_date"] is None and y_now["important_date"] is None,
               (x_now, y_now))

        # 22. 最终选择「设为填写的值」但只填空白：空串、空格、制表符、换行对四个
        #     字段都按清空处理；重要日期仅填空白同样清空，不能报日期格式错误。
        s, d = batch_update([id_x], {
            "source": {"op": "set", "value": "临时来源"},
            "region": {"op": "set", "value": "临时地区"},
            "industry": {"op": "set", "value": "临时行业"},
            "important_date": {"op": "set", "value": "2025-06-06"},
        })
        expect("空白 set 前置：先写非空值 200",
               s == 200 and d == {"updated_count": 1}, (s, d))
        s, d = batch_update([id_x], {
            "source": {"op": "set", "value": ""},
            "region": {"op": "set", "value": " \t \n "},
            "industry": {"op": "set", "value": "   "},
            "important_date": {"op": "set", "value": "  \n\t "},
        })
        expect("四字段空串/纯空白 set 200（不是 400 日期错误）",
               s == 200 and d == {"updated_count": 1}, (s, d))
        x_now = client_by_id(id_x)
        expect("空串与纯空白全部落库为 null（含重要日期）",
               x_now["source"] is None and x_now["region"] is None
               and x_now["industry"] is None and x_now["important_date"] is None,
               x_now)

        # 23. 来源/地区/行业仅填空白与明确选择清空得到相同结果（null）。
        s, d = batch_update([id_y], {"region": {"op": "set", "value": "\t\t "}})
        expect("地区仅填空白 200", s == 200 and d == {"updated_count": 1}, (s, d))
        s, d = batch_update([id_y], {"industry": {"op": "clear"}})
        expect("行业明确清空 200", s == 200 and d == {"updated_count": 1}, (s, d))
        y_now = client_by_id(id_y)
        expect("纯空白 set 与 clear 结果一致（均为 null）",
               y_now["region"] is None and y_now["industry"] is None, y_now)

        # 24. 非空 set：只去除前后空白，内部空格、制表与换行按原规则保留。
        s, d = batch_update([id_y], {
            "source": {"op": "set", "value": "  来 源\tA  "},
            "industry": {"op": "set", "value": "行 业\n第二行\t保留"},
        })
        expect("非空 set 200", s == 200 and d == {"updated_count": 1}, (s, d))
        y_now = client_by_id(id_y)
        expect("仅去前后空白、内部空白与换行保留",
               y_now["source"] == "来 源\tA"
               and y_now["industry"] == "行 业\n第二行\t保留", y_now)

        # 25. 选中客户中某字段原本为空：set 其他字段不会从其他客户补值，keep 仍为空。
        s, d = batch_update([id_y, id_z], {
            "source": {"op": "set", "value": "批量来源"},
            "industry": {"op": "keep"},
        })
        expect("含空值字段的批量 set：200 处理 2 名",
               s == 200 and d == {"updated_count": 2}, (s, d))
        z_now = client_by_id(id_z)
        expect("原本为空的行业不被补入他人内容", z_now["industry"] is None, z_now)
        expect("两人来源同为设置值，丙其余字段不变",
               client_by_id(id_y)["source"] == "批量来源"
               and z_now["source"] == "批量来源"
               and z_now["region"] == "r3"
               and z_now["important_date"] == "2022-05-05",
               (client_by_id(id_y), z_now))

        # 26. 拒绝：四个字段最终全部保持原值——即使修改说明里带着残留文字或无效
        #     日期，也应拒绝并说明没有修改项，任何客户都不改变。
        keep_snapshot = req("GET", "/api/clients")[1]
        s, d = batch_update([id_x, id_y, id_z], {
            "source": {"op": "keep", "value": "残留"},
            "region": {"op": "keep"},
            "industry": {"op": "keep", "value": "残留行业"},
            "important_date": {"op": "keep", "value": "2023-02-29"},
        })
        expect("四字段全部 keep：400 拒绝",
               s == 400 and "error" in d and "updated_count" not in d, (s, d))
        expect("全部 keep 拒绝原因说明没有修改项",
               "保持原值" in d["error"] and "清空" in d["error"], d)
        expect("全部 keep 整次不写入", req("GET", "/api/clients")[1] == keep_snapshot)

        # 27. 拒绝：重要日期最终选择设置且填写无效日期——整次修改拒绝，其他字段
        #     不能先保存（原子性）。仅含空白的日期在第 22 步已按清空成功处理，与此区分。
        bad_date_snapshot = req("GET", "/api/clients")[1]
        s, d = batch_update([id_y, id_z], {
            "source": {"op": "set", "value": "不应部分写入的来源"},
            "industry": {"op": "clear"},
            "important_date": {"op": "set", "value": "2023-13-01"},
        })
        expect("日期为不存在的日历日期：400", s == 400 and "error" in d, (s, d))
        expect("无效日期原因含该值与日历日期说明",
               "2023-13-01" in d["error"] and "日历" in d["error"], d)
        expect("无效日期：来源/行业未被先保存",
               req("GET", "/api/clients")[1] == bad_date_snapshot)
        s, d = batch_update([id_y], {
            "region": {"op": "set", "value": "不应写入"},
            "important_date": {"op": "set", "value": "2023/02/29"},
        })
        expect("日期格式错误：400 且提示 YYYY-MM-DD",
               s == 400 and "YYYY-MM-DD" in d["error"], d)
        expect("日期格式错误同样整次不写入",
               req("GET", "/api/clients")[1] == bad_date_snapshot)

        # ===== 拒绝规则回归：不能修改的字段与非文本设置值 =====
        # 28. 准备四名客户：甲/乙资料互不相同，丙四个可修改字段原本均未填写，
        #     丁不参与批量修改（未选中对照）。
        s, d = import_csv(
            "name,source,region,industry,important_date\n"
            "拒测甲,口碑,东北,能源,2019-01-01\n"
            "拒测乙,官网,西北,教育,2018-02-02\n"
            "拒测丙,,,,\n"
            "拒测丁,门店,西南,餐饮,2017-03-03\n"
        )
        expect("拒绝回归客户导入 4 新增", s == 200 and d["imported_count"] == 4, d)
        id_p, id_q, id_r, id_u = (x["id"] for x in d["imported"])
        expect("拒测丙四字段原本为空",
               all(client_by_id(id_r)[f] is None for f in
                   ("source", "region", "industry", "important_date")),
               client_by_id(id_r))
        reject_snapshot = req("GET", "/api/clients")[1]
        client_total = len(reject_snapshot["clients"])
        before_u = client_by_id(id_u)

        # 29. 拒绝：updates 混入 name/id/不存在的字段——无论非法项排在合法项
        #     之前还是之后、即使非法项选择 keep，都整次拒绝（HTTP 400、error 为
        #     非空文本且指出哪个字段不能修改、不含 updated_count、不表示部分成功），
        #     选中客户的合法字段也不能先保存。
        legal_updates = {
            "source": {"op": "set", "value": "回归来源"},
            "industry": {"op": "clear"},
        }
        illegal_field_cases = [
            ("name 设为值", {"name": {"op": "set", "value": "新名字"}}, "name"),
            ("id 设为值", {"id": {"op": "set", "value": 1}}, "id"),
            ("不存在的字段", {"no_such_field": {"op": "set", "value": "x"}}, "no_such_field"),
            ("name 选择 keep", {"name": {"op": "keep"}}, "name"),
        ]
        for case_label, illegal, key in illegal_field_cases:
            for order_label, updates in (
                ("非法项在后", {**legal_updates, **illegal}),
                ("非法项在前", {**illegal, **legal_updates}),
            ):
                label = "%s（%s）" % (case_label, order_label)
                s, d = batch_update([id_p, id_q, id_r], updates)
                expect("不能修改的字段 400：" + label,
                       s == 400 and "updated_count" not in d, (s, d))
                expect("拒绝原因可读且指出字段：" + label,
                       isinstance(d.get("error"), str) and bool(d["error"].strip())
                       and key in d["error"], d)
                expect("整次拒绝不写入任何客户：" + label,
                       req("GET", "/api/clients")[1] == reject_snapshot)

        # 拒绝后逐客户核对：编号、名称与四个可修改字段分别保持原值，
        # 原本为空的仍为空；未选中客户与客户总数不受影响。
        expect("拒测甲全部字段保持原值",
               client_by_id(id_p) == {"id": id_p, "name": "拒测甲", "source": "口碑",
                                      "region": "东北", "industry": "能源",
                                      "important_date": "2019-01-01"}, client_by_id(id_p))
        expect("拒测乙全部字段保持原值",
               client_by_id(id_q) == {"id": id_q, "name": "拒测乙", "source": "官网",
                                      "region": "西北", "industry": "教育",
                                      "important_date": "2018-02-02"}, client_by_id(id_q))
        expect("拒测丙原本为空的字段仍为空",
               client_by_id(id_r) == {"id": id_r, "name": "拒测丙", "source": None,
                                      "region": None, "industry": None,
                                      "important_date": None}, client_by_id(id_r))
        expect("未选中客户不受影响", client_by_id(id_u) == before_u, client_by_id(id_u))
        expect("客户数量不变",
               len(req("GET", "/api/clients")[1]["clients"]) == client_total)

        # 只修正掉不合法修改项后，同样的合法修改按现有规则成功：
        # 只改变选中客户明确设置/清空的字段，省略的字段各自保留原值。
        s, d = batch_update([id_p, id_q, id_r], legal_updates)
        expect("修正后合法修改 200 处理 3 名", s == 200 and d == {"updated_count": 3}, (s, d))
        p_now, q_now, r_now = (client_by_id(i) for i in (id_p, id_q, id_r))
        expect("设置的来源写入全部选中客户",
               p_now["source"] == "回归来源" and q_now["source"] == "回归来源"
               and r_now["source"] == "回归来源", (p_now, q_now, r_now))
        expect("清空的行业为 null",
               p_now["industry"] is None and q_now["industry"] is None
               and r_now["industry"] is None, (p_now, q_now, r_now))
        expect("省略的地区与日期各自保留",
               p_now["region"] == "东北" and q_now["region"] == "西北"
               and r_now["region"] is None
               and p_now["important_date"] == "2019-01-01"
               and q_now["important_date"] == "2018-02-02"
               and r_now["important_date"] is None, (p_now, q_now, r_now))
        expect("编号名称不变、未选中客户仍不变",
               p_now["id"] == id_p and p_now["name"] == "拒测甲"
               and client_by_id(id_u) == before_u, (p_now, client_by_id(id_u)))

        # 30. 拒绝：set 的设置值不是文本——数字、布尔、null、数组、对象以及缺少
        #     value，四个可修改字段一律 400 并给出具体文本原因（指出设置值不是
        #     文本），不把这些值转成文字写入。
        nontext_snapshot = req("GET", "/api/clients")[1]
        bad_values = [
            ("数字", 123),
            ("布尔", True),
            ("null", None),
            ("数组", ["文本"]),
            ("对象", {"v": 1}),
        ]
        for field, field_label in (("source", "来源"), ("region", "地区"),
                                   ("industry", "行业"), ("important_date", "重要日期")):
            for value_label, bad in bad_values:
                label = "%s 填%s" % (field_label, value_label)
                s, d = batch_update([id_p, id_q], {field: {"op": "set", "value": bad}})
                expect("非文本设置值 400：" + label,
                       s == 400 and "updated_count" not in d, (s, d))
                expect("原因指出设置值不是文本：" + label,
                       isinstance(d.get("error"), str) and "不是文本" in d["error"]
                       and field_label in d["error"], d)
            s, d = batch_update([id_p, id_q], {field: {"op": "set"}})
            expect("缺少 value 400：" + field_label,
                   s == 400 and "updated_count" not in d
                   and "不是文本" in d.get("error", ""), (s, d))
        expect("非文本设置值不转成文字写入",
               req("GET", "/api/clients")[1] == nontext_snapshot)

        # 同次请求中其他完全合法的设置/清空也一并拒绝，不能说成某个客户已处理。
        s, d = batch_update([id_p, id_q, id_r], {
            "source": {"op": "set", "value": "合法来源"},
            "industry": {"op": "clear"},
            "region": {"op": "set", "value": 42},
        })
        expect("混合非文本值整次 400", s == 400 and "updated_count" not in d, (s, d))
        expect("混合非文本值原因具体",
               isinstance(d.get("error"), str) and "不是文本" in d["error"], d)
        expect("混合非文本值：合法项也未保存",
               req("GET", "/api/clients")[1] == nontext_snapshot)

        # 只把不合法的设置值修正为文本后再提交，同样的修改按现有规则成功。
        s, d = batch_update([id_p, id_q, id_r], {
            "source": {"op": "set", "value": "合法来源"},
            "industry": {"op": "clear"},
            "region": {"op": "set", "value": " 42 区 "},
        })
        expect("修正为文本后 200 处理 3 名", s == 200 and d == {"updated_count": 3}, (s, d))
        p_now, r_now = client_by_id(id_p), client_by_id(id_r)
        expect("修正后来源/地区写入（去前后空白）、行业清空",
               p_now["source"] == "合法来源" and p_now["region"] == "42 区"
               and p_now["industry"] is None, p_now)
        expect("原本为空的字段按本次操作更新",
               r_now["source"] == "合法来源" and r_now["region"] == "42 区"
               and r_now["industry"] is None and r_now["important_date"] is None, r_now)
        expect("未选中客户与客户总数仍不变",
               client_by_id(id_u) == before_u
               and len(req("GET", "/api/clients")[1]["clients"]) == client_total)

        # ===== 选择编号校验回归：编号数组混入不合格值必须整次拒绝 =====
        # 31. 准备四名客户：号测甲/号测乙四个可修改字段互不相同，号测丙四个字段
        #     导入时均未填写（验证空字段不会被先写入或从他人补值），号测丁不参与
        #     选择（未选中对照）。
        s, d = import_csv(
            "name,source,region,industry,important_date\n"
            "号测甲,sA,rA,iA,2010-01-01\n"
            "号测乙,sB,rB,iB,2011-02-02\n"
            "号测丙,,,,\n"
            "号测丁,sD,rD,iD,2012-03-03\n"
        )
        expect("编号校验客户导入 4 新增", s == 200 and d["imported_count"] == 4, d)
        id_g, id_h, id_i, id_j = (x["id"] for x in d["imported"])
        before_g = client_by_id(id_g)
        before_h = client_by_id(id_h)
        before_i = client_by_id(id_i)
        before_j = client_by_id(id_j)
        expect("号测甲乙资料互不相同",
               before_g["source"] != before_h["source"]
               and before_g["region"] != before_h["region"]
               and before_g["industry"] != before_h["industry"]
               and before_g["important_date"] != before_h["important_date"],
               (before_g, before_h))
        expect("号测丙四字段原本为空",
               all(before_i[f] is None for f in
                   ("source", "region", "industry", "important_date")), before_i)
        id_snapshot = req("GET", "/api/clients")[1]
        id_total = len(id_snapshot["clients"])

        # 同次请求带有完全可执行的设置与清空：编号不合格时这些合法字段操作也不允许先保存。
        id_legal_updates = {
            "source": {"op": "set", "value": " 不应保存的编号来源 "},
            "industry": {"op": "clear"},
        }

        # 数字形式的文本（内容恰好等于已有编号也不接受）、浮点数（含写成 1.0 的值与
        # 恰为某编号整数值的浮点）、布尔（不得当成编号 1 或 0）、null、零、负数，
        # 均不是合法客户编号；无论排在合法编号之前还是之后都整次拒绝。
        bad_id_values = [
            ("数字形式的文本", "1"),
            ("数字文本内容恰为选中编号", str(id_g)),
            ("浮点 1.0", 1.0),
            ("浮点 1.5", 1.5),
            ("浮点值恰为已有编号", float(id_h)),
            ("布尔 true", True),
            ("布尔 false", False),
            ("null", None),
            ("零", 0),
            ("负数 -1", -1),
            ("负的已有编号", -id_g),
        ]
        for value_label, bad in bad_id_values:
            for order_label, ids in (
                ("不合格值在合法编号之前", [bad, id_g, id_h]),
                ("不合格值在合法编号之后", [id_g, id_h, bad]),
            ):
                label = "%s（%s）" % (value_label, order_label)
                s, d = batch_update(ids, id_legal_updates)
                expect("不合格编号 400：" + label,
                       s == 400 and "updated_count" not in d, (s, d, bad))
                expect("原因非空可读且说明编号必须为正整数：" + label,
                       isinstance(d.get("error"), str) and bool(d["error"].strip())
                       and "正整数" in d["error"], d)
                expect("整次拒绝不写入任何客户：" + label,
                       req("GET", "/api/clients")[1] == id_snapshot)

        # 全部拒绝后逐客户核对：选中客户的来源、地区、行业与重要日期分别保持自己的
        # 原值（原本为空的仍为空），不能被统一成其中一名客户的内容；编号、名称、
        # 客户总数与未选中客户都不变，也不表示部分客户已修改。
        expect("号测甲四字段分别保持原值",
               client_by_id(id_g) == {"id": id_g, "name": "号测甲", "source": "sA",
                                      "region": "rA", "industry": "iA",
                                      "important_date": "2010-01-01"},
               client_by_id(id_g))
        expect("号测乙四字段分别保持原值、未被统一成甲的内容",
               client_by_id(id_h) == {"id": id_h, "name": "号测乙", "source": "sB",
                                      "region": "rB", "industry": "iB",
                                      "important_date": "2011-02-02"},
               client_by_id(id_h))
        expect("号测丙原本为空的字段仍为空",
               client_by_id(id_i) == {"id": id_i, "name": "号测丙", "source": None,
                                      "region": None, "industry": None,
                                      "important_date": None},
               client_by_id(id_i))
        expect("未选中的号测丁不受影响", client_by_id(id_j) == before_j, client_by_id(id_j))
        expect("编号校验拒绝后编号名称与客户总数不变",
               client_by_id(id_g)["id"] == id_g and client_by_id(id_h)["id"] == id_h
               and len(req("GET", "/api/clients")[1]["clients"]) == id_total)

        # 32. 两个与选择直接相关的边界同样整次拒绝：空编号数组说明未选择客户；
        #     ids 缺失或不是数组说明需要客户编号数组。updates 合法也不写入。
        s, d = batch_update([], id_legal_updates)
        expect("空编号数组 400 且无处理数量",
               s == 400 and "updated_count" not in d, (s, d))
        expect("空编号数组原因说明未选择客户",
               isinstance(d.get("error"), str) and bool(d["error"].strip())
               and "未选择客户" in d["error"], d)
        expect("空编号数组整次不写入",
               req("GET", "/api/clients")[1] == id_snapshot)

        def batch_update_raw(payload):
            body = json.dumps(payload).encode("utf-8")
            r = urllib.request.Request(BASE + "/api/clients/batch-update", data=body,
                                       method="POST",
                                       headers={"Content-Type": "application/json"})
            try:
                with urllib.request.urlopen(r) as resp:
                    return resp.status, json.loads(resp.read().decode("utf-8"))
            except urllib.error.HTTPError as e:
                return e.code, json.loads(e.read().decode("utf-8"))

        ids_shape_cases = [
            ("缺少 ids", {"updates": id_legal_updates}),
            ("ids 为 null", {"ids": None, "updates": id_legal_updates}),
            ("ids 为文本", {"ids": str(id_g), "updates": id_legal_updates}),
            ("ids 为数字", {"ids": id_g, "updates": id_legal_updates}),
            ("ids 为对象", {"ids": {str(id_g): True}, "updates": id_legal_updates}),
        ]
        for label, payload in ids_shape_cases:
            s, d = batch_update_raw(payload)
            expect("编号集合缺失或不是数组 400：" + label,
                   s == 400 and "updated_count" not in d, (s, d))
            expect("原因非空可读且说明需要客户编号数组：" + label,
                   isinstance(d.get("error"), str) and bool(d["error"].strip())
                   and "客户编号数组" in d["error"], d)
            expect("编号形状错误整次不写入：" + label,
                   req("GET", "/api/clients")[1] == id_snapshot)

        # 33. 移除不合格值、只保留实际存在的整数编号后，同样的合法字段修改正常
        #     成功：只影响明确要求设置/清空的字段，未要求修改（省略说明）的字段
        #     各自保留原值；重复出现的合法编号只算一名客户。
        s, d = batch_update([id_g, id_g, id_h, id_i, id_g], {
            "source": {"op": "set", "value": "  统一新来源  "},
            "industry": {"op": "clear"},
        })
        expect("移除不合格值后 200 且重复编号去重处理 3 名",
               s == 200 and d == {"updated_count": 3}, (s, d))
        g_now, h_now, i_now = client_by_id(id_g), client_by_id(id_h), client_by_id(id_i)
        expect("明确设置的来源写入全部选中客户（去前后空白）",
               g_now["source"] == "统一新来源" and h_now["source"] == "统一新来源"
               and i_now["source"] == "统一新来源", (g_now, h_now, i_now))
        expect("明确清空的行业为 null（含原本为空者）",
               g_now["industry"] is None and h_now["industry"] is None
               and i_now["industry"] is None, (g_now, h_now, i_now))
        expect("未要求修改的地区各自保留原值、不被统一",
               g_now["region"] == "rA" and h_now["region"] == "rB"
               and i_now["region"] is None, (g_now, h_now, i_now))
        expect("未要求修改的重要日期各自保留原值、不被统一",
               g_now["important_date"] == "2010-01-01"
               and h_now["important_date"] == "2011-02-02"
               and i_now["important_date"] is None, (g_now, h_now, i_now))
        expect("编号与名称不变",
               g_now["id"] == id_g and g_now["name"] == "号测甲"
               and h_now["id"] == id_h and h_now["name"] == "号测乙"
               and i_now["id"] == id_i and i_now["name"] == "号测丙",
               (g_now, h_now, i_now))
        expect("未选中客户与客户总数仍不变",
               client_by_id(id_j) == before_j
               and len(req("GET", "/api/clients")[1]["clients"]) == id_total)

        # ===== 客户编号上限（SQLite INTEGER 最大值 2^63-1）边界回归 =====
        # 这里覆盖的是 JSON 整数本身超过上限：它与数字形式的文本、浮点数不属于
        # 同一种输入情况（后两者仍按第 31 步的「编号必须为正整数」拒绝）。
        # 34. 准备四名客户：界测甲/界测乙四个可修改字段互不相同，界测丙来源、行业、
        #     重要日期导入时即未填写（验证拒绝后空字段不会被先写入或从他人补值），
        #     界测丁不参与选择（未选中对照）。
        MAX_ID = 9223372036854775807
        OVER_ID = MAX_ID + 1
        HUGE_ID = 99999999999999999999
        s, d = import_csv(
            "name,source,region,industry,important_date\n"
            "界测甲,转介绍,华中,建筑业,2016-07-08\n"
            "界测乙,网络投放,华西,物流业,2015-09-10\n"
            "界测丙,,华南,,\n"
            "界测丁,代理,海外,金融业,2014-04-04\n"
        )
        expect("编号上限客户导入 4 新增", s == 200 and d["imported_count"] == 4, d)
        id_k1, id_k2, id_k3, id_k4 = (x["id"] for x in d["imported"])
        before_k1 = client_by_id(id_k1)
        before_k2 = client_by_id(id_k2)
        before_k3 = client_by_id(id_k3)
        before_k4 = client_by_id(id_k4)
        expect("界测甲乙资料互不相同",
               before_k1["source"] != before_k2["source"]
               and before_k1["region"] != before_k2["region"]
               and before_k1["industry"] != before_k2["industry"]
               and before_k1["important_date"] != before_k2["important_date"],
               (before_k1, before_k2))
        expect("界测丙来源/行业/日期原本为空",
               before_k3["source"] is None and before_k3["industry"] is None
               and before_k3["important_date"] is None, before_k3)
        limit_snapshot = req("GET", "/api/clients")[1]
        limit_total = len(limit_snapshot["clients"])

        # 同次请求同时包含完全合法的设置与清空：编号越界时整次拒绝，二者都不得落库。
        limit_legal_updates = {
            "source": {"op": "set", "value": " 越界编号不应保存的来源 "},
            "industry": {"op": "clear"},
        }

        # 越界值必须是 JSON 整数字面量（无小数点、无指数、不是文本），否则就退化成
        # 第 31 步覆盖的另一类输入；直接核对序列化后的请求体锁定这一点。
        wire = json.dumps({"ids": [OVER_ID, id_k1], "updates": limit_legal_updates})
        expect("越界值以 JSON 整数字面量发送",
               '"ids": [9223372036854775808,' in wire
               and "9223372036854775808.0" not in wire
               and "9.223" not in wire, wire)

        # 越界编号无论排在正常编号之前还是之后、正常编号是否重复出现、同次是否还选了
        # 含空字段的客户，都必须整次 400 拒绝，且任何客户都不改变。
        over_cases = [
            ("上限+1 排在正常编号之前", OVER_ID, [OVER_ID, id_k1, id_k2]),
            ("上限+1 排在正常编号之后", OVER_ID, [id_k1, id_k2, OVER_ID]),
            ("明显更大的整数排在正常编号之前", HUGE_ID, [HUGE_ID, id_k2, id_k1]),
            ("明显更大的整数排在正常编号之后", HUGE_ID, [id_k1, id_k2, HUGE_ID]),
            ("正常编号重复且上限+1 排在末尾", OVER_ID, [id_k1, id_k1, id_k2, OVER_ID]),
            ("正常编号重复且更大整数排在开头", HUGE_ID, [HUGE_ID, id_k1, id_k2, id_k1]),
            ("上限+1 与含空字段客户同时提交", OVER_ID, [id_k1, id_k3, OVER_ID]),
        ]
        for label, offending, ids in over_cases:
            s, d = batch_update(ids, limit_legal_updates)
            expect("越界编号 400：" + label,
                   s == 400 and isinstance(d, dict) and "updated_count" not in d,
                   (s, d, ids))
            err = d.get("error")
            expect("越界原因非空可读、指出超出范围并写明上限：" + label,
                   isinstance(err, str) and bool(err.strip())
                   and "超出可接受范围" in err and str(MAX_ID) in err, err)
            # 原因中逐位给出越界整数值，证明服务按整数精确接收，没有被浮点取整。
            expect("越界原因含逐位准确的越界编号：" + label,
                   isinstance(err, str) and str(offending) in err, err)
            expect("越界原因不把错误说成客户不存在：" + label,
                   isinstance(err, str) and "找不到" not in err and "不存在" not in err,
                   err)
            # 每次拒绝后整份列表必须与提交前完全一致，无部分修改。
            expect("越界整次不写入：" + label,
                   req("GET", "/api/clients")[1] == limit_snapshot)

        # 全部拒绝后逐客户核对：四名可修改字段分别保持自己的原值，资料互不相同的
        # 客户没有被统一成某人的原值，原本未填写的字段仍是未填写（不从其他客户补值）；
        # 客户编号、名称、总数与未选中客户都不变。
        expect("界测甲保持提交前全部资料",
               client_by_id(id_k1) == before_k1, client_by_id(id_k1))
        expect("界测乙保持提交前全部资料、未被统一成甲的原值",
               client_by_id(id_k2) == before_k2, client_by_id(id_k2))
        expect("界测丙空字段仍为空、非空字段保留",
               client_by_id(id_k3) == before_k3, client_by_id(id_k3))
        expect("未选中的界测丁不受影响", client_by_id(id_k4) == before_k4,
               client_by_id(id_k4))
        expect("越界拒绝后编号名称与客户总数不变",
               client_by_id(id_k1)["id"] == id_k1 and client_by_id(id_k2)["id"] == id_k2
               and client_by_id(id_k3)["name"] == "界测丙"
               and len(req("GET", "/api/clients")[1]["clients"]) == limit_total)
        # 拒绝回复必须完整可读、不能靠断开连接结束：拒绝之后服务与连接仍可正常使用。
        s, h = req("GET", "/health")
        expect("拒绝后服务仍正常响应", s == 200 and h == {"status": "ok", "product": "ClientBook"}, h)

        # 35. 边界两侧必须区分：上限值 9223372036854775807 本身是范围内的整数，
        #     在没有对应客户时按既有规则报「找不到对应客户」，而不是报超范围。
        s, d = batch_update([MAX_ID], limit_legal_updates)
        err = d.get("error", "")
        expect("上限值本身在范围内：无客户时按找不到编号 400",
               s == 400 and "updated_count" not in d
               and "找不到" in err and str(MAX_ID) in err and "超出" not in err,
               (s, d))
        expect("上限值探测整次不写入", req("GET", "/api/clients")[1] == limit_snapshot)
        s, d = batch_update([id_k1, id_k2, MAX_ID], limit_legal_updates)
        err = d.get("error", "")
        expect("上限值与正常编号混合时仍按找不到编号 400",
               s == 400 and "updated_count" not in d
               and "找不到" in err and str(MAX_ID) in err and "超出" not in err,
               (s, d))
        expect("上限值混合探测整次不写入", req("GET", "/api/clients")[1] == limit_snapshot)

        # 数值同样越过上限的数字文本与浮点，属于第 31 步的「必须为正整数」类别，
        # 不走超范围分支——锁定两类输入情况的区别。
        s, d = batch_update_raw({"ids": [str(OVER_ID), id_k1],
                                 "updates": limit_legal_updates})
        err = d.get("error", "")
        expect("数字形式的文本按非正整数拒绝、不报超范围",
               s == 400 and "updated_count" not in d
               and "正整数" in err and "超出" not in err, (s, d))
        s, d = batch_update_raw({"ids": [id_k2, float(OVER_ID)],
                                 "updates": limit_legal_updates})
        err = d.get("error", "")
        expect("超过上限的浮点仍按非正整数拒绝、不报超范围",
               s == 400 and "updated_count" not in d
               and "正整数" in err and "超出" not in err, (s, d))
        expect("文本/浮点对照后仍整次不写入",
               req("GET", "/api/clients")[1] == limit_snapshot)

        # 36. 移除越界编号、只保留已登记客户后，同样的合法修改一次成功：重复编号只
        #     计一名客户；设置与清空只作用于所选客户，未要求修改的字段各自保留原值，
        #     原本为空的字段不被补入他人内容。
        s, d = batch_update([id_k1, id_k1, id_k2, id_k3, id_k1], {
            "source": {"op": "set", "value": "  上限边界回归来源  "},
            "industry": {"op": "clear"},
        })
        expect("移除越界编号后 200 且重复编号去重处理 3 名",
               s == 200 and d == {"updated_count": 3}, (s, d))
        k1_now, k2_now, k3_now = (client_by_id(i) for i in (id_k1, id_k2, id_k3))
        expect("合法设置与清空只作用所选客户（来源设置、行业清空）",
               k1_now["source"] == "上限边界回归来源"
               and k2_now["source"] == "上限边界回归来源"
               and k3_now["source"] == "上限边界回归来源"
               and k1_now["industry"] is None and k2_now["industry"] is None
               and k3_now["industry"] is None, (k1_now, k2_now, k3_now))
        expect("未要求修改的地区各自保留原值",
               k1_now["region"] == "华中" and k2_now["region"] == "华西"
               and k3_now["region"] == "华南", (k1_now, k2_now, k3_now))
        expect("未要求修改的重要日期各自保留原值（含原本为空者）",
               k1_now["important_date"] == "2016-07-08"
               and k2_now["important_date"] == "2015-09-10"
               and k3_now["important_date"] is None, (k1_now, k2_now, k3_now))
        expect("编号与名称不变",
               k1_now["id"] == id_k1 and k1_now["name"] == "界测甲"
               and k2_now["id"] == id_k2 and k2_now["name"] == "界测乙"
               and k3_now["id"] == id_k3 and k3_now["name"] == "界测丙",
               (k1_now, k2_now, k3_now))
        expect("未选中客户与客户总数仍不变",
               client_by_id(id_k4) == before_k4
               and len(req("GET", "/api/clients")[1]["clients"]) == limit_total)
    finally:
        proc.terminate()
        proc.wait(timeout=5)
        shutil.rmtree(TMP, ignore_errors=True)

    print(f"\n{'='*40}\n{'全部通过' if expect.failed == 0 else f'{expect.failed} 项失败'}")
    return 1 if expect.failed else 0


if __name__ == "__main__":
    sys.exit(main())

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
    finally:
        proc.terminate()
        proc.wait(timeout=5)
        shutil.rmtree(TMP, ignore_errors=True)

    print(f"\n{'='*40}\n{'全部通过' if expect.failed == 0 else f'{expect.failed} 项失败'}")
    return 1 if expect.failed else 0


if __name__ == "__main__":
    sys.exit(main())

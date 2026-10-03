#!/usr/bin/env python3
"""批量修改回归测试：启动真实 HTTP 服务，覆盖批量修改的选中隔离与整次拒绝行为。

重点保障两个结果：
- 一次修改只作用于明确选中的客户（含去重、字段独立、不串改其他客户资料）；
- 请求中有错误时整次修改不生效（HTTP 400，所有客户资料保持提交前状态）。
"""
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
TMP = Path(tempfile.mkdtemp(prefix="clientbook-batch-test-"))


def req(method, path, body=None):
    data = body.encode("utf-8") if isinstance(body, str) else None
    r = urllib.request.Request(BASE + path, data=data, method=method)
    try:
        with urllib.request.urlopen(r) as resp:
            return resp.status, json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode("utf-8"))


def import_csv(content):
    r = urllib.request.Request(BASE + "/api/clients/import",
                               data=content.encode("utf-8"), method="POST")
    try:
        with urllib.request.urlopen(r) as resp:
            return resp.status, json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode("utf-8"))


def batch_update(payload):
    return req("POST", "/api/clients/batch-update", json.dumps(payload, ensure_ascii=False))


def clients_by_id():
    s, d = req("GET", "/api/clients")
    assert s == 200, d
    return {c["id"]: c for c in d["clients"]}


def expect(label, cond, detail=""):
    print(("PASS" if cond else "FAIL"), label, detail)
    if not cond:
        expect.failed += 1
expect.failed = 0


def start_server(data_dir):
    proc = subprocess.Popen(
        [sys.executable, str(Path(__file__).parent / "app.py"),
         "serve", "--host", "127.0.0.1", "--port", "0", "--data-dir", str(data_dir)],
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    import re as _re
    deadline = time.time() + 5
    while time.time() < deadline:
        line = proc.stdout.readline()
        if not line:
            if proc.poll() is not None:
                print("服务启动失败：", proc.stdout.read())
                sys.exit(1)
            time.sleep(0.05)
            continue
        m = _re.search(r"http://127\.0\.0\.1:(\d+)", line)
        if m:
            return proc, f"http://127.0.0.1:{m.group(1)}"
    print("未能解析服务端口")
    proc.terminate()
    sys.exit(1)


def wait_ready():
    for _ in range(50):
        try:
            req("GET", "/health")
            return
        except OSError:
            time.sleep(0.1)
    raise SystemExit("服务未就绪")


def main():
    global BASE
    data_dir = TMP / "data"
    proc, BASE = start_server(data_dir)
    try:
        wait_ready()

        # 0. 准备三名资料不同的客户：来源、地区、行业、重要日期两两有区别
        s, d = import_csv(
            "name,source,region,industry,important_date\n"
            "甲公司,展会,华东,制造业,2024-02-29\n"
            "乙公司,官网,华南,零售业,2025-06-15\n"
            "丙公司,电话,华北,金融业,2023-12-01\n"
        )
        expect("准备数据：3 名客户导入", s == 200 and d["imported_count"] == 3, d)
        before = clients_by_id()
        id_a, id_b, id_c = sorted(before)
        a0, b0, c0 = before[id_a], before[id_b], before[id_c]
        expect("三名客户资料互不相同",
               len({(c["source"], c["region"], c["industry"], c["important_date"])
                    for c in before.values()}) == 3, before)

        # 1. 只选中两名客户：来源设为带前后空白的新文本（含内部空白与换行），
        #    清空行业，地区和重要日期保持原值
        new_source_raw = "  线上 渠道\n推广  "
        new_source = "线上 渠道\n推广"
        s, d = batch_update({
            "ids": [id_a, id_b],
            "updates": {
                "source": {"op": "set", "value": new_source_raw},
                "industry": {"op": "clear"},
                "region": {"op": "keep"},
                "important_date": {"op": "keep"},
            },
        })
        expect("批量修改 200", s == 200, (s, d))
        expect("updated_count 为去重后的 2", d.get("updated_count") == 2, d)

        after = clients_by_id()
        a1, b1, c1 = after[id_a], after[id_b], after[id_c]
        expect("两名客户来源去除前后空白",
               a1["source"] == new_source and b1["source"] == new_source, (a1, b1))
        expect("来源内部空白与换行保留",
               "线上 渠道" in a1["source"] and "\n推广" in a1["source"]
               and a1["source"] == a1["source"].strip(), repr(a1["source"]))
        expect("两名客户行业清空为 null",
               a1["industry"] is None and b1["industry"] is None, (a1, b1))
        expect("地区各自保留原值（不互相覆盖）",
               a1["region"] == "华东" and b1["region"] == "华南", (a1, b1))
        expect("重要日期各自保留原值（不互相覆盖）",
               a1["important_date"] == "2024-02-29" and b1["important_date"] == "2025-06-15",
               (a1, b1))
        expect("客户编号和名称不变",
               a1["id"] == id_a and a1["name"] == a0["name"]
               and b1["id"] == id_b and b1["name"] == b0["name"], (a1, b1))
        expect("未选中客户所有资料不变", c1 == c0, (c0, c1))

        # 2. 同一编号重复出现只算一名；原值已等于设置值的客户仍计入；
        #    保持原值的字段省略修改说明，原有非空值不能变空
        s, d = batch_update({
            "ids": [id_a, id_a, id_b],
            "updates": {"source": {"op": "set", "value": new_source}},
        })
        expect("重复编号仍 200", s == 200, (s, d))
        expect("updated_count 按不同编号计算", d.get("updated_count") == 2, d)
        after = clients_by_id()
        expect("省略 keep 字段后地区非空值保留",
               after[id_a]["region"] == "华东" and after[id_b]["region"] == "华南",
               (after[id_a], after[id_b]))
        expect("省略 keep 字段后日期非空值保留",
               after[id_a]["important_date"] == "2024-02-29"
               and after[id_b]["important_date"] == "2025-06-15",
               (after[id_a], after[id_b]))
        expect("未选中客户仍不变", after[id_c] == c0, after[id_c])

        # 3. 重要日期接受真实闰年日期，列表读取仍为 YYYY-MM-DD
        s, d = batch_update({
            "ids": [id_b],
            "updates": {"important_date": {"op": "set", "value": " 2028-02-29 "}},
        })
        expect("闰年日期设置 200", s == 200 and d.get("updated_count") == 1, (s, d))
        after = clients_by_id()
        expect("列表日期为 YYYY-MM-DD", after[id_b]["important_date"] == "2028-02-29",
               after[id_b])
        expect("仅选中客户日期变化", after[id_a]["important_date"] == "2024-02-29"
               and after[id_c]["important_date"] == "2023-12-01", after)

        # 4. 拒绝：客户都存在，但重要日期无效（2023-02-29）→ 整次不生效
        snapshot = clients_by_id()
        s, d = batch_update({
            "ids": [id_a, id_b],
            "updates": {
                "source": {"op": "set", "value": "不应保存的来源"},
                "industry": {"op": "clear"},
                "important_date": {"op": "set", "value": "2023-02-29"},
            },
        })
        expect("无效日期 400", s == 400, (s, d))
        expect("错误说明具体原因",
               "error" in d and "2023-02-29" in d["error"] and "日历" in d["error"], d)
        expect("不返回成功数量", "updated_count" not in d, d)
        expect("无效日期后所有客户完整保留", clients_by_id() == snapshot,
               clients_by_id())

        # 5. 拒绝：修改值合法，但选中编号混有不存在的客户 → 整次不生效
        missing_id = max(snapshot) + 1000
        s, d = batch_update({
            "ids": [id_a, id_b, missing_id],
            "updates": {
                "source": {"op": "set", "value": "不应保存的来源"},
                "industry": {"op": "clear"},
            },
        })
        expect("不存在编号 400", s == 400, (s, d))
        expect("错误指出找不到的编号",
               "error" in d and str(missing_id) in d["error"], d)
        expect("不返回成功数量", "updated_count" not in d, d)
        expect("不存在编号后所有客户完整保留", clients_by_id() == snapshot,
               clients_by_id())

        print("\n重启服务验证批量修改结果持久化…")
    finally:
        proc.terminate()
        proc.wait(timeout=5)

    proc, BASE = start_server(data_dir)
    try:
        wait_ready()
        persisted = clients_by_id()
        expect("重启后批量修改结果仍在",
               persisted[id_a]["source"] == new_source
               and persisted[id_b]["source"] == new_source
               and persisted[id_a]["industry"] is None
               and persisted[id_b]["important_date"] == "2028-02-29",
               persisted)
        expect("重启后未选中客户仍不变", persisted[id_c] == c0, persisted[id_c])
    finally:
        proc.terminate()
        proc.wait(timeout=5)
        shutil.rmtree(TMP, ignore_errors=True)

    print(f"\n{'='*40}\n{'全部通过' if expect.failed == 0 else f'{expect.failed} 项失败'}")
    return 1 if expect.failed else 0


if __name__ == "__main__":
    sys.exit(main())

# ClientBook

客户联系人与商机记录。

需要Python 3.10 或更新版本，包含标准库 sqlite3。

查看命令帮助：

```sh
python3 app.py --help
```

启动本地服务：

```sh
python3 app.py serve --host 127.0.0.1 --port 8080 --data-dir data
```

打开 http://127.0.0.1:8080 查看首页。Ctrl+C 停止服务。`--data-dir` 指定本地业务数据目录，重启时继续使用同一目录。

接口：

- `GET /health` 返回服务状态和产品名称。
- `GET /api/clients` 返回客户列表，首次启动时为空。
- `POST /api/clients/import` 接收 CSV 文件内容（请求体为原始 CSV 文本），返回导入结果。
- 未知路径返回 404，已知路径不支持的方法返回 405。

CSV 文件采用 UTF-8 编码（允许开头带 BOM），表头使用 `name`、`source`、`region`、`industry`、`important_date`，分别表示客户名称、来源、地区、行业和重要日期。只有 `name` 列必须存在，其余列可省略，顺序不限。字段可使用逗号、引号和字段内换行。

导入结果包含 `added`（新增数量）、`not_imported`（未导入数量）和 `records`（逐条结果）。文件级错误（编码错误、CSV 结构损坏、缺少名称列、表头重复、出现未知列）返回 400；其余情况返回 200，即使部分记录失败也分别列出。记录级失败包括列数不符、名称为空、重要日期格式无效或不是真实日历日期、与已有客户或文件内记录重复。重复判断使用去掉前后空白的名称，英文字母不区分大小写，内部空白和标点保持区别。导入不更新已有客户。

```sh
curl http://127.0.0.1:8080/health
curl http://127.0.0.1:8080/api/clients
curl -X POST -H "Content-Type: text/csv; charset=utf-8" --data-binary @clients.csv http://127.0.0.1:8080/api/clients/import
```

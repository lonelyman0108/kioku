# 从 Lore 迁移

导入工具只读访问 Lore 的数据库，把节点写进 Kioku 的一个空间。可以重复执行：按 Lore 节点去重，导入过的不再写入，导入后在 Kioku 里删除或移动了的也不会被写回；URI 已被别的记忆占用时跳过。所以先导一次、在管理界面里调整，再补导 Lore 里新增的节点都没问题。迁移期间两边可以并行，各客户端确认后再逐个切过来。注意导入过的节点不会再同步：并行期间在 Lore 里修改、移动或删除的节点，再执行也带不过来，要在管理界面里手动更新。

## 映射规则

| Lore | Kioku |
|---|---|
| `core://agent` | 基础层 `core://agent`，所有应用都读 |
| `core://soul` | 人格 `persona://<人格>/soul`，默认人格标识 `default`，不存在时新建 |
| `core://agent/<runtime>` | 导入者自己的对应应用的应用层 `app://<应用>/agent`。先找标识相同的应用，再找同一运行时类型的应用，都没有就新建；别的成员的应用不写，同名标识已被别人占用时跳过并说明 |
| `core://` 下的其他节点 | 基础层，URI 不变 |
| `preferences://` | 导入者的主人层，URI 不变 |
| 其余 domain | 导入者的私人层，URI 不变 |

- priority、disclosure、glossary 保留，创建时间沿用 Lore 的。关键词按接口规则过滤：单字的丢弃，每条最多 32 个，超出时保留较长的。
- 新建的应用和原本没有默认人格的应用，默认人格设为导入的人格，与 Lore 里所有客户端共用 `core://soul` 一致。
- 历史版本不迁移：每条记忆记一条 `import` 事件，带上 Lore 的节点 uuid 和旧版本数。Lore 的库留作归档。召回事件也不迁移。
- Lore 的别名（同一节点的多条路径）只导入最早的一条，其余在计划里列出。

## 步骤

1. 在管理界面完成初始化，确认导入用的账号是空间 owner。要导入 secret 时，服务端必须配置了 `KIOKU_MASTER_KEY`。
2. 先看导入计划，不写入任何数据：

   ```bash
   export DATABASE_URL=<Kioku 的连接串> LORE_DATABASE_URL=<Lore 的连接串> KIOKU_MASTER_KEY=<与服务相同>
   node apps/server/dist/import-lore.mjs --account <用户名> --secret infra://home_network/credentials
   ```

   用 Docker 部署时在服务容器里执行，Lore 的库要能从容器里访问（例如 `docker network connect` 把服务容器接到 Lore 所在的网络）：

   ```bash
   docker compose -f docker-compose.example.yml exec -e LORE_DATABASE_URL=<Lore 的连接串> \
     kioku node server/dist/import-lore.mjs --account <用户名>
   ```

3. 检查计划里的「提醒」：路径、正文、disclosure 或关键词里像有密码、Token 的节点会列出来。标成 secret（`--secret <Lore URI>`，可重复）后正文加密存储，召回和 boot 都不再返回它，只有带 secret 权限的 Key 显式读取时才能看到；如果节点里大部分是普通说明，更合适的做法是导入后把凭据拆成一条单独的 secret 记忆。
4. 确认无误后加 `--apply` 执行。导入完成后会安排一次向量补齐，服务正在运行时由它的后台任务接手。
5. 在「应用与 Key」里为要接入的应用签发 Key，按 README 接入客户端。

## 对照检查

导入后用应用的 Key 请求 `GET /v1/boot`，Claude Code 应用应当得到与 Lore 启动时相同的四个节点：`core://agent`、`persona://default/soul`、`app://<应用>/agent`、`preferences://user`。没有配置嵌入模型时召回只走全文与关键词两路，在「实例设置」里配好嵌入接口后会补齐向量。

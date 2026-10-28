# 从 Lore 迁移

导入工具只读访问 Lore 的数据库，把节点写进 Kioku 的一个空间。可以重复执行：按 Lore 节点去重，导入过的不再写入，导入后在 Kioku 里删除或移动了的也不会被写回；URI 已被别的记忆占用时跳过。所以先导一次、在管理界面里调整，再补导 Lore 里新增的节点都没问题。迁移期间两边可以并行，各客户端确认后再逐个切过来。并行期间在 Lore 里改过的节点，加 `--sync` 执行就能带过来（见「同步」）。

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
   node apps/server/dist/import-lore.mjs --account <用户名> --secret infra://office_network/credentials
   ```

   用 Docker 部署时在服务容器里执行，Lore 的库要能从容器里访问（例如 `docker network connect` 把服务容器接到 Lore 所在的网络）：

   ```bash
   docker compose -f docker-compose.example.yml exec -e LORE_DATABASE_URL=<Lore 的连接串> \
     kioku node server/dist/import-lore.mjs --account <用户名>
   ```

3. 检查计划里的「提醒」：路径、正文、disclosure 或关键词里像有密码、Token 的节点会列出来。标成 secret（`--secret <Lore URI>`，可重复）后正文加密存储，召回和 boot 都不再返回它，只有带 secret 权限的 Key 显式读取时才能看到；如果节点里大部分是普通说明，更合适的做法是导入后把凭据拆成一条单独的 secret 记忆。
4. 确认无误后加 `--apply` 执行。导入完成后会安排一次向量补齐，服务正在运行时由它的后台任务接手。
5. 在「应用与 Key」里为要接入的应用签发 Key，按 README 接入客户端。

## 同步

导入过的节点在 Lore 里又改了，加 `--sync` 再执行一次（先不加 `--apply` 看计划）：

- 正文、priority、disclosure 与关键词改成 Lore 里现在的，每条记一条「同步导入」事件。敏感级不跟着改：要改成 secret 或从 secret 改回来，在管理界面里改。
- 只更新导入（或上次同步）之后在 Kioku 里没人改过的记忆：版本号还是导入工具最后写下的那个。在管理界面或通过 Key 改过、移动过、删除了的都不动，只在计划里列出来，要跟上 Lore 就手动改。所以做过凭据迁移的节点不会被 Lore 里的明文盖回去。
- Lore 里换了路径的节点也只列出来：移动可能改变层（例如移进 `core://` 就成了所有应用都读的基础层），要在管理界面手动移动；移动之后这条就算在 Kioku 里改过，以后要手动更新。换了路径之后映射到别的应用或层的（例如从 `core://agent/<runtime>` 移到 `core://`），加 `--sync` 时也不会在新位置再建一条。
- Lore 里删掉的节点只列出来，Kioku 里保留。还在 Lore 里、但这次的计划不导入的节点（例如正文清空了、写进了格式不对的占位符），列出来并给出原因。
- 计划之后、执行之前有人改了某条记忆，执行时按版本号拒绝这一条，其余照常。
- 导入过 secret 记忆时，同步要读出来比对，需要设置与服务相同的 `KIOKU_MASTER_KEY`。

## 对照检查

导入后用应用的 Key 请求 `GET /v1/boot`，Claude Code 应用应当得到与 Lore 启动时相同的四个节点：`core://agent`、`persona://default/soul`、`app://<应用>/agent`、`preferences://user`。没有配置嵌入模型时召回只走全文与关键词两路，在「实例设置」里配好嵌入接口后会补齐向量。

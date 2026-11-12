# 部署与运维

服务端镜像同时托管管理界面，加上带 pgvector 与中文分词的 PostgreSQL，一共两个容器。配置项见文末。

## 启动

### 用发布的镜像

不用克隆仓库，找一个目录放 `compose.yaml` 与 `.env`：

```bash
mkdir kioku && cd kioku
curl -fsSLO https://raw.githubusercontent.com/lonelyman0108/kioku/main/compose.yaml
curl -fsSL -o .env https://raw.githubusercontent.com/lonelyman0108/kioku/main/.env.example
# 按 .env 里的注释生成密码与主密钥
docker compose up -d
```

镜像发布在 GHCR（`ghcr.io/lonelyman0108/kioku`、`ghcr.io/lonelyman0108/kioku-postgres`），Docker Hub 上同名（`lonelyman0108/kioku`、`lonelyman0108/kioku-postgres`）：拉 GHCR 慢时把 `compose.yaml` 里两处 `ghcr.io/` 去掉即可。版本由 `.env` 的 `KIOKU_TAG` 决定，两个镜像用同一个标签：

| 标签 | 内容 |
|---|---|
| `latest` | 最新的正式版（默认） |
| `X.Y.Z` | 某个版本，固定不变；生产环境建议写成它，升级时自己改 |
| `X.Y` | 这个小版本里最新的正式版 |
| `edge` | main 上最新的、通过了 CI 的提交，不保证稳定 |
| `sha-<短提交>` | main 上的某个提交，固定不变；跟着 `edge` 部署时用它回滚 |

`latest` 只跟最高的正式版：补发旧系列的修复版（例如 `0.2.0` 之后的 `0.1.5`）只更新 `0.1`。预发布版（如 `0.1.0-rc.1`）只有它本身这一个标签，不会变成 `latest`。两个镜像都有 `linux/amd64` 与 `linux/arm64`。

### 从源码构建

改了代码、或者想自己构建镜像时，在仓库根目录用 `docker-compose.build.yml`：

```bash
git clone https://github.com/lonelyman0108/kioku && cd kioku
cp .env.example .env      # 按注释生成密码与主密钥
docker compose -f docker-compose.build.yml up -d --build
```

两个 compose 文件的项目名与卷名相同，在仓库根目录换用另一个时数据照旧。本文下面的命令按 `compose.yaml` 写；从源码构建的在 `docker compose` 后面加 `-f docker-compose.build.yml`，`pull` 换成 `build`。

### 访问与初始化

启动前在 `.env` 里定下 `KIOKU_COOKIE_SECURE`：经 HTTPS 访问时保持 `true`；只在局域网用 `http://` 地址访问时改成 `false`，否则浏览器不保存登录 Cookie，登录后会一直回到登录页（`http://localhost` 例外，浏览器把它当安全地址）。

打开 `http://<主机>:18920`，首次进入初始化页。初始化要填初始化码：服务启动时打印在日志里（`docker compose logs kioku` 里「Kioku 初始化码」那一行；也可以在 `.env` 里用 `KIOKU_SETUP_CODE` 自己指定），先确认数据库，再建第一个账号和空间，详见下面的「初始化与数据库」。之后在「应用」里为每个客户端建应用、签发访问密钥：

- MCP：`http://<主机>:18920/v1/mcp`（Streamable HTTP，`Authorization: Bearer <访问密钥>`）
- 生命周期钩子：`POST /v1/lifecycle/event`；其他接口见 `/v1/openapi.json`

## 初始化与数据库

数据库有两种给法：

- **预先配好**：设环境变量 `DATABASE_URL`（两个 compose 文件都是这样，`db` 容器首次启动时建好应用角色、库和扩展）。初始化页的第一步只显示这个连接（密码只显示已填）和检查结果，标明来自环境变量、不能修改，确认后建管理员。
- **在初始化页填**：不设 `DATABASE_URL`，服务照样启动，只提供初始化页（其余接口回 503）。第一步填主机、端口、库名、用户名、密码与 SSL 模式，先「检查」再「保存并接入」：服务当场接上（迁移、启动后台任务），不用重启。连接保存在数据目录的 `kioku.json`（权限 600），之后在界面上不能再改，要改就编辑这个文件或改设环境变量再重启；环境变量优先于文件。

检查的内容：能否连上（失败时只给类别：无法连接、认证失败、超时、库不存在等）；角色不能是超级用户或带 `BYPASSRLS`（否则行级安全不生效，空间之间不隔离）；库里要有 `vector` 与 `zhparser` 两个扩展；库里已有 Kioku 的数据（有账号或空间）时说明将接入已有实例（是记忆架构改版之前的结构时拒绝）；只执行过迁移、还没有账号与空间的库（数据库来自环境变量时，服务启动就执行完迁移）写「空的 Kioku 库」，照常初始化；有不是 Kioku 建的表时提醒。

手上只有超级用户时，选「用超级用户创建」：填超级用户的账号密码、要建的应用角色名和库名，Kioku 建一个 `NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE` 的应用角色（随机密码）、建库（所有者是应用角色），在新库里装好两个扩展，然后只保存应用角色的连接；超级用户的密码不保存、不进日志。服务器上没有这两个扩展时用 Kioku 的 PostgreSQL 镜像（`docker/postgres`），或者自己装 pgvector 与 zhparser。

数据目录由 `KIOKU_DATA_DIR` 指定，镜像里是 `/data`。在初始化页填数据库时要把它挂成持久的卷（两个 compose 文件里的 `kioku-data`），否则重建容器后连接丢失、又回到初始化页。

配好的数据库（环境变量或 `kioku.json`）启动时连不上：连不上、超时、认证失败、库不存在这类可能自己恢复的问题，服务照样启动，按退避自动重试（5 秒起，最多隔 60 秒），接上后自动换成完整的服务。这期间 `/v1/health` 回 503，管理界面显示「数据库不可用」和原因，不进初始化页，也不生成初始化码。不会自己恢复的问题照旧拒绝启动，日志里写明原因：角色是超级用户或带 `BYPASSRLS`、库里缺扩展、记忆架构改版之前的结构、库里有这个版本不认识的迁移、主密钥对不上。

初始化码只在等人初始化时生成：没有配置数据库，或者接上之后发现还没有任何账号。随机生成的码有 130 位熵，每次启动换一个，打印在日志里；建好第一个管理员之后作废。码错时按客户端限流（同一客户端 15 分钟最多 5 次，IPv6 按 /64 算一个客户端），不设全实例的上限，别人刷不满部署者的额度。需要固定的码（例如自动化部署）时设 `KIOKU_SETUP_CODE`，至少 16 个字符，例如 `openssl rand -hex 16` 生成。

脚本化初始化：设好 `DATABASE_URL` 与 `KIOKU_SETUP_CODE`，服务起来之后直接调接口建第一个管理员，返回 201 即完成（码放在请求体里，不放在地址里）：

```bash
curl -fsS -X POST http://127.0.0.1:18920/v1/setup \
  -H 'content-type: application/json' \
  -d "{\"setupCode\":\"$KIOKU_SETUP_CODE\",\"username\":\"admin\",\"displayName\":\"管理员\",\"password\":\"<至少 10 位>\",\"spaceName\":\"我的空间\"}"
```

## HTTPS 与反向代理

对外提供服务时在前面加 HTTPS 反向代理，`KIOKU_COOKIE_SECURE` 保持 `true`，`KIOKU_TRUSTED_PROXIES` 设为代理层数（一层就是 `1`），登录限流才能获取真实的客户端地址。同时在 `.env` 里设 `KIOKU_BIND=127.0.0.1`，端口只给本机的代理访问：否则别人可以绕过代理直连，自己填 `X-Forwarded-For`。是否发 HSTS 由代理决定，服务本身不发。测试台的模型对话一次请求可能要一两分钟（服务端的时限是 120 秒），代理的读超时要大于它，否则界面上看到的是 504。

## 嵌入模型

在「设置 › 实例 › 模型」里配。一个模型可以配几个渠道（同一个模型的不同接口），按顺序请求，前一个出错时换下一个；服务商给模型改了名，只改渠道里「请求用的模型名」，不用重新生成向量。换成别的模型用「换模型」：填新模型的标识与渠道，后台为全部记忆生成新模型的向量，召回在补齐之前一直用原来的模型，补齐后自动切过去、删掉旧的向量；补不上时可以不等补齐直接切换，也可以放弃。整个过程不用改数据库。向量固定 1024 维，换的模型要能按 `dimensions` 参数输出 1024 维（「测试连通」会检查）。

## 测试台

管理界面的「测试台」不接任何客户端，按一个访问密钥模拟应用的调用：调工具、发生命周期事件（可选私聊、群聊上下文）、回放场景与断言，配了抽取模型时还能接真实模型跑一段对话，看它会不会按指引调工具。默认放进事务、结束时回滚，并列出真实执行时的改动；切到真实执行要确认。只给应用所有者，模型对话还要实例管理员。同一份场景也能用真实 HTTP 与真实访问密钥跑（这是真实调用，写操作要加 `--allow-writes`，会记召回事件）：

```bash
docker compose exec -e KIOKU_BENCH_KEY=<访问密钥> kioku \
  node server/dist/bench.mjs --url http://localhost:18920
```

## 备份

在「设置 › 实例 › 数据与保留」的备份里配一个 S3 兼容的对象存储（MinIO、Cloudflare R2、Backblaze B2 等），每天定时把整个实例加密备份上去、只留最近几份；失败时设置和概览里都会提示原因。也可以用命令把整个实例导出成一个加密的文件，服务运行时也可以做。文件用主密钥派生的密钥加密，`KIOKU_MASTER_KEY` 另外保存（丢了它，备份和机密级记忆都无法解密）。备份里没有会话与登录计数、对话缓冲和向量，其余全在。备份文件不要放在仓库目录里，构建镜像时会被带进构建上下文。

```bash
mkdir -p ~/kioku-backup
docker compose exec -T kioku node server/dist/backup.mjs --out - > ~/kioku-backup/kioku-$(date +%F-%H%M%S).backup
```

## 恢复到新实例

新实例的 `.env` 里配做备份时的 `KIOKU_MASTER_KEY`（备份之后轮换过的话，新的主密钥配在 `KIOKU_MASTER_KEY`，做备份时的配在 `KIOKU_MASTER_KEY_PREVIOUS`），数据库是新建的空库，恢复之前不要启动服务。恢复先核对格式、主密钥与迁移，把迁移执行到做备份时的位置，再按原来的 id 写回并执行这个版本新增的迁移（较早版本做的备份也能用新版本恢复，记忆架构改版之前做的除外：改版不兼容旧数据，要从 Lore 重新导入）；写回与新增的迁移在一个事务里，失败时数据一条也不留下，可以直接重试；库里已经有账号或空间时拒绝。恢复先把整份备份解开、核对过才写库，内存要放得下解压后的备份（通常是备份文件的几倍大）。恢复之后所有人重新登录，访问密钥照常可用，向量在后台重新生成。

```bash
docker compose pull
docker compose run --rm -T kioku node server/dist/restore.mjs --file - < ~/kioku-backup/<备份>.backup
docker compose up -d
```

定时备份传到了 S3 兼容存储时，也可以直接从存储桶取最新的一份恢复：先在当前终端里 `export AWS_ACCESS_KEY_ID=… AWS_SECRET_ACCESS_KEY=…`（区域不是 `us-east-1` 时再加 `AWS_REGION`，临时凭据再加 `AWS_SESSION_TOKEN`），再把上面的 `restore.mjs --file -` 一行换成：

```bash
docker compose run --rm -T -e AWS_ACCESS_KEY_ID -e AWS_SECRET_ACCESS_KEY -e AWS_SESSION_TOKEN -e AWS_REGION kioku \
  node server/dist/restore.mjs --s3-endpoint https://s3.example.com --s3-bucket <存储桶> --s3-prefix <前缀>
```

恢复时会清掉备份存储的设置，免得试恢复的实例和正在用的实例往同一个目录写、互相删掉对方的备份；确认新实例要接着用之后，在实例设置里重新配备份。

恢复出的实例暂停保留期的清理，到恢复的时间加上保留天数为止：恢复出的已删除记录按删除的时间早就过了保留期，照常清理会马上把它们永久删掉。要从备份里找回的已删除记录，在这之前从「已删除」里恢复；之后自动照常清理，也可以在「设置 › 实例 › 数据与保留」里提前开始。

## 保留期

删掉的记忆（连同历史、向量、关键词与召回统计）、已被新事实取代的抽取事实、过期的会话摘要，以及抽取记录、整理的运行记录与作废了的建议、凭据事件、已删除的凭据与凭据源，过了保留期（默认 30 天，在「设置 › 实例 › 数据与保留」里改）由每天一次的清理永久删除，每类删了多少在那里看得到。保留期内删掉的记忆与凭据能在管理界面恢复，更早的只能从备份里找回。过了有效期、没有删除的记忆不清。升级到有保留期的版本之后，第一次清理先暂停一个保留期（之前删掉的到这时都还能恢复），之后自动开始，也可以在那里提前开始；暂停期间删账号留下的历史照常清理。

## 把一个空间搬到另一个实例

空间所有者在「设置 › 空间 › 导入与导出」里设一个口令（至少 12 位），下载一个用口令加密的文件；在另一个实例的「设置 › 空间 › 导入与导出」（或空间切换器的「导入空间」）里上传它、填同一个口令，先检查文件（看清是谁导出的、有多少），再确认导入成一个新空间，自己是所有者。文件里是共享的记忆、人格、应用配置与联系人，加上导出人自己的本人记忆、凭据与凭据源（机密记忆与托管的凭据值一起加密带走，导入时用目标实例的主密钥重新加密，所以两边的主密钥可以不同，但目标实例要配了主密钥）；导出人的这些东西导入后都归导入人，本人的记忆会进入导入人的 agent 的启动加载，所以只导入本人导出、或者导出人同意移交的文件。别的成员的本人记忆、访问密钥、登录会话、会话与会话摘要、召回记录、对话缓冲、抽取记录、历史与向量都不带，导入之后给应用重新签发访问密钥，向量在后台重新生成。口令另外保存好，Kioku 不保存它，丢了就打不开文件。文件最大 32 MB。

## 升级

先做一份整库快照（回滚时用），再换新版本的镜像，启动时自动迁移数据库。迁移只向前：旧版本的镜像连不上升级过的库（库里有它不认识的迁移时拒绝启动），回滚用下面的快照恢复。快照要用数据库超级用户：应用角色受行级安全约束，用它导出会报错。用 `latest` 这类会变的标签时，先在 `http://<主机>:18920/v1/health` 记下现在的版本号，回滚时要用；跟着 `edge` 部署的版本号都是 `edge`，记下 `sha-<短提交>` 标签（见「回滚」）。

```bash
docker compose exec db pg_dump -U postgres -Fc kioku > ~/kioku-backup/kioku-$(date +%F-%H%M%S).dump
```

`KIOKU_TAG` 写的是版本号时先改成新的版本号；是 `latest`、`X.Y` 这类标签时不用改。然后拉取新镜像并重新创建容器：

```bash
docker compose pull
docker compose up -d
```

从源码构建的拉取新代码后执行 `docker compose -f docker-compose.build.yml up -d --build`。

## 回滚

停掉服务，把已经迁移到新版本的库改名留着，建一个空库，把升级前的快照恢复进去，然后把 `.env` 的 `KIOKU_TAG` 改回升级前的版本号，执行 `docker compose up -d`（从源码构建的换回旧版本的代码，`up -d --build`）。跟着 `edge` 部署时没有版本号可改回，升级前记下现在跑的提交（镜像的 `org.opencontainers.image.revision` 标签，下面的命令打印它），回滚时把 `KIOKU_TAG` 写成 `sha-` 加它的前 7 位。

```bash
docker inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$(docker compose images -q kioku)"
```不能直接往旧库里 `pg_restore --clean`：新版本建的表和函数不在快照里，会残留下来，下次升级时迁移会因为它们已存在而失败。

```bash
docker compose stop kioku
docker compose exec db psql -U postgres -c 'ALTER DATABASE kioku RENAME TO kioku_upgraded'
docker compose exec db createdb -U postgres -O kioku kioku
docker compose exec -T db pg_restore -U postgres --exit-on-error -d kioku < ~/kioku-backup/<升级前的快照>.dump
```

恢复失败时（例如快照文件不完整）删掉新建的 `kioku`，再把 `kioku_upgraded` 改回 `kioku`，回到升级后的状态。旧版本确认正常之后再删掉 `kioku_upgraded`（`exec db dropdb -U postgres kioku_upgraded`）。

## 轮换主密钥

把现在的主密钥移到 `KIOKU_MASTER_KEY_PREVIOUS`，新生成的主密钥填进 `KIOKU_MASTER_KEY`，重启。后台会把还是旧密钥包装的数据密钥逐条换成新的包装（正文的密文不动，已删除的也换），「设置 › 实例 › 安全」里看得到还剩多少条；显示换完之后删掉 `KIOKU_MASTER_KEY_PREVIOUS` 再重启，新密钥另外保存好。没换完就去掉旧主密钥，服务会拒绝启动并提示配回去。轮换之后，之前的备份要用旧主密钥恢复。

## 配置项

| 名称 | 默认值 | 说明 |
|---|---|---|
| `DATABASE_URL` | 选填 | PostgreSQL 连接串，优先于数据目录的 `kioku.json`。都没有时只提供初始化页，在那里填数据库。角色不能是超级用户或带 `BYPASSRLS`，否则拒绝启动 |
| `KIOKU_DATA_DIR` | `apps/server/.data`（镜像里 `/data`） | 数据目录，初始化页保存的数据库连接（`kioku.json`）放在这里。命令行工具（备份、恢复、Lore 导入）没设 `DATABASE_URL` 时也从这里读 |
| `KIOKU_SETUP_CODE` | 随机生成 | 固定的初始化码（去掉空白与连字符后 16 到 128 个字符，更短时拒绝启动）。不设时等人初始化的实例每次启动随机生成一个，打印在日志里 |
| `KIOKU_MASTER_KEY` | 空 | 32 字节随机数的 base64（`openssl rand -base64 32`）。用来加密机密级记忆、Kioku 托管的凭据值、密码库连接保存的令牌与密钥，以及实例设置里嵌入接口与抽取模型的 API Key，不设置时这几项都不能用 |
| `KIOKU_MASTER_KEY_PREVIOUS` | 空 | 只在轮换主密钥期间配：旧的主密钥，见上面的「轮换主密钥」 |
| `KIOKU_COOKIE_SECURE` | `true` | 登录 Cookie 是否只走 HTTPS。浏览器在 localhost 上也接受；用局域网 HTTP 地址访问时设为 `false` |
| `KIOKU_TRUSTED_PROXIES` | `0` | 前面有几层受信任的反向代理。按层数从 `X-Forwarded-For` 右边取客户端地址；没有代理时保持 `0`，否则地址可以伪造 |
| `KIOKU_BIND` | `0.0.0.0` | 只用于 compose 文件：端口发布到哪个地址。放在反向代理后面时设为 `127.0.0.1` |
| `KIOKU_TAG` | `latest` | 只用于 `compose.yaml`：两个镜像的标签，见上面的「用发布的镜像」 |
| `PORT` | `18920` | 监听端口 |
| `KIOKU_WEB_DIR` | `apps/web/dist` | 管理界面构建产物的目录；目录不存在时只提供 API |
| `KIOKU_MIGRATIONS_DIR` | `apps/server/migrations` | 数据库迁移目录 |

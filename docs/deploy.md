# 部署与运维

服务端镜像同时托管管理界面，加上带 `pgvector` 与中文分词（`zhparser`）的 PostgreSQL，一共两个容器。配置项见文末。

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

打开 `http://<主机>:18920`，首次进入初始化页。初始化要填初始化码：服务启动时打印在日志里（`docker compose logs kioku` 里「Kioku 初始化码」那一行；也可以在 `.env` 里用 `KIOKU_SETUP_CODE` 自己指定），确认数据库后建好唯一管理员账号。之后在「设置 › 连接与终端」签发访问密钥，或运行 `npx @kioku-memory/cli` 走浏览器授权：

- MCP：`http://<主机>:18920/v1/mcp`（Streamable HTTP，`Authorization: Bearer <访问密钥>`）
- 生命周期钩子：`POST /v1/lifecycle/event`；其他接口见 `/v1/openapi.json`

## 初始化与数据库

数据库有两种给法：

- **预先配好**：设环境变量 `DATABASE_URL`（两个 compose 文件都是这样，`db` 容器首次启动时建好应用角色、库和扩展）。初始化页的第一步只显示这个连接（密码只显示已填）和检查结果，标明来自环境变量、不能修改，确认后建管理员账号。
- **在初始化页填**：不设 `DATABASE_URL`，服务照样启动，只提供初始化页（其余接口回 503）。第一步填主机、端口、库名、用户名、密码与 SSL 模式，先「检查」再「保存并接入」：服务当场接上（迁移、启动后台任务），不用重启。连接保存在数据目录的 `kioku.json`（权限 600），之后在界面上不能再改，要改就编辑这个文件或改设环境变量再重启；环境变量优先于文件。

检查的内容：能否连上（失败时只给类别：无法连接、认证失败、超时、库不存在等）；单人自托管不启用行级安全，普通应用角色与超级用户均可接入；库里必须已安装 `vector` 与 `zhparser` 两个扩展；若库里是旧架构（V2 基线之前）的表结构则拒绝接入，须清空或新建空库；只执行过迁移、还没有账号的库显示「空的 Kioku 库」，照常初始化；有非 Kioku 表时给出提醒。

手上只有超级用户时，可选「用超级用户创建」：填超级用户账号密码、要建的应用角色名和库名，Kioku 会建一个 `NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE` 的应用角色（随机密码）、建库并安装两个扩展，随后只保存应用角色的连接；超级用户密码不保存、不进日志。服务器上没有这两个扩展时用 Kioku 的 PostgreSQL 镜像（`docker/postgres`），或者自行安装 `pgvector` 与 `zhparser`。

数据目录由 `KIOKU_DATA_DIR` 指定，镜像里是 `/data`。在初始化页填数据库时要把它挂成持久的卷（两个 compose 文件里的 `kioku-data`），否则重建容器后连接丢失、又回到初始化页。

配好的数据库（环境变量或 `kioku.json`）启动时连不上：连不上、超时、认证失败、库不存在这类瞬时故障，服务照样启动，按退避自动重试（5 秒起，最多隔 60 秒），接上后自动切换为完整服务。这期间 `/v1/health` 回 503，管理界面显示「数据库不可用」和原因类别，不进初始化页，也不生成初始化码。无法自动恢复的问题直接拒绝启动并在日志写明原因：缺扩展、旧架构库结构、未知新迁移、主密钥不匹配。

初始化码只在等人初始化时生成：没有配置数据库，或者接上之后还没有账号。随机生成的码有 130 位熵，每次启动换一个，打印在日志里；建好账号后作废。码错时按客户端限流（同一客户端 15 分钟最多 5 次，IPv6 按 `/64` 算一个客户端），不设全实例上限。需要固定码（例如自动化部署）时设 `KIOKU_SETUP_CODE`，至少 16 个字符（如 `openssl rand -hex 16`）。

脚本化初始化：设好 `DATABASE_URL` 与 `KIOKU_SETUP_CODE`，服务起来后直接调接口建唯一账号，返回 201 即完成（初始化码放在请求体里，不放路径）：

```bash
curl -fsS -X POST http://127.0.0.1:18920/v1/setup \
  -H 'content-type: application/json' \
  -d "{\"setupCode\":\"$KIOKU_SETUP_CODE\",\"username\":\"admin\",\"displayName\":\"管理员\",\"password\":\"<至少 10 位>\"}"
```

## HTTPS 与反向代理

对外提供服务时在前面加 HTTPS 反向代理，`KIOKU_COOKIE_SECURE` 保持 `true`，`KIOKU_TRUSTED_PROXIES` 设为代理层数（一层就是 `1`），登录限流才能获取真实的客户端地址。同时在 `.env` 里设 `KIOKU_BIND=127.0.0.1`，端口只给本机代理访问：否则外部可以绕过代理直连并伪造 `X-Forwarded-For`。是否发 HSTS 由代理决定，服务本身不发。

## 模型配置

在「设置 › 模型」里配置至多两个 OpenAI 兼容端点，未配置时系统依然可以纯中文全文（BM25）正常运行：

- **嵌入模型**：固定 1024 维，点「测试连通」可校验接口与维度。更换或停用嵌入模型时，服务端会自动清空旧模型的向量并在后台补齐新向量；也可以手动点击「补齐向量」。
- **对话模型**：用于后台会话摘要抽取（`extract-episode`）与记忆整理建议（`dream`），以及控制定时整理开关和间隔（1–168 小时）。

保存上游模型的 API Key 依赖服务端配置 `KIOKU_MASTER_KEY`（加密存放在 `settings` 表）。

## 运维自检

在服务端容器里运行 `kioku-ctl status` 可只读检查数据库连接、角色、`vector` 与 `zhparser` 扩展、待执行迁移以及主密钥是否与库内加密数据匹配（加 `--json` 输出结构化结果，不含密码与密钥）：

```bash
docker compose exec kioku kioku-ctl status
```

## 导出、备份与清理

- **记忆导出**：在「设置 › 账号与数据」可将全部未删除记忆导出为 JSON 或 Markdown 文件，用于本地归档或迁移；导出文件不包含托管凭据明文值。
- **整库备份与恢复**：使用 PostgreSQL 原生 `pg_dump` / `pg_restore` 备份整个实例，并将 `.env` 中的 `KIOKU_MASTER_KEY` 与数据库备份分开妥善保管（丢失主密钥将无法解密库中的托管凭据与模型 API Key）：

```bash
mkdir -p ~/kioku-backup
docker compose exec db pg_dump -U postgres -Fc kioku > ~/kioku-backup/kioku-$(date +%F-%H%M%S).dump
```

- **自动清理**：后台任务每小时自动清理过期登录会话、过期浏览器授权申请、闲置超过 24 小时的对话轮次缓冲、移入回收站超过 30 天的记忆，以及已处理超过 30 天的整理建议。

## 升级与回滚

### 升级

先做一份整库快照（回滚用），再换新版本镜像，启动时自动执行前向迁移。迁移只向前：旧版本镜像遇到库里有不认识的新迁移时会拒绝启动。此外，V2 扁平基线（`0000_baseline`）不兼容旧版多圈表结构，跨大架构升级须在空库重新初始化。

用 `latest` 等可变标签时，先在 `http://<主机>:18920/v1/health` 记下当前版本号；跟着 `edge` 部署时记下镜像提交：

```bash
docker inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$(docker compose images -q kioku)"
```

然后拉取并重启：

```bash
docker compose pull
docker compose up -d
```

从源码构建的拉取新代码后执行 `docker compose -f docker-compose.build.yml up -d --build`。

### 回滚

停掉服务，将已迁移的库改名留底，建一个空库恢复升级前的快照，再把 `.env` 的 `KIOKU_TAG` 改回升级前的版本号（或 `edge` 对应的 `sha-<前7位>`）后启动。不要直接往已升级的库里 `pg_restore --clean`（新增表和函数不会删掉，会干扰下次迁移）：

```bash
docker compose stop kioku
docker compose exec db psql -U postgres -c 'ALTER DATABASE kioku RENAME TO kioku_upgraded'
docker compose exec db createdb -U postgres -O kioku kioku
docker compose exec -T db pg_restore -U postgres --exit-on-error -d kioku < ~/kioku-backup/<升级前的快照>.dump
docker compose up -d
```

确认旧版本运行正常后再删掉留底库（`docker compose exec db dropdb -U postgres kioku_upgraded`）。

## 轮换主密钥

单人实例密文规模小，主密钥轮换在服务端启动阶段**同步完成**（覆盖托管凭据 `credentials` 与 `settings` 中的模型 API Key）：

1. 把当前主密钥移到 `.env` 的 `KIOKU_MASTER_KEY_PREVIOUS`，生成新密钥（`openssl rand -base64 32`）填入 `KIOKU_MASTER_KEY`。
2. 重启服务（`docker compose up -d`）。服务启动时会在对外提供流量前将全部旧密钥包裹的数据密钥同步重封为新密钥，并在日志输出 `主密钥轮换完成：重封凭据 X 条、模型设置 Y 项`。
3. 确认启动成功且 `kioku-ctl status` 报告就绪后，从 `.env` 删除 `KIOKU_MASTER_KEY_PREVIOUS` 并再次重启，另行妥善保存新主密钥。

未完成重封就提前去掉旧主密钥时，服务会在启动校验阶段拒绝启动并提示保留 `KIOKU_MASTER_KEY_PREVIOUS`。

## 配置项

| 名称 | 默认值 | 说明 |
|---|---|---|
| `DATABASE_URL` | 选填 | PostgreSQL 连接串，优先于数据目录的 `kioku.json`。两者皆空时只提供初始化页 |
| `KIOKU_DATA_DIR` | `apps/server/.data`（镜像里 `/data`） | 数据目录，初始化页保存的数据库连接（`kioku.json`）放在这里；`kioku-ctl status` 没设 `DATABASE_URL` 时也从这里读 |
| `KIOKU_SETUP_CODE` | 随机生成 | 固定的初始化码（去掉空白与连字符后 16 到 128 个字符，更短时拒绝启动）。不设时待初始化实例每次启动随机生成并打印在日志里 |
| `KIOKU_MASTER_KEY` | 空 | 32 字节随机数的 base64（`openssl rand -base64 32`）。用于加密托管凭据值及嵌入/对话模型 API Key，不配置时这两项不可用 |
| `KIOKU_MASTER_KEY_PREVIOUS` | 空 | 仅在轮换主密钥期间配置：旧主密钥，重启完成同步重封后移除 |
| `KIOKU_COOKIE_SECURE` | `true` | 登录 Cookie 是否仅走 HTTPS。浏览器在 `localhost` 也接受；用局域网 HTTP 地址访问时设为 `false` |
| `KIOKU_TRUSTED_PROXIES` | `0` | 前方受信反向代理层数（0–10）。按层数从 `X-Forwarded-For` 右侧取客户端地址；无代理时保持 `0` |
| `KIOKU_BIND` | `0.0.0.0` | 只用于 compose 文件：端口发布地址。放在反向代理后面时设为 `127.0.0.1` |
| `KIOKU_TAG` | `latest` | 只用于 `compose.yaml`：两个镜像的标签 |
| `PORT` | `18920` | 监听端口 |
| `KIOKU_WEB_DIR` | `apps/web/dist` | 管理界面构建产物目录；目录不存在时只提供 API |
| `KIOKU_MIGRATIONS_DIR` | `apps/server/migrations` | 数据库迁移目录 |

# Kioku 服务端镜像：后端同时托管构建好的管理界面，单容器部署。数据库镜像另见 docker/postgres。
# 构建：docker build -t kioku .　　运行所需的环境变量见 README「配置项」
FROM node:22.23.4-bookworm-slim AS build
RUN npm install -g pnpm@11.2.2
WORKDIR /src
# 先只复制依赖清单，源码改动时可以复用安装依赖这一层的缓存
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/contracts/package.json packages/contracts/
RUN pnpm install --frozen-lockfile
COPY . .
# 版本、提交与构建时间在打包时写进产物（见 apps/server/src/version.ts）。构建上下文里没有 .git，由构建参数传入：
# docker build --build-arg KIOKU_VERSION=0.1.0 --build-arg KIOKU_COMMIT=<sha> --build-arg KIOKU_BUILD_TIME=<ISO 时间>
# 都没传时版本是 dev
ARG KIOKU_VERSION
ARG KIOKU_COMMIT
ARG KIOKU_BUILD_TIME
RUN pnpm --filter @kioku/server --filter @kioku/web build
# 导出只含生产依赖的独立目录：打包产物、迁移和 node_modules
RUN pnpm --filter @kioku/server deploy --prod --legacy /out

FROM node:22.23.4-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
# 目录布局与仓库一致：服务端默认从 ../migrations 读迁移、从 ../../web/dist 读管理界面
COPY --from=build /out ./server
COPY --from=build /src/apps/web/dist ./web/dist
USER node
EXPOSE 18920
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 18920) + '/v1/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "server/dist/index.mjs"]

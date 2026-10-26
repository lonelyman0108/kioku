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
RUN pnpm --filter @kioku/server --filter @kioku/web build
# 导出只含生产依赖的独立目录：打包产物、迁移和 node_modules
RUN pnpm --filter @kioku/server deploy --prod --legacy /out

FROM node:22.23.4-bookworm-slim
ARG KIOKU_VERSION=dev
ENV NODE_ENV=production KIOKU_VERSION=${KIOKU_VERSION}
WORKDIR /app
# 目录布局与仓库一致：服务端默认从 ../migrations 读迁移、从 ../../web/dist 读管理界面
COPY --from=build /out ./server
COPY --from=build /src/apps/web/dist ./web/dist
USER node
EXPOSE 18920
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 18920) + '/v1/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "server/dist/index.mjs"]

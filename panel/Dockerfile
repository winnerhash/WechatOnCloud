# 面板镜像：前端 Vite 打包 + 后端 Fastify 网关（多架构 amd64/arm64）

# --- 1) 构建前端 ---
FROM node:22-slim AS web
WORKDIR /web
# 【优化1】切换淘宝 NPM 镜像源，国内速度飞起
RUN npm config set registry https://registry.npmmirror.com
COPY web/package.json web/package-lock.json ./
# 【优化2】BuildKit 缓存挂载，把下载的包缓存在宿主机，下次构建即使 lockfile 变了也只需增量下载（配合上游 npm ci 锁版本）
RUN --mount=type=cache,target=/root/.npm \
    npm ci
COPY web/ ./
RUN npm run build

# --- 2) 后端运行时 ---
FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
# 【优化1】后端也切换淘宝源
RUN npm config set registry https://registry.npmmirror.com
COPY server/package.json server/package-lock.json ./
# 【优化2】后端同样使用缓存挂载
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev
COPY server/ ./
COPY --from=web /web/dist ./web-dist

# 构建版本号：CI 用 git tag 注入（vX.Y.Z），本地构建默认 dev。烤进镜像 → 面板运行时显示真实版本并据此检测更新。
# 放在末尾：改版本号不会破坏上面的依赖安装缓存。
ARG WOC_VERSION=dev
ENV WOC_VERSION=${WOC_VERSION} \
    STATIC_DIR=/app/web-dist \
    PORT=8080
EXPOSE 8080
CMD ["npm", "run", "start"]

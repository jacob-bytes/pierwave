# PierWave 主控镜像（多阶段构建）。
#
# 只打包主控：Agent 必须跑在宿主机上（要管 xray 进程、写 /etc/xray、重启 systemd 服务），
# 放进容器里既拿不到宿主机的 xray，也做不了进程守护。
#
#   docker build -t pierwave:latest .
#   docker run -d -p 8787:8787 -v $PWD/data:/data \
#     -e PIERWAVE_ADMIN_PASSWORD=<强密码> pierwave:latest

# ---------- 前端 ----------
FROM node:22-bookworm-slim AS web
WORKDIR /app/web
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web/ ./
RUN npm run build

# ---------- 主控 ----------
FROM rust:1-slim-bookworm AS builder
WORKDIR /app
# 先只拷 manifest，让依赖层可以缓存
COPY Cargo.toml Cargo.lock ./
COPY crates ./crates
RUN cargo build --release --locked -p pierwave-master

# ---------- 运行 ----------
FROM debian:bookworm-slim
# curl 是中转 Agent 发布产物时回源用的，运行期必须存在
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl tzdata \
 && rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/target/release/pierwave-master /usr/local/bin/pierwave-master
COPY --from=web /app/web/dist /srv/web

ENV PIERWAVE_WEB_DIR=/srv/web \
    PIERWAVE_ADDR=0.0.0.0:8787 \
    PIERWAVE_DB="sqlite:///data/pierwave.db?mode=rwc"

VOLUME ["/data"]
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD curl -fsS http://127.0.0.1:8787/api/v1/health || exit 1

ENTRYPOINT ["/usr/local/bin/pierwave-master"]

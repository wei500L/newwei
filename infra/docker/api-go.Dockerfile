# api-go 的多阶段构建生产镜像（Go-批2C：真实入口接线）。
#
# 目标：
#   1. 构建阶段用 golang 镜像编译静态二进制（CGO_ENABLED=0），
#      依赖阶段使用已提交的 go.mod/go.sum 执行 go mod download。
#   2. 构建使用 -mod=readonly（不得在镜像构建中改写依赖清单）与
#      -trimpath（二进制不含本机路径）。
#   3. 运行阶段与 vector-go 同款 distroless 静态最小镜像：无 shell、
#      无包管理器、无 Node、无源码、非 root（内置 nonroot 用户）。
#   4. 健康检查：`/api-go healthcheck` 子命令（distroless 无 curl——
#      不为探针安装任何东西，同一二进制自探活）。
#
# 注意：Go 版本以 apps/api-go/go.mod 为准（go 1.27），与 vector-go
# Dockerfile 的 GO_IMAGE 约定保持一致。
ARG GO_IMAGE=golang:1.27

FROM ${GO_IMAGE} AS builder

WORKDIR /src

# 依赖层单独先行：仅复制模块清单，命中缓存时不重复下载。
COPY apps/api-go/go.mod apps/api-go/go.sum ./apps/api-go/

WORKDIR /src/apps/api-go

# 只消费已提交的校验信息，不修改 go.mod/go.sum（漂移门禁在 CI verify）。
RUN go mod download

# 源码在依赖层之后复制——代码变更不使依赖缓存失效。
COPY apps/api-go/ ./

# CGO_ENABLED=0：静态二进制，运行阶段可用 distroless static。
# -mod=readonly + -trimpath + -ldflags "-s -w"：清单只读、路径剥离、
# 符号表剥离。
RUN CGO_ENABLED=0 go build -mod=readonly -trimpath -ldflags="-s -w" -o /out/api-go ./cmd/api

# ---- 运行阶段 ----
# distroless 静态最小镜像：无 shell、无包管理器、无 Go 工具链、无 Node、
# 非 root（内置 nonroot 用户，uid/gid 固定 65532:65532）。
# 不写入任何密钥、DSN 或环境文件——运行配置全部经容器环境注入。
FROM gcr.io/distroless/static-debian12:nonroot

COPY --from=builder /out/api-go /api-go

USER 65532:65532

EXPOSE 4020

# 容器编排层健康检查默认值。必须用 exec 形式（JSON 数组）：字符串形式
# 的 health-cmd 会经 /bin/sh -c 执行，而 distroless 没有 shell。compose
# 的 api-go 服务 healthcheck 同款命令（CMD exec 形式）；docker run /
# docker inspect 的 State.Health 直接继承本指令。
HEALTHCHECK --interval=15s --timeout=3s --retries=20 --start-period=5s CMD ["/api-go", "healthcheck"]

# 健康检查由容器编排层执行：`/api-go healthcheck`（GET 127.0.0.1:$PORT
# /__go/healthz，2xx 退出 0）。distroless 无 curl/wget——不安装任何
# 探针工具。
ENTRYPOINT ["/api-go"]

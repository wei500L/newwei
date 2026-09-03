# vector-go 的多阶段构建镜像（Strangler Fig 试点，任务 F / roadmap M2 余项 3）。
#
# 目标：
#   1. 构建阶段用 golang 镜像编译静态二进制（纯标准库，无 go.sum）。
#   2. 运行阶段用最小基础镜像 + 非 root 用户。
#   3. 健康检查：GET /healthz（compose healthcheck 同款）。
#
# 注意：Go 版本以 apps/vector-go/go.mod 为准（go 1.27）。
ARG GO_IMAGE=golang:1.27

FROM ${GO_IMAGE} AS builder

WORKDIR /src

# 仅 vector-go 模块（纯标准库、无依赖，无需模块缓存）。
COPY apps/vector-go/ ./apps/vector-go/

WORKDIR /src/apps/vector-go

# CGO_ENABLED=0：静态二进制，运行阶段可用最小基础镜像。
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/vector-go ./main.go

# ---- 运行阶段 ----
# distroless 静态最小镜像：无 shell、无包管理器、非 root（内置 nonroot 用户）。
# 若部署环境无法拉取 distroless，可替换为 gcr.io/distroless/static-debian12:nonroot。
FROM gcr.io/distroless/static-debian12:nonroot

COPY --from=builder /out/vector-go /vector-go

# distroless nonroot 的 uid/gid 固定为 65532:65532（无 shell，无法 RUN）。
USER 65532:65532

EXPOSE 4010

# 健康检查由 compose/编排层执行（distroless 无 curl/wget）。
# compose 中 vector-go 服务 healthcheck 通过宿主侧网络探测 :4010/healthz。
ENTRYPOINT ["/vector-go"]

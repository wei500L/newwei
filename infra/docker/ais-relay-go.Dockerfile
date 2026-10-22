# Multi-stage production image for ais-relay-go (Go port of the Node
# apps/ais-relay service).
#
# Goals:
#   1. The build stage compiles a static binary (CGO_ENABLED=0) with the
#      golang image; the dependency layer runs `go mod download` against the
#      committed go.mod/go.sum.
#   2. The build uses -mod=readonly (the image build must not rewrite the
#      dependency manifests) and -trimpath (no local paths in the binary).
#   3. The runtime stage uses the same distroless static image as
#      api-go.Dockerfile / vector-go.Dockerfile: no shell, no package manager,
#      no Node/npm/pnpm, no sources, non-root (built-in nonroot user). That is
#      the point of this port: the image contains only the ais-relay binary.
#   4. Healthcheck: the binary's own `healthcheck` subcommand (distroless has
#      no curl — nothing is installed for the probe; the same binary probes
#      itself).
#
# Go version follows apps/api-go/go.mod (go 1.27); GO_IMAGE mirrors
# api-go.Dockerfile.
ARG GO_IMAGE=golang:1.27

FROM ${GO_IMAGE} AS builder

WORKDIR /src

# Dependency layer first: only the module manifests, so code changes do not
# invalidate the module cache.
COPY apps/api-go/go.mod apps/api-go/go.sum ./apps/api-go/

WORKDIR /src/apps/api-go

# Only the committed checksums are consumed; go.mod/go.sum stay read-only
# (the drift gate runs in CI verify).
RUN go mod download

# Sources are copied after the dependency layer.
COPY apps/api-go/ ./

# CGO_ENABLED=0: static binary so the runtime stage can use distroless static.
# -mod=readonly + -trimpath + -ldflags "-s -w": read-only manifests, stripped
# paths and symbol table. Single command: ./cmd/ais-relay.
RUN CGO_ENABLED=0 go build -mod=readonly -trimpath -ldflags="-s -w" -o /out/ais-relay ./cmd/ais-relay

# ---- runtime stage ----
# distroless static: no shell, no package manager, no Go toolchain, no Node,
# non-root (built-in nonroot user, uid/gid fixed at 65532:65532). The base
# image already ships CA roots, so wss:// AISStream upstreams work as is.
# No secret or env file is baked in — AISSTREAM_API_KEY and friends are
# injected through the container environment; a missing required key makes the
# process exit non-zero at startup.
FROM gcr.io/distroless/static-debian12:nonroot

COPY --from=builder /out/ais-relay /ais-relay

USER 65532:65532

# Default listen port of the Go server: PORT (alias AIS_RELAY_PORT) defaults to
# 3004; AIS_RELAY_HOST (alias HOST) defaults to 0.0.0.0.
EXPOSE 3004

# Orchestrator-facing default. Exec form (JSON array) is required: a string
# health-cmd would run through /bin/sh -c, which distroless does not have.
# healthcheck performs an HTTP GET on http://127.0.0.1:$PORT/healthz/live and
# exits 0 only on HTTP 200. The compose service ais-relay-go uses the same
# command.
HEALTHCHECK --interval=15s --timeout=3s --retries=20 --start-period=5s CMD ["/ais-relay", "healthcheck"]

ENTRYPOINT ["/ais-relay"]

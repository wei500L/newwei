// vector-go 是 apps/vector（NestJS Qdrant 适配器）的 Go 试点重写（Strangler Fig 迁移序 1）。
//
// 契约等价目标：POST /v1/upsert、POST /v1/search、GET /healthz 三个端点的
// 请求/响应/错误形状与 apps/vector 完全一致——调用方（packages/vector-client）
// 无需任何修改即可切换。差分细节见 docs/refactor/api-contract-inventory.md。
//
// 回滚开关：本服务与 NestJS 版可并行部署（不同端口）。上游 api 通过
// vector 服务配置（VECTOR_SERVICE_URL / 系统设置）指向其一；回滚 = 把
// baseUrl 指回 NestJS 版（默认 :4010），无数据迁移耦合（共用同一 Qdrant
// 集合命名与 point ID 算法）。
package main

import (
	"context"
	"errors"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"github.com/wei500L/newwei/apps/vector-go/internal/config"
	"github.com/wei500L/newwei/apps/vector-go/internal/httpapi"
	"github.com/wei500L/newwei/apps/vector-go/internal/qdrant"
)

func main() {
	if err := run(); err != nil {
		log.Fatalf("vector-go: %v", err)
	}
}

func run() error {
	cfg, err := config.LoadFromOS()
	if err != nil {
		return err
	}

	client := qdrant.New(qdrant.Options{
		BaseURL:          cfg.QdrantURL,
		APIKey:           cfg.QdrantAPIKey,
		TimeoutMs:        cfg.QdrantTimeoutMs,
		CollectionPrefix: cfg.CollectionPrefix,
	})
	handler := httpapi.New(httpapi.Deps{
		InternalToken: cfg.InternalToken,
		Qdrant:        client,
	})

	server := &http.Server{
		Addr:              ":" + strconv.Itoa(cfg.Port),
		Handler:           handler,
		ReadHeaderTimeout: 10 * time.Second,
	}

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)

	serverErr := make(chan error, 1)
	go func() {
		log.Printf("vector-go: listening on %s (env=%s)", server.Addr, cfg.NodeEnv)
		serverErr <- server.ListenAndServe()
	}()

	select {
	case err := <-serverErr:
		if err != nil && !errors.Is(err, http.ErrServerClosed) {
			return err
		}
		return nil
	case sig := <-stop:
		log.Printf("vector-go: received %s, shutting down", sig)
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		return server.Shutdown(ctx)
	}
}

// api-go 是主后端的 Go 网关骨架（Strangler Fig，见 docs/refactor/go-migration-adr.md）。
//
// 骨架阶段行为：全部流量反向代理到 NestJS apps/api（LEGACY_API_URL，默认
// http://localhost:4000）；仅 /__go/healthz 由 Go 原生应答（网关自身存活与
// 路由表自省）。首个迁移单元（vector 只读端点试点）落地后再引入 shadow/canary。
//
// 回滚：入口把流量指回 NestJS（或本网关把对应路由规则改回 legacy）即回滚，
// 无数据耦合。
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

	"github.com/wei500L/newwei/apps/api-go/internal/config"
	"github.com/wei500L/newwei/apps/api-go/internal/httpx"
	"github.com/wei500L/newwei/apps/api-go/internal/legacyproxy"
)

func main() {
	if err := run(); err != nil {
		log.Fatalf("api-go: %v", err)
	}
}

func run() error {
	cfg, err := config.LoadFromOS()
	if err != nil {
		return err
	}

	gateway, err := legacyproxy.New(cfg.LegacyAPIURL, legacyproxy.DefaultRules())
	if err != nil {
		return err
	}
	// 骨架阶段唯一的 Go 原生端点：网关存活探针 + 路由表自省。
	gateway.SetGoHandler(func(w http.ResponseWriter, r *http.Request) {
		routes := make([]map[string]string, 0, len(gateway.Rules()))
		for _, rule := range gateway.Rules() {
			routes = append(routes, map[string]string{"prefix": rule.Prefix, "mode": string(rule.Mode)})
		}
		httpx.WriteJSON(w, http.StatusOK, map[string]any{
			"ok":     true,
			"routes": routes,
		})
	})

	handler := httpx.TraceMiddleware(gateway)
	server := &http.Server{
		Addr:              ":" + strconv.Itoa(cfg.Port),
		Handler:           handler,
		ReadHeaderTimeout: 10 * time.Second,
	}

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)

	serverErr := make(chan error, 1)
	go func() {
		log.Printf("api-go: listening on %s (legacy=%s)", server.Addr, cfg.LegacyAPIURL)
		serverErr <- server.ListenAndServe()
	}()

	select {
	case err := <-serverErr:
		if err != nil && !errors.Is(err, http.ErrServerClosed) {
			return err
		}
		return nil
	case sig := <-stop:
		log.Printf("api-go: received %s, shutting down", sig)
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		return server.Shutdown(ctx)
	}
}

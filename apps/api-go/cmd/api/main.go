// api-go 是主后端的 Go 网关（Strangler Fig，见 docs/refactor/go-migration-adr.md）。
//
// 默认全部流量反向代理到 NestJS apps/api（LEGACY_API_URL，默认
// http://localhost:4000）。已迁移路由按四态路由表分流：
//
//	legacy — 反向代理（当前事实源）
//	shadow — NestJS 响应 + Go 实现异步差分（首个单元：/api/healthz/live）
//	canary — orgId 稳定哈希小比例真实流量切 Go（CANARY_PERCENT）
//	go     — Go 原生 handler（当前仅 /__go/healthz 自省）
//
// 回滚：路由表单条规则改回 legacy（配置/代码变更），或 CANARY_PERCENT=0
// ——无数据迁移耦合。
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

	"github.com/wei500L/newwei/apps/api-go/internal/canary"
	"github.com/wei500L/newwei/apps/api-go/internal/config"
	"github.com/wei500L/newwei/apps/api-go/internal/health"
	"github.com/wei500L/newwei/apps/api-go/internal/httpx"
	"github.com/wei500L/newwei/apps/api-go/internal/legacyproxy"
	"github.com/wei500L/newwei/apps/api-go/internal/shadow"
)

func main() {
	if err := run(); err != nil {
		log.Fatalf("api-go: %v", err)
	}
}

// dispatcher 装配 shadow runner 与 canary router，实现网关的旁路接口。
type dispatcher struct {
	shadowRunner *shadow.Runner
	canaryRouter *canary.Router
}

func (d *dispatcher) ObserveShadow(r *http.Request, legacyStatus int, legacyHeader http.Header, legacyBody []byte) {
	// health live 的 Go 实现直接给出确定结果（真实端点行为，无假数据）。
	// 只有该路由的请求会被路由表送进 shadow 态，这里无需再分派。
	if r.URL.Path != "/api/healthz/live" {
		return
	}
	d.shadowRunner.ObserveResult(
		httpx.TraceIDFromContext(r.Context()),
		r,
		legacyStatus,
		legacyHeader,
		legacyBody,
		healthLiveExecutant{},
	)
}

func (d *dispatcher) CanaryRoute(r *http.Request) bool {
	return d.canaryRouter.Route(r.Header.Get("Authorization")) == canary.ModeGo
}

// healthLiveExecutant 是 GET /api/healthz/live 的 Go 实现（shadow 差分执行者）。
type healthLiveExecutant struct{}

func (healthLiveExecutant) Execute(ctx context.Context, r *http.Request, _ []byte) *shadow.Result {
	_ = ctx
	_ = r
	result := health.LiveResult()
	return &shadow.Result{
		StatusCode: result.StatusCode,
		Header:     result.Header,
		Body:       result.Body,
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

	disp := &dispatcher{
		shadowRunner: shadow.NewRunner(shadow.Budget{
			TimeoutMs:   cfg.ShadowTimeoutMs,
			MaxBodyByte: cfg.ShadowMaxBodyByte,
			MaxInflight: cfg.ShadowMaxInflight,
			MaxPerMin:   cfg.ShadowMaxPerMin,
		}),
		canaryRouter: canary.NewRouter(cfg.CanaryPercent),
	}

	// /__go/healthz：网关存活探针 + 路由表与 shadow/canary 状态自省。
	gateway.SetGoHandler(func(w http.ResponseWriter, _ *http.Request) {
		routes := make([]map[string]string, 0, len(gateway.Rules()))
		for _, rule := range gateway.Rules() {
			routes = append(routes, map[string]string{"prefix": rule.Prefix, "mode": string(rule.Mode)})
		}
		httpx.WriteJSON(w, http.StatusOK, map[string]any{
			"ok":     true,
			"routes": routes,
			"shadow": disp.shadowRunner.Stats(),
			"canary": map[string]int{"percent": disp.canaryRouter.Percent()},
		})
	})

	// 首个迁移单元的 go 模式 handler（canary 命中时使用；与 shadow 执行的
	// 是同一实现，保证差分通过即切换可信）。
	gateway.RegisterGoHandler("/api/healthz/live", health.LiveHandler)

	handler := httpx.TraceMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gateway.ServeHTTPWithShadow(w, r, disp)
	}))
	server := &http.Server{
		Addr:              ":" + strconv.Itoa(cfg.Port),
		Handler:           handler,
		ReadHeaderTimeout: 10 * time.Second,
	}

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)

	serverErr := make(chan error, 1)
	go func() {
		log.Printf(
			"api-go: listening on %s (legacy=%s, canary=%d%%)",
			server.Addr, cfg.LegacyAPIURL, cfg.CanaryPercent,
		)
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

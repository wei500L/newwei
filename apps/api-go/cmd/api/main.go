// api-go 是主后端的 Go 网关（Strangler Fig，见 docs/refactor/go-migration-adr.md）。
//
// 默认全部流量反向代理到 NestJS apps/api（LEGACY_API_URL，默认
// http://localhost:4000）。已迁移路由按四态路由表分流：
//
//	legacy — 反向代理（当前事实源）
//	shadow — NestJS 响应 + Go 实现异步差分（首个单元：/api/healthz/live）
//	canary — 已验证身份的稳定哈希小比例真实流量切 Go（CANARY_PERCENT）
//	go     — Go 原生 handler（当前仅 /__go/healthz 自省）
//
// 回滚：路由表单条规则改回 legacy（配置/代码变更），或 CANARY_PERCENT=0
// ——无数据迁移耦合。
//
// canary 信任边界（重要）：当前分流的 orgId 取自未验签的 JWT payload
// claim，不是经过认证的组织身份。在 Go 侧完成真实 JWT 验签与 org
// membership 重推导（迁移序 5）之前，受保护业务路由不得依赖该 claim
// 进入 Go——fail-safe 一律回 legacy。当前没有任何路由处于 ModeCanary，
// canary 仅作为待鉴权基础设施接入的分流组件存在。
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

// ObserveShadow 实现网关的差分观察接口。reason 非空时主链路已判定无法
// 差分（请求/响应超预算或流式响应）——只记账，不执行 Go 实现。
func (d *dispatcher) ObserveShadow(r *http.Request, legacyStatus int, legacyHeader http.Header, legacyBody []byte, reason legacyproxy.ShadowSkipReason) {
	switch legacyproxy.ShadowSkipReason(reason) {
	case legacyproxy.ShadowSkipRequestTooLarge,
		legacyproxy.ShadowSkipResponseTooLarge,
		legacyproxy.ShadowSkipStreaming:
		d.shadowRunner.ObserveSkip(shadow.SkipReason(reason))
		return
	}

	// 差分可执行：只有注册进 shadow 态的路由会到达这里；按路由分发
	// 对应的 Go 实现（health live 是真实端点行为，无假数据）。
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

// CanaryRoute 实现网关的 canary 分流接口。
//
// 信任边界：orgId claim 未验签。canaryRouter 的 fail-safe 语义（无 token/
// 非 JWT/无 claim → legacy）防的是「无法解析」，防不了「伪造」——伪造的
// orgId 可以选择自己这条请求进哪个实现。因此该接口只可用于：
//  1. 两个实现共享同一鉴权语义的路由（当前仅差分验证过的只读端点）；
//  2. 或在 Go 侧完成验签后（迁移序 5）再启用。
//
// 当前没有任何路由处于 ModeCanary。
func (d *dispatcher) CanaryRoute(r *http.Request) bool {
	return d.canaryRouter.Route(r.Header.Get("Authorization")) == canary.ModeGo
}

// healthLiveExecutant 是 GET /api/healthz/live 的 Go 实现（shadow 差分执行者）。
type healthLiveExecutant struct{}

func (healthLiveExecutant) Execute(_ context.Context, _ *http.Request, _ []byte) *shadow.Result {
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
	gateway.SetShadowBudget(legacyproxy.ShadowBudget{
		MaxRequestBodyByte:     cfg.ShadowMaxRequestBodyByte,
		MaxResponseCaptureByte: cfg.ShadowMaxResponseCaptureByte,
	})

	disp := &dispatcher{
		shadowRunner: shadow.NewRunner(shadow.Budget{
			TimeoutMs:            cfg.ShadowTimeoutMs,
			MaxRequestBodyByte:   cfg.ShadowMaxRequestBodyByte,
			MaxInflight:          cfg.ShadowMaxInflight,
			MaxPerMin:            cfg.ShadowMaxPerMin,
			DebugBodyLog:         cfg.ShadowDebugBodyLog,
			DebugBodyLogMaxBytes: cfg.ShadowDebugBodyLogMaxBytes,
		}),
		// 生产装配不开 AllowUnverifiedIdentity：未验签 orgId claim 不得
		// 作为受保护路由的分流依据。CANARY_PERCENT 因此当前只是预留——
		// 没有任何路由处于 ModeCanary（见 DefaultRules）。
		canaryRouter: canary.NewRouter(canary.Options{Percent: cfg.CanaryPercent}),
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

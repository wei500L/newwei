// api-go 是主后端的 Go 网关（Strangler Fig，见 docs/refactor/go-migration-adr.md）。
//
// 默认全部流量反向代理到 NestJS apps/api（LEGACY_API_URL，默认
// http://localhost:4000）。已迁移路由按四态路由表分流：
//
//	legacy — 反向代理（当前事实源）
//	shadow — NestJS 响应 + Go 实现异步差分（/api/healthz/live 与三个
//	         user-settings 只读 GET：onboarding / rss-reader /
//	         spacetime-timeline）
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
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/canary"
	"github.com/wei500L/newwei/apps/api-go/internal/config"
	"github.com/wei500L/newwei/apps/api-go/internal/health"
	"github.com/wei500L/newwei/apps/api-go/internal/httpx"
	"github.com/wei500L/newwei/apps/api-go/internal/legacyproxy"
	"github.com/wei500L/newwei/apps/api-go/internal/shadow"
	"github.com/wei500L/newwei/apps/api-go/internal/shadowidentity"
	"github.com/wei500L/newwei/apps/api-go/internal/usersettings"
)

func main() {
	// healthcheck 子命令：容器内健康探测（distroless 无 curl/wget——
	// 生产镜像用同一二进制自探活，见 infra/docker/api-go.Dockerfile）。
	// 仅当 argv[1] 恰为 "healthcheck" 时进入；其余 argv 保持原启动语义。
	if len(os.Args) > 1 && os.Args[1] == "healthcheck" {
		os.Exit(runHealthcheck())
	}
	if err := run(); err != nil {
		log.Fatalf("api-go: %v", err)
	}
}

// runHealthcheck 以短超时 GET 本进程监听地址上的 /__go/healthz（网关
// Go 原生自省端点——不经过 legacy 代理，也不产生 shadow 执行，不会
// 污染差分指标）。返回值即进程退出码：2xx → 0；其他状态码、连接
// 失败或超时 → 1。不读取/输出环境变量、DSN、token 或响应正文——
// 失败时只报状态码这一类通用事实。
func runHealthcheck() int {
	port := "4020"
	if raw := strings.TrimSpace(os.Getenv("PORT")); raw != "" {
		if value, err := strconv.Atoi(raw); err == nil && value > 0 {
			port = raw
		}
	}
	client := &http.Client{Timeout: 3 * time.Second}
	resp, err := client.Get("http://127.0.0.1:" + port + "/__go/healthz")
	if err != nil {
		fmt.Fprintln(os.Stderr, "api-go healthcheck: request failed")
		return 1
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		fmt.Fprintf(os.Stderr, "api-go healthcheck: unexpected status %d\n", resp.StatusCode)
		return 1
	}
	return 0
}

// dispatcher 装配 shadow runner 与 canary router，实现网关的旁路接口。
type dispatcher struct {
	shadowRunner *shadow.Runner
	canaryRouter *canary.Router
	// shadowUnits 是显式的 shadow 路由分发表（替代逐路由硬编码 if）。
	// 每个单元声明：精确 path、允许的 method、是否要求 legacy 200、
	// executant。四个单元的规模——刻意不做成注册框架。
	shadowUnits []shadowUnit
}

// shadowUnit 是一个 shadow 差分单元的接线声明。
type shadowUnit struct {
	// Path 精确匹配（不做前缀匹配——/api/user-settings/ui/onboarding-x
	// 不得误入）。
	Path string
	// Methods 允许进入差分的方法白名单（写方法绝不双发；双层强制之一）。
	Methods map[string]bool
	// RequireLegacyOK 要求 NestJS 返回 200 才执行（legacy-approved
	// shadow identity 的前提；公开探针不需要）。
	RequireLegacyOK bool
	// Executant Go 侧差分执行者。
	Executant shadow.Executant
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

	// 差分可执行：按 shadow 单元表精确分发（path + method + legacy 语义
	// 全部匹配才执行，否则静默跳过——该路由不在 shadow 单元表里）。
	for _, unit := range d.shadowUnits {
		if r.URL.Path != unit.Path {
			continue
		}
		if !unit.Methods[strings.ToUpper(r.Method)] {
			return
		}
		if unit.RequireLegacyOK && legacyStatus != http.StatusOK {
			// legacy 未认可身份（401/403/404/5xx 等）→ Go 零执行、零
			// 数据库查询。
			return
		}
		d.shadowRunner.ObserveResult(
			httpx.TraceIDFromContext(r.Context()),
			r,
			legacyStatus,
			legacyHeader,
			legacyBody,
			unit.Executant,
		)
		return
	}
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

// userSettingsExecutant 是三个 user-settings 只读 GET（onboarding /
// rss-reader / spacetime-timeline）共享的 Go shadow 差分执行者
//（Go-批2A 起步，批2B 扩展——三端点信任边界与失败语义完全相同，
// 流程只写一次，各端点注入固定 key 的查询与响应构建）。
//
// 信任边界：身份来自 legacy-approved shadow identity——只有 legacy 已
// 返回 200 时才允许从（未验签的）Bearer JWT payload 读取 sub/orgId，
// 并只用于本次只读查询。这不是「Go 已验证身份」：Go 尚未完成 JWT 验签、
// jti blacklist、membership 重推导与 RBAC。permissions claim 不读取。
// 任何失败（payload 解析、数据库不可达、JSON 异常）都只返回通用错误
// Result（503 + 通用错误体），由 runner 记入差分——不影响客户端已收到
// 的 NestJS 响应。token/orgId/userId 不进入任何日志或差分正文。
type userSettingsExecutant struct {
	// repo 为 nil 表示未配置数据库：跳过（零查询），以通用错误 Result
	// 记入差分缺失——不影响客户端。
	repo usersettings.Repository
	// query 是该端点固定 key 的只读查询（编译期固定 SettingKey，
	// 不来自 URL/query/body/header）。
	query func(ctx context.Context, orgID, userID string) (usersettings.Record, error)
	// build 由数据库记录构建完整响应体（各端点自己的 normalization）。
	build func(record usersettings.Record) any
}

func (e userSettingsExecutant) Execute(ctx context.Context, r *http.Request, _ []byte) *shadow.Result {
	if e.repo == nil {
		return shadowErrorResult()
	}
	identity := shadowidentity.LegacyApprovedIdentity(r, http.StatusOK)
	if identity == nil {
		// dispatcher 已在 legacy 非 200 时拦截；这里的 nil 只可能来自
		// token 缺失/损坏——同样零数据库查询。
		return shadowErrorResult()
	}

	record, err := e.query(ctx, identity.OrgID, identity.UserID)
	if err != nil {
		// 详细错误只进服务端日志（repo 已保证不含凭据），差分结果只给
		// 通用错误体。
		log.Printf("shadow: user-settings query failed: %v", err)
		return shadowErrorResult()
	}

	body, err := json.Marshal(e.build(record))
	if err != nil {
		return shadowErrorResult()
	}
	body = append(body, '\n')
	return &shadow.Result{
		StatusCode: http.StatusOK,
		Header:     http.Header{"Content-Type": []string{"application/json"}, "Cache-Control": []string{"no-store"}},
		Body:       body,
	}
}

// userSettingsShadowUnits 是三个 user-settings 只读 GET 的 shadow 单元：
// 精确 path（不做前缀匹配）+ 仅 GET + RequireLegacyOK（legacy 200 是
// 身份前提）。query 闭包绑定各自端点的 repository 语义方法（key 是
// usersettings 包内的编译期常量）。
func userSettingsShadowUnits(repo usersettings.Repository) []shadowUnit {
	return []shadowUnit{
		{
			Path:            "/api/user-settings/ui/onboarding",
			Methods:         map[string]bool{http.MethodGet: true},
			RequireLegacyOK: true, // 受保护端点：legacy 200 是身份前提
			Executant:       userSettingsExecutant{
				repo: repo,
				query: func(ctx context.Context, orgID, userID string) (usersettings.Record, error) {
					return repo.FindOnboarding(ctx, orgID, userID)
				},
				build: func(record usersettings.Record) any {
					return usersettings.BuildOnboardingResponse(record)
				},
			},
		},
		{
			Path:            "/api/user-settings/ui/rss-reader",
			Methods:         map[string]bool{http.MethodGet: true},
			RequireLegacyOK: true, // 受保护端点：legacy 200 是身份前提
			Executant:       userSettingsExecutant{
				repo: repo,
				query: func(ctx context.Context, orgID, userID string) (usersettings.Record, error) {
					return repo.FindRSSReader(ctx, orgID, userID)
				},
				build: func(record usersettings.Record) any {
					return usersettings.BuildRSSReaderResponse(record)
				},
			},
		},
		{
			Path:            "/api/user-settings/ui/spacetime-timeline",
			Methods:         map[string]bool{http.MethodGet: true},
			RequireLegacyOK: true, // 受保护端点：legacy 200 是身份前提
			Executant:       userSettingsExecutant{
				repo: repo,
				query: func(ctx context.Context, orgID, userID string) (usersettings.Record, error) {
					return repo.FindSpacetimeTimeline(ctx, orgID, userID)
				},
				build: func(record usersettings.Record) any {
					return usersettings.BuildSpacetimeTimelineResponse(record)
				},
			},
		},
	}
}

// shadowErrorResult 是 Go 侧执行失败的通用差分结果（不含任何身份/凭据/
// 业务数据；进入差分记录成为「执行缺失」信号）。
func shadowErrorResult() *shadow.Result {
	return &shadow.Result{
		StatusCode: http.StatusServiceUnavailable,
		Header:     http.Header{"Content-Type": []string{"application/json"}},
		Body:       []byte(`{"statusCode":503,"message":"user-settings shadow execution unavailable"}` + "\n"),
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

	// user-settings shadow 的数据库能力（非阻断）：无 DATABASE_URL 时不配置，
	// 网关照常启动代理；差分执行时发现未配置即跳过（不查询、不失败上抛）。
	var userSettingsRepo usersettings.Repository
	userSettingsDBStatus := "unconfigured"
	if cfg.DatabaseURL != "" {
		db, err := usersettings.OpenMySQLFromURL(cfg.DatabaseURL)
		if err != nil {
			// DSN 无效不阻断启动：网关继续纯代理，shadow 单元执行时跳过。
			log.Printf("api-go: user-settings shadow database not initialized (invalid DATABASE_URL): %v", err)
			userSettingsDBStatus = "invalid"
		} else {
			// sql.Open 是惰性初始化：只代表 DSN 成功解析为 driver 配置，
			// 不证明数据库可连接。连接性由真实查询按需建立（失败只影响
			// shadow 差分，不影响 legacy 响应）——不引入启动 Ping/探针/
			// 重试，数据库连通性也不是网关的存活条件。
			userSettingsRepo = usersettings.NewMySQLRepository(db)
			userSettingsDBStatus = "configured"
		}
	}

	disp := &dispatcher{
		shadowUnits: append([]shadowUnit{
			{
				Path:            "/api/healthz/live",
				Methods:         map[string]bool{http.MethodGet: true},
				RequireLegacyOK: false, // 公开探针：无需 legacy 认可身份
				Executant:       healthLiveExecutant{},
			},
		}, userSettingsShadowUnits(userSettingsRepo)...),
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
	// user-settings shadow 状态只报配置类别（unconfigured/invalid/configured
	// ——configured 表示 DSN 已解析为 driver 配置，不承诺可连接），不含
	// DSN/host/凭据/数据库错误详情。字段名 userSettingsShadow 覆盖三个
	// 只读 GET 共用的同一 repository（Go-批2A 时叫 onboardingShadow，
	// 批2B 起更名——全仓唯一消费者是本文件与 README，无外部契约）。
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
			"userSettingsShadow": map[string]string{
				"database": userSettingsDBStatus,
			},
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

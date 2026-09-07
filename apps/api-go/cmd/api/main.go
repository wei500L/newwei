// api-go 是主后端的 Go 网关（Strangler Fig，见 docs/refactor/go-migration-adr.md）。
//
// 默认全部流量反向代理到 NestJS apps/api（LEGACY_API_URL，默认
// http://localhost:4000）。已迁移路由按四态路由表分流：
//
//	legacy — 反向代理（当前事实源）
//	shadow — NestJS 响应 + Go 实现异步差分（/api/healthz/live 与
//	         user-settings 只读 GET：rss-reader / spacetime-timeline；
//	         onboarding 在 shadow 模式下亦然）
//	canary — 已验证身份的稳定哈希小比例真实流量切 Go（CANARY_PERCENT）
//	go     — Go 原生 handler（/__go/healthz 自省；以及
//	         API_GO_USER_SETTINGS_READ_MODE=go 时的六个
//	         GET /api/user-settings/ui/*——Go-批3B：onboarding/rss-reader/
//	         spacetime-timeline/war-map/newsnow/situation-monitor 全部由
//	         统一 handler Go 接管：Go 独立 JWT 验签 + Redis blacklist +
//	         MySQL RBAC + 独立响应，不依赖 NestJS 200。兼容：
//	         API_GO_ONBOARDING_MODE=go（批3A，readMode 未设时）只接管
//	         onboarding）
//
// 回滚：API_GO_USER_SETTINGS_READ_MODE=shadow（或未设——回到
// API_GO_ONBOARDING_MODE 控制；或路由表单条规则改回 legacy，或
// CANARY_PERCENT=0）——无数据迁移耦合。
//
// canary 信任边界（重要）：当前分流的 orgId 取自未验签的 JWT payload
// claim，不是经过认证的组织身份。在 Go 侧对全部受保护路由完成真实
// JWT 验签与 org membership 重推导之前，canary 不得承载业务流量
// （fail-safe 一律回 legacy）。当前没有任何路由处于 ModeCanary，
// canary 仅作为待鉴权基础设施接入的分流组件存在。
package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/wei500L/newwei/apps/api-go/internal/authhttp"
	"github.com/wei500L/newwei/apps/api-go/internal/authn"
	"github.com/wei500L/newwei/apps/api-go/internal/authz"
	"github.com/wei500L/newwei/apps/api-go/internal/canary"
	"github.com/wei500L/newwei/apps/api-go/internal/config"
	"github.com/wei500L/newwei/apps/api-go/internal/health"
	"github.com/wei500L/newwei/apps/api-go/internal/httpx"
	"github.com/wei500L/newwei/apps/api-go/internal/legacyproxy"
	"github.com/wei500L/newwei/apps/api-go/internal/shadow"
	"github.com/wei500L/newwei/apps/api-go/internal/shadowidentity"
	"github.com/wei500L/newwei/apps/api-go/internal/usersettings"
	"github.com/wei500L/newwei/apps/api-go/internal/usersettingsread"
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

// userSettingsExecutant 是六个 user-settings 只读 GET 共享的 Go shadow
// 差分执行者（Go-批2A 起步，批2B/3B 扩展——全部端点信任边界与失败语义
// 完全相同，流程只写一次，各端点注入固定 key 的查询与响应构建）。
//
// 信任边界：身份来自 legacy-approved shadow identity——只有 legacy 已
// 返回 200 时才允许从（未验签的）Bearer JWT payload 读取 sub/orgId，
// 并只用于本次只读查询。这不是「Go 已验证身份」：shadow 模式是回滚
// 兼容路径，Go 独立鉴权由 usersettingsread.Handler 承载（go 模式）。
// permissions claim 不读取。任何失败（payload 解析、数据库不可达、JSON
// 异常）都只返回通用错误 Result（503 + 通用错误体），由 runner 记入
// 差分——不影响客户端已收到的 NestJS 响应。token/orgId/userId 不进入
// 任何日志或差分正文。
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

// userSettingsShadowUnits 是 user-settings 只读 GET 的 shadow 单元表：
// 精确 path（不做前缀匹配）+ 仅 GET + RequireLegacyOK（legacy 200 是
// 身份前提）。query 闭包绑定各自端点的 repository 语义方法（key 是
// usersettings 包内的编译期常量）。五个单 key 端点共用
// userSettingsExecutant 流程（表驱动接线）；situation-monitor 是三记录
// 聚合形态，单独 executant（Go-批3B）。
func userSettingsShadowUnits(repo usersettings.Repository) []shadowUnit {
	singleKeyUnits := []struct {
		path  string
		query func(ctx context.Context, orgID, userID string) (usersettings.Record, error)
		build func(record usersettings.Record) any
	}{
		{"/api/user-settings/ui/onboarding",
			func(ctx context.Context, orgID, userID string) (usersettings.Record, error) {
				return repo.FindOnboarding(ctx, orgID, userID)
			},
			func(record usersettings.Record) any { return usersettings.BuildOnboardingResponse(record) }},
		{"/api/user-settings/ui/rss-reader",
			func(ctx context.Context, orgID, userID string) (usersettings.Record, error) {
				return repo.FindRSSReader(ctx, orgID, userID)
			},
			func(record usersettings.Record) any { return usersettings.BuildRSSReaderResponse(record) }},
		{"/api/user-settings/ui/spacetime-timeline",
			func(ctx context.Context, orgID, userID string) (usersettings.Record, error) {
				return repo.FindSpacetimeTimeline(ctx, orgID, userID)
			},
			func(record usersettings.Record) any { return usersettings.BuildSpacetimeTimelineResponse(record) }},
		{"/api/user-settings/ui/war-map",
			func(ctx context.Context, orgID, userID string) (usersettings.Record, error) {
				return repo.FindWarMap(ctx, orgID, userID)
			},
			func(record usersettings.Record) any { return usersettings.BuildWarMapResponse(record) }},
		{"/api/user-settings/ui/newsnow",
			func(ctx context.Context, orgID, userID string) (usersettings.Record, error) {
				return repo.FindNewsnow(ctx, orgID, userID)
			},
			func(record usersettings.Record) any { return usersettings.BuildNewsnowResponse(record) }},
	}
	units := make([]shadowUnit, 0, len(singleKeyUnits)+1)
	for _, unit := range singleKeyUnits {
		units = append(units, shadowUnit{
			Path:            unit.path,
			Methods:         map[string]bool{http.MethodGet: true},
			RequireLegacyOK: true, // 受保护端点：legacy 200 是身份前提
			Executant: userSettingsExecutant{
				repo:  repo,
				query: unit.query,
				build: unit.build,
			},
		})
	}
	// situation-monitor：一次三 key 聚合查询（Go-批3B）。
	units = append(units, shadowUnit{
		Path:            "/api/user-settings/ui/situation-monitor",
		Methods:         map[string]bool{http.MethodGet: true},
		RequireLegacyOK: true,
		Executant:       situationMonitorExecutant{repo: repo},
	})
	return units
}

// situationMonitorExecutant 是 situation-monitor GET 的 shadow 差分执行者
//（三记录聚合形态——userSettingsExecutant 是单记录形态，不强行复用）。
type situationMonitorExecutant struct {
	repo usersettings.Repository
}

func (e situationMonitorExecutant) Execute(ctx context.Context, r *http.Request, _ []byte) *shadow.Result {
	if e.repo == nil {
		return shadowErrorResult()
	}
	identity := shadowidentity.LegacyApprovedIdentity(r, http.StatusOK)
	if identity == nil {
		return shadowErrorResult()
	}
	records, err := e.repo.FindSituationMonitor(ctx, identity.OrgID, identity.UserID)
	if err != nil {
		log.Printf("shadow: situation-monitor query failed: %v", err)
		return shadowErrorResult()
	}
	body, err := json.Marshal(usersettings.BuildSituationMonitorResponse(records))
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

	// onboarding 迁移单元的路由模式（API_GO_ONBOARDING_MODE）：
	// shadow（默认，旧行为）或 go（Go-批3A 真实接管）。
	onboardingMode := legacyproxy.ModeShadow
	if cfg.OnboardingMode == config.OnboardingModeGo {
		onboardingMode = legacyproxy.ModeGo
	}
	// user-settings 六个只读 GET 的统一读模式（API_GO_USER_SETTINGS_READ_MODE，
	// Go-批3B）：空 = 兼容旧行为（onboardingMode 单独控制 onboarding）；
	// go = 六个 GET 全部 Go 接管；shadow = 六个 GET 全部 shadow。
	// 配置层已校验合法值。
	readMode := ""
	switch cfg.UserSettingsReadMode {
	case config.UserSettingsReadModeGo:
		readMode = string(legacyproxy.ModeGo)
	case config.UserSettingsReadModeShadow:
		readMode = string(legacyproxy.ModeShadow)
	}

	gateway, err := legacyproxy.New(cfg.LegacyAPIURL, legacyproxy.DefaultRules(onboardingMode, readMode))
	if err != nil {
		return err
	}
	gateway.SetShadowBudget(legacyproxy.ShadowBudget{
		MaxRequestBodyByte:     cfg.ShadowMaxRequestBodyByte,
		MaxResponseCaptureByte: cfg.ShadowMaxResponseCaptureByte,
	})

	// user-settings shadow 的数据库能力（非阻断）：无 DATABASE_URL 时不配置，
	// 网关照常启动代理；差分执行时发现未配置即跳过（不查询、不失败上抛）。
	// onboarding go 模式下同一连接池被 authz/onboarding 复用（config 已
	// 保证 DATABASE_URL 非空；此处 DSN 无效直接启动失败——Go 接管端点
	// 不得带病启动）。
	var userSettingsRepo usersettings.Repository
	userSettingsDBStatus := "unconfigured"
	var sharedDB *sql.DB
	if cfg.DatabaseURL != "" {
		db, err := usersettings.OpenMySQLFromURL(cfg.DatabaseURL)
		if err != nil {
			// DSN 无效不阻断启动：网关继续纯代理，shadow 单元执行时跳过
			//（错误不含 DSN 原文）。go 接管模式（两变量任一）下直接启动
			// 失败——Go 接管端点不得带病启动。
			if cfg.OnboardingMode == config.OnboardingModeGo ||
				cfg.UserSettingsReadMode == config.UserSettingsReadModeGo {
				return fmt.Errorf("api-go: user-settings go takeover requires a valid DATABASE_URL: %w", err)
			}
			log.Printf("api-go: user-settings shadow database not initialized (invalid DATABASE_URL): %v", err)
			userSettingsDBStatus = "invalid"
		} else {
			// sql.Open 是惰性初始化：只代表 DSN 成功解析为 driver 配置，
			// 不证明数据库可连接。连接性由真实查询按需建立（失败只影响
			// shadow 差分，不影响 legacy 响应）——不引入启动 Ping/探针/
			// 重试，数据库连通性也不是网关的存活条件。
			userSettingsRepo = usersettings.NewMySQLRepository(db)
			userSettingsDBStatus = "configured"
			sharedDB = db
		}
	}

	// go 接管模式的 Go 鉴权/响应栈装配（Go-批3A 引入，批3B 收敛为六个
	// user-settings 只读 GET 的统一 handler）：
	// authn（JWT 验签 + Redis blacklist）→ authz（MySQL membership/
	// permission 重推导，复用同一 *sql.DB 连接池）→ authhttp（契约错误）
	// → usersettingsread handler（六端点共享：固定 repository 查询 +
	// normalization + 响应构造）。
	// 两变量任一为 go 即装配（UserSettingsReadMode=go 是六端点全接管；
	// OnboardingMode=go 单独设置时同一栈也覆盖统一 handler 的 onboarding
	// 分支——但路由表只在 readMode 空时把 onboarding 切 go，此时其余五
	// 端点仍 shadow/legacy，handler 对未接管路径不会被路由命中）。
	// 两者都非 go 时完全不装配（零额外连接、旧行为不变）。
	goTakeover := cfg.OnboardingMode == config.OnboardingModeGo ||
		cfg.UserSettingsReadMode == config.UserSettingsReadModeGo
	var redisClient *redis.Client
	if goTakeover {
		redisClient = redis.NewClient(&redis.Options{
			Addr:     net.JoinHostPort(cfg.RedisHost, strconv.Itoa(cfg.RedisPort)),
			Username: cfg.RedisUsername,
			Password: cfg.RedisPassword,
			DB:       cfg.RedisDB,
		})
		verifier := authn.NewVerifier(cfg.JWTSecret, cfg.JWTIssuer, cfg.JWTAudience)
		blacklist := authn.NewRedisBlacklist(redisClient)
		authenticator := authhttp.NewAuthenticator(verifier, blacklist, authz.NewMySQLRepository(sharedDB))
		readHandler := usersettingsread.NewHandler(authenticator, userSettingsRepo)
		for _, path := range usersettingsread.Paths {
			gateway.RegisterGoHandler(path, readHandler.ServeHTTP)
		}
		log.Printf("api-go: user-settings read GET(s) under go takeover (JWT verify + Redis blacklist + MySQL RBAC; issuer=%s, readMode=%s, onboardingMode=%s)",
			cfg.JWTIssuer, cfg.UserSettingsReadMode, cfg.OnboardingMode)
	}

	// shadow 单元表：路由表中处于 ModeGo 的端点不再是 shadow 差分单元
	//（ModeGo 规则也不会进入 serveShadow——双重收口，保证 go 接管的
	// GET 不再增加 shadow.executed）。readMode=go 时六个端点全部过滤；
	// readMode 空且 onboardingMode=go 时只过滤 onboarding；其余保持
	// 既有 shadow/legacy 去向。
	settingsUnits := userSettingsShadowUnits(userSettingsRepo)
	goPaths := make(map[string]bool, len(usersettingsread.Paths))
	for _, rule := range gateway.Rules() {
		if rule.Mode == legacyproxy.ModeGo {
			goPaths[rule.Prefix] = true
		}
	}
	if len(goPaths) > 0 {
		filtered := make([]shadowUnit, 0, len(settingsUnits))
		for _, unit := range settingsUnits {
			if !goPaths[unit.Path] {
				filtered = append(filtered, unit)
			}
		}
		settingsUnits = filtered
	}

	disp := &dispatcher{
		shadowUnits: append([]shadowUnit{
			{
				Path:            "/api/healthz/live",
				Methods:         map[string]bool{http.MethodGet: true},
				RequireLegacyOK: false, // 公开探针：无需 legacy 认可身份
				Executant:       healthLiveExecutant{},
			},
		}, settingsUnits...),
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
	// DSN/host/凭据/数据库错误详情。onboardingMode 如实展示当前模式
	//（shadow/go）。字段名 userSettingsShadow 覆盖三个只读 GET 共用的
	// 同一 repository（全仓唯一消费者是本文件与 README，无外部契约）。
	gateway.SetGoHandler(func(w http.ResponseWriter, _ *http.Request) {
		routes := make([]map[string]string, 0, len(gateway.Rules()))
		for _, rule := range gateway.Rules() {
			entry := map[string]string{"prefix": rule.Prefix, "mode": string(rule.Mode)}
			if rule.Exact {
				entry["match"] = "exact"
				methods := make([]string, 0, len(rule.Methods))
				for method := range rule.Methods {
					methods = append(methods, method)
				}
				sort.Strings(methods)
				entry["methods"] = strings.Join(methods, ",")
			}
			routes = append(routes, entry)
		}
		httpx.WriteJSON(w, http.StatusOK, map[string]any{
			"ok":     true,
			"routes": routes,
			"shadow": disp.shadowRunner.Stats(),
			"canary": map[string]int{"percent": disp.canaryRouter.Percent()},
			"onboarding": map[string]any{
				"mode": string(cfg.OnboardingMode),
			},
			// user-settings 统一读模式（Go-批3B）：空 = 兼容旧配置
			//（onboardingMode 单独控制）；shadow/go 如实展示。
			"userSettingsRead": map[string]any{
				"mode":     string(cfg.UserSettingsReadMode),
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
		if err := server.Shutdown(ctx); err != nil {
			return err
		}
		// go 模式下 onboarding 鉴权栈持有的 Redis 连接随进程收口。
		if redisClient != nil {
			if err := redisClient.Close(); err != nil {
				log.Printf("api-go: redis client close: %v", err)
			}
		}
		return nil
	}
}

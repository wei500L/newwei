// Package legacyproxy 是 Strangler Fig 网关的路由与反向代理层。
//
// 路由表按前缀声明四态（对齐 docs/refactor/go-migration-adr.md §4）：
//
//	legacy（默认）— 全量反向代理到 NestJS apps/api
//	shadow         — 仍由 NestJS 执行，请求异步复制到 Go 比对（仅记录差异）
//	canary         — 按 orgId 哈希小比例真实流量切 Go
//	go             — Go 原生 handler 全量接管
//
// 当前骨架仅实现 legacy 与 go 两态（尚无已迁移路由）；shadow/canary 在首个
// Go 路由落地时一并实现。新增迁移 = 在 DefaultRules 中把对应前缀改为 go，
// 并在 goHandlers 注册 handler——单条路由规则回切即回滚。
package legacyproxy

import (
	"fmt"
	"net/http"
	"net/http/httputil"
	"net/url"
	"sort"
	"strings"

	"github.com/wei500L/newwei/apps/api-go/internal/httpx"
)

// Mode 是单条路由规则的流量去向。
type Mode string

const (
	ModeLegacy Mode = "legacy"
	ModeShadow Mode = "shadow"
	ModeCanary Mode = "canary"
	ModeGo     Mode = "go"
)

// Rule 声明一个前缀的流量去向。
type Rule struct {
	Prefix string
	Mode   Mode
}

// DefaultRules 是当前的路由表。
//
// 注意三个无 /api 前缀的挂载点（契约清单 §0）：/graphql、/socket.io、
// /admin/queues（Bull Board）。代理层必须与 REST 前缀分别声明。
func DefaultRules() []Rule {
	return []Rule{
		{Prefix: "/api/", Mode: ModeLegacy},
		{Prefix: "/graphql", Mode: ModeLegacy},
		{Prefix: "/socket.io/", Mode: ModeLegacy},
		{Prefix: "/docs", Mode: ModeLegacy},
		{Prefix: "/admin/queues", Mode: ModeLegacy},
		{Prefix: "/__go/healthz", Mode: ModeGo},
	}
}

// GoHandler 是已迁移到 Go 的原生处理器（按前缀注册）。
type GoHandler func(w http.ResponseWriter, r *http.Request)

// Gateway 是 Strangler 网关。
type Gateway struct {
	rules     []Rule
	goHandler GoHandler
	proxy     *httputil.ReverseProxy
}

// New 构造网关。legacyURL 指向 NestJS apps/api 基址；Go 原生路由随后经
// SetGoHandler 注入（handler 可闭包引用网关自身做路由表自省）。
func New(legacyURL string, rules []Rule) (*Gateway, error) {
	target, err := url.ParseRequestURI(legacyURL)
	if err != nil {
		return nil, fmt.Errorf("invalid legacy API URL %q: %w", legacyURL, err)
	}
	proxy := httputil.NewSingleHostReverseProxy(target)
	originalDirector := proxy.Director
	proxy.Director = func(req *http.Request) {
		originalDirector(req)
		req.Host = target.Host
	}
	proxy.ErrorHandler = func(w http.ResponseWriter, r *http.Request, err error) {
		httpx.WriteJSON(w, http.StatusBadGateway, map[string]any{
			"statusCode": 502,
			"message":    "Bad Gateway",
			"error":      "Bad Gateway",
			"traceId":    httpx.TraceIDFromContext(r.Context()),
			"path":       r.URL.Path,
		})
	}
	return &Gateway{rules: rules, proxy: proxy}, nil
}

// SetGoHandler 注入 Go 原生路由的处理器。
func (g *Gateway) SetGoHandler(handler GoHandler) {
	g.goHandler = handler
}

// ServeHTTP 按路由表分发。
func (g *Gateway) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	rule := g.match(r.URL.Path)
	switch rule.Mode {
	case ModeGo:
		if g.goHandler != nil {
			g.goHandler(w, r)
			return
		}
		httpx.WriteJSON(w, http.StatusNotImplemented, map[string]any{
			"statusCode": 501,
			"message":    "go route has no handler",
			"error":      "Not Implemented",
		})
	case ModeLegacy:
		g.proxy.ServeHTTP(w, r)
	case ModeShadow, ModeCanary:
		// 尚未有已迁移路由会进入这两态；首个 Go 路由落地时实现。
		httpx.WriteJSON(w, http.StatusNotImplemented, map[string]any{
			"statusCode": 501,
			"message":    fmt.Sprintf("route mode %q not yet implemented", rule.Mode),
			"error":      "Not Implemented",
		})
	}
}

// match 返回最长前缀匹配的规则（更具体的前缀优先）。
func (g *Gateway) match(path string) Rule {
	sorted := make([]Rule, len(g.rules))
	copy(sorted, g.rules)
	sort.SliceStable(sorted, func(i, j int) bool {
		return len(sorted[i].Prefix) > len(sorted[j].Prefix)
	})
	for _, rule := range sorted {
		if strings.HasPrefix(path, rule.Prefix) {
			return rule
		}
	}
	// 未命中任何前缀的路径（如根路径 /）也交给 NestJS——它是当前的事实源。
	return Rule{Prefix: path, Mode: ModeLegacy}
}

// Rules 导出当前路由表（供 /__go/healthz 展示与测试断言）。
func (g *Gateway) Rules() []Rule {
	out := make([]Rule, len(g.rules))
	copy(out, g.rules)
	return out
}

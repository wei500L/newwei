// Package legacyproxy 是 Strangler Fig 网关的路由与反向代理层。
//
// 路由表按前缀声明四态（对齐 docs/refactor/go-migration-adr.md §4）：
//
//	legacy（默认）— 全量反向代理到 NestJS apps/api
//	shadow         — 仍由 NestJS 执行，请求异步复制到 Go 实现比对（仅记录差异）
//	canary         — 按 orgId 哈希小比例真实流量切 Go，其余 legacy
//	go             — Go 原生 handler 全量接管
//
// 四态实现：
//   - shadow：客户端响应始终来自 NestJS（先代理捕获响应，再异步差分）；
//     只对只读方法（GET/HEAD/OPTIONS）生效，带超时/体积/并发/速率预算。
//   - canary：orgId 稳定哈希分桶（见 internal/canary）；无可靠 orgId 回 legacy。
//   - 回滚：路由表单条规则改回 ModeLegacy（或 CANARY_PERCENT=0），
//     纯配置变更，无代码回滚。
//
// 新增迁移 = 在 DefaultRules 中把对应前缀改为目标模式，并注册 goHandlers。
package legacyproxy

import (
	"bytes"
	"fmt"
	"io"
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
// 首个迁移单元（迁移序 2）：GET /api/healthz/live —— shadow 模式起步
// （NestJS 响应仍是事实源，Go 实现进入差分管道验证）。
//
// 注意三个无 /api 前缀的挂载点（契约清单 §0）：/graphql、/socket.io、
// /admin/queues（Bull Board）。代理层必须与 REST 前缀分别声明。
func DefaultRules() []Rule {
	return []Rule{
		{Prefix: "/api/", Mode: ModeLegacy},
		{Prefix: "/api/healthz/live", Mode: ModeShadow},
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
	rules      []Rule
	goHandlers map[string]GoHandler
	proxy      *httputil.ReverseProxy
}

// New 构造网关。legacyURL 指向 NestJS apps/api 基址；Go 原生路由随后经
// RegisterGoHandler 注入。
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
	return &Gateway{
		rules:      rules,
		goHandlers: make(map[string]GoHandler),
		proxy:      proxy,
	}, nil
}

// SetGoHandler 注入单一 Go 原生路由处理器（保留以兼容 /__go/healthz）。
func (g *Gateway) SetGoHandler(handler GoHandler) {
	g.goHandlers["/__go/healthz"] = handler
}

// RegisterGoHandler 按前缀注册 Go 原生处理器。
func (g *Gateway) RegisterGoHandler(prefix string, handler GoHandler) {
	g.goHandlers[prefix] = handler
}

// ServeHTTP 按路由表分发。
func (g *Gateway) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	g.ServeHTTPWithShadow(w, r, nil)
}

// ServeHTTPWithShadow 分发并在 shadow 路由上执行差分。
func (g *Gateway) ServeHTTPWithShadow(w http.ResponseWriter, r *http.Request, sh ShadowDispatcher) {
	rule := g.match(r.URL.Path)
	switch rule.Mode {
	case ModeGo:
		handler := g.matchGoHandler(rule.Prefix)
		if handler != nil {
			handler(w, r)
			return
		}
		httpx.WriteJSON(w, http.StatusNotImplemented, map[string]any{
			"statusCode": 501,
			"message":    "go route has no handler",
			"error":      "Not Implemented",
		})
	case ModeLegacy:
		g.proxy.ServeHTTP(w, r)
	case ModeShadow:
		// shadow：NestJS 仍是响应方；Go 实现异步旁路执行比对。
		// 主响应不受 Go 侧执行成败/快慢影响（超时即丢弃差分）。
		g.serveShadow(w, r, sh)
	case ModeCanary:
		if sh != nil && sh.CanaryRoute(r) {
			handler := g.matchGoHandler(rule.Prefix)
			if handler != nil {
				handler(w, r)
				return
			}
			// canary 命中但无实现：回 legacy（fail-safe），不 501 客户端。
			g.proxy.ServeHTTP(w, r)
			return
		}
		g.proxy.ServeHTTP(w, r)
	}
}

// ShadowDispatcher 是 shadow/canary 的网关侧依赖（由上层装配注入，
// 保持 legacyproxy 不直接依赖具体 shadow runner / canary router）。
type ShadowDispatcher interface {
	// ObserveShadow 触发一次 shadow 差分（异步、不阻塞主响应）。
	ObserveShadow(r *http.Request, legacyStatus int, legacyHeader http.Header, legacyBody []byte)
	// CanaryRoute 报告该请求是否进入 go 实现（orgId 稳定哈希 + 比例）。
	CanaryRoute(r *http.Request) bool
}

// serveShadow：代理到 NestJS 并捕获响应（差分需要 legacy 响应体）。
//
// 响应捕获方式：反向代理写入一个捕获用 ResponseWriter（记录状态码/头/体），
// 写完后回放给真实客户端并触发差分。
func (g *Gateway) serveShadow(w http.ResponseWriter, r *http.Request, sh ShadowDispatcher) {
	// 只对只读方法差分：写方法双发有副作用，明令禁止（shadow.go IsShadowableMethod）。
	if sh == nil || !isReadonlyMethod(r.Method) {
		g.proxy.ServeHTTP(w, r)
		return
	}

	// 读取请求体（差分执行需要重放）；读后还原 Body。
	var requestBody []byte
	if r.Body != nil {
		body, err := io.ReadAll(io.LimitReader(r.Body, 10<<20))
		if err != nil {
			// 读 body 失败不影响主链路：直接代理（差分放弃）。
			g.proxy.ServeHTTP(w, r)
			return
		}
		requestBody = body
		r.Body = io.NopCloser(bytes.NewReader(body))
	}

	capture := &captureWriter{header: http.Header{}}
	g.proxy.ServeHTTP(capture, r)

	// 回放：把捕获的响应写给真实客户端（状态码/头/体原样）。
	for key, values := range capture.header {
		for _, value := range values {
			w.Header().Add(key, value)
		}
	}
	w.WriteHeader(capture.status)
	_, _ = w.Write(capture.body.Bytes())

	// 异步差分（不阻塞已写完的响应）。
	legacyBody := capture.body.Bytes()
	go sh.ObserveShadow(cloneRequestForShadow(r, requestBody), capture.status, capture.header, legacyBody)
}

// captureWriter 捕获反向代理的输出（shadow 差分用）。
type captureWriter struct {
	header http.Header
	status int
	body   bytes.Buffer
}

func (c *captureWriter) Header() http.Header { return c.header }

func (c *captureWriter) WriteHeader(status int) { c.status = status }

func (c *captureWriter) Write(p []byte) (int, error) {
	if c.status == 0 {
		c.status = http.StatusOK
	}
	return c.body.Write(p)
}

func (c *captureWriter) Flush() {}

func cloneRequestForShadow(r *http.Request, body []byte) *http.Request {
	shadowRequest := r.Clone(r.Context())
	if body != nil {
		shadowRequest.Body = io.NopCloser(bytes.NewReader(body))
	} else {
		shadowRequest.Body = nil
	}
	return shadowRequest
}

func isReadonlyMethod(method string) bool {
	switch strings.ToUpper(method) {
	case http.MethodGet, http.MethodHead, http.MethodOptions:
		return true
	default:
		return false
	}
}

func (g *Gateway) matchGoHandler(prefix string) GoHandler {
	// 前缀完全匹配（路由表 prefix = handler 注册键）。
	if handler, ok := g.goHandlers[prefix]; ok {
		return handler
	}
	// 兼容旧 SetGoHandler（/__go/healthz 之外的 go 路由按最长注册前缀匹配）。
	keys := make([]string, 0, len(g.goHandlers))
	for key := range g.goHandlers {
		keys = append(keys, key)
	}
	sort.Slice(keys, func(i, j int) bool { return len(keys[i]) > len(keys[j]) })
	for _, key := range keys {
		if strings.HasPrefix(prefix, key) {
			return g.goHandlers[key]
		}
	}
	return nil
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

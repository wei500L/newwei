// Package legacyproxy 是 Strangler Fig 网关的路由与反向代理层。
//
// 路由表按前缀声明四态（对齐 docs/refactor/go-migration-adr.md §4）：
//
//	legacy（默认）— 全量反向代理到 NestJS apps/api
//	shadow         — 仍由 NestJS 执行，请求异步复制到 Go 实现比对（仅记录差异）
//	canary         — 按已验证身份的稳定哈希小比例真实流量切 Go，其余 legacy
//	go             — Go 原生 handler 全量接管
//
// 四态实现：
//   - shadow：客户端响应始终来自 NestJS（直通 + 有界旁录，客户端无需
//     等待捕获完成）；只对只读方法（GET/HEAD/OPTIONS）生效，请求体与
//     响应捕获是独立预算；流式/SSE/升级请求默认不进入差分。
//   - canary：orgId 稳定哈希分桶（见 internal/canary）。注意：当前分流
//     依据是未验签的 JWT payload claim——在 Go 侧完成真实 JWT 验签与
//     membership 重推导之前，受保护路由不得依赖它进入 Go（fail-safe
//     回 legacy）；当前没有路由处于 ModeCanary。
//   - 回滚：路由表单条规则改回 ModeLegacy（或 CANARY_PERCENT=0），
//     纯配置变更，无代码回滚。
//
// 新增迁移 = 在 DefaultRules 中把对应前缀改为目标模式，并注册 goHandlers。
package legacyproxy

import (
	"bytes"
	"fmt"
	"io"
	"mime"
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
	rules        []Rule
	goHandlers   map[string]GoHandler
	proxy        *httputil.ReverseProxy
	shadowBudget ShadowBudget
}

// New 构造网关。legacyURL 指向 NestJS apps/api 基址；Go 原生路由随后经
// RegisterGoHandler 注入。shadowBudget 为零值时按 1 MiB 保守默认。
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
		rules:        rules,
		goHandlers:   make(map[string]GoHandler),
		proxy:        proxy,
		shadowBudget: ShadowBudget{MaxRequestBodyByte: 1 << 20, MaxResponseCaptureByte: 1 << 20},
	}, nil
}

// SetShadowBudget 注入 shadow 捕获预算（请求体/响应捕获独立上限）。
func (g *Gateway) SetShadowBudget(budget ShadowBudget) {
	if budget.MaxRequestBodyByte > 0 {
		g.shadowBudget.MaxRequestBodyByte = budget.MaxRequestBodyByte
	}
	if budget.MaxResponseCaptureByte > 0 {
		g.shadowBudget.MaxResponseCaptureByte = budget.MaxResponseCaptureByte
	}
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
		g.serveShadow(w, r, sh, g.shadowBudget)
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
	// ObserveShadow 提交一次 shadow 观察。reason 非空表示主链路（捕获
	// 阶段）已判定无法差分——只记账（runner.ObserveSkip），不执行；
	// reason 为空时 legacyStatus/Header/Body 是完整捕获的响应。
	ObserveShadow(r *http.Request, legacyStatus int, legacyHeader http.Header, legacyBody []byte, reason ShadowSkipReason)
	// CanaryRoute 报告该请求是否进入 go 实现（orgId 稳定哈希 + 比例）。
	CanaryRoute(r *http.Request) bool
}

// ShadowSkipReason 是捕获阶段判定的差分跳过原因（与 shadow 包的
// SkipReason 值一致；字符串常量避免包间循环依赖）。
type ShadowSkipReason string

const (
	// ShadowSkipRequestTooLarge 差分可重放的请求体超过预算（请求仍完整转发）。
	ShadowSkipRequestTooLarge ShadowSkipReason = "request-too-large"
	// ShadowSkipResponseTooLarge 响应体超过捕获预算（主响应完整流式透传）。
	ShadowSkipResponseTooLarge ShadowSkipReason = "response-too-large"
	// ShadowSkipStreaming 流式响应（SSE/事件流）无法整体差分（主响应流式透传）。
	ShadowSkipStreaming ShadowSkipReason = "streaming-skipped"
)

// ShadowBudget 是 serveShadow 的资源边界（由上层从 config 传入）。
type ShadowBudget struct {
	// MaxRequestBodyByte 差分可重放的请求体上限；超过后请求仍完整转发
	//（MultiReader 回放已读前缀），只是放弃差分。
	MaxRequestBodyByte int64
	// MaxResponseCaptureByte 响应差分缓存上限；超过后停止捕获继续透传。
	MaxResponseCaptureByte int64
}

// serveShadow：代理到 NestJS，同时以有界旁路捕获响应用于差分。
//
// 捕获方式是「直通 + 有界旁录」：captureWriter 把每个字节即时写给客户端
// （保留流式/分块语义），同时最多旁录 MaxResponseCaptureByte 字节；超限
// 或检测到 SSE 流式响应时停止旁录、只透传。客户端永远不需要等待捕获
// 完成，差分失败/超限/超时都不影响主响应。
func (g *Gateway) serveShadow(w http.ResponseWriter, r *http.Request, sh ShadowDispatcher, budget ShadowBudget) {
	// 只对只读方法差分：写方法双发有副作用，明令禁止。
	if sh == nil || !isReadonlyMethod(r.Method) {
		g.proxy.ServeHTTP(w, r)
		return
	}

	// WebSocket/协议升级请求：差分无意义且 stdlib ReverseProxy 本就不支持
	// upgrade——直接纯代理，不做任何捕获。
	if isUpgradeRequest(r) {
		sh.ObserveShadow(r, 0, nil, nil, ShadowSkipStreaming)
		g.proxy.ServeHTTP(w, r)
		return
	}

	// 差分预算兜底（零值时按 1 MiB 保守处理）。
	maxReq := budget.MaxRequestBodyByte
	if maxReq <= 0 {
		maxReq = 1 << 20
	}
	maxResp := budget.MaxResponseCaptureByte
	if maxResp <= 0 {
		maxResp = 1 << 20
	}

	// 读取请求体（差分执行需要重放）。读上限 maxReq+1：多读 1 字节用于
	// 判定超限；超限时用 MultiReader 把已读前缀与未读尾部拼回——请求
	// 仍完整转发给上游，只是放弃差分。
	var requestBody []byte
	requestTooLarge := false
	if r.Body != nil {
		buf, err := io.ReadAll(io.LimitReader(r.Body, maxReq+1))
		if err != nil {
			// 读 body 失败不影响主链路：直接代理（差分放弃）。
			g.proxy.ServeHTTP(w, r)
			return
		}
		if int64(len(buf)) > maxReq {
			requestTooLarge = true
			// 已读前缀 + 未读剩余部分拼回原始流。
			r.Body = struct {
				io.Reader
				io.Closer
			}{io.MultiReader(bytes.NewReader(buf), r.Body), r.Body}
		} else {
			requestBody = buf
			r.Body = io.NopCloser(bytes.NewReader(buf))
		}
	}

	capture := newCaptureWriter(w, maxResp)
	g.proxy.ServeHTTP(capture, r)

	// 差分观察（异步语义由 dispatcher/runner 保证；此处只是提交）。
	if requestTooLarge {
		sh.ObserveShadow(r, 0, nil, nil, ShadowSkipRequestTooLarge)
		return
	}
	if capture.streaming {
		sh.ObserveShadow(r, 0, nil, nil, ShadowSkipStreaming)
		return
	}
	if capture.overLimit {
		sh.ObserveShadow(r, 0, nil, nil, ShadowSkipResponseTooLarge)
		return
	}
	sh.ObserveShadow(cloneRequestForShadow(r, requestBody), capture.status, capture.header, capture.body.Bytes(), "")
}

// isUpgradeRequest 判定协议升级请求（WebSocket、h2c 等）：任何非空
// Upgrade 头都按升级处理——差分对升级握手无意义。
func isUpgradeRequest(r *http.Request) bool {
	return strings.TrimSpace(r.Header.Get("Upgrade")) != ""
}

// captureWriter 直通式捕获器：上游写入的每个字节即时转发给客户端，
// 同时有界旁录用于差分。这保留了对客户端的流式/分块/Flush 语义——
// 与「先整包缓冲再回放」相反。
type captureWriter struct {
	dst       http.ResponseWriter // 真实客户端
	header    http.Header         // 捕获的响应头（发给客户端的镜像）
	status    int
	body      bytes.Buffer // 有界旁录
	maxBytes  int64
	overLimit bool // 响应超过旁录预算（已停止捕获，继续透传）
	streaming bool // SSE/事件流（已停止捕获，继续透传）
}

func newCaptureWriter(dst http.ResponseWriter, maxBytes int64) *captureWriter {
	return &captureWriter{dst: dst, header: http.Header{}, maxBytes: maxBytes}
}

func (c *captureWriter) Header() http.Header { return c.header }

func (c *captureWriter) WriteHeader(status int) {
	c.status = status
	// 响应头先转发给客户端（流式语义的关键：客户端立即收到头）。
	for key, values := range c.header {
		for _, value := range values {
			c.dst.Header().Add(key, value)
		}
	}
	c.dst.WriteHeader(status)
	// SSE/事件流：响应本身就是无边界的持续推送，无法整体差分——
	// 停止旁录，纯透传。
	if mediaType := headerMediaType(c.header.Get("Content-Type")); mediaType == "text/event-stream" {
		c.streaming = true
	}
}

func (c *captureWriter) Write(p []byte) (int, error) {
	if c.status == 0 {
		c.WriteHeader(http.StatusOK)
	}
	n, err := c.dst.Write(p) // 先透传客户端
	if err != nil {
		return n, err
	}
	if c.streaming || c.overLimit {
		return n, nil
	}
	if int64(c.body.Len())+int64(len(p)) > c.maxBytes {
		// 超过旁录预算：丢弃差分（调用方记 response-too-large），
		// 客户端不受影响。
		c.overLimit = true
		c.body.Reset()
		return n, nil
	}
	c.body.Write(p)
	return n, nil
}

// Flush 转发客户端 Flush（ReverseProxy 对 chunked 响应会调用）。
func (c *captureWriter) Flush() {
	if flusher, ok := c.dst.(http.Flusher); ok {
		flusher.Flush()
	}
}

// headerMediaType 解析 Content-Type 的 media type（解析失败返回原值小写）。
func headerMediaType(contentType string) string {
	mediaType, _, err := mime.ParseMediaType(contentType)
	if err != nil {
		return strings.ToLower(strings.TrimSpace(contentType))
	}
	return mediaType
}

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

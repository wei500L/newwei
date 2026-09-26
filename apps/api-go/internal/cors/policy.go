// Package cors 对齐 NestJS enableCors({ credentials: true, origin: allowlist })
//（apps/api/src/main.ts 与 common/cors/cors-origin.ts，底层是 cors@2.8.5）。
//
// 只服务已由 Go 写出的响应。反向代理到 NestJS 的响应仍带着上游自己的
// CORS 头，这里不重复加。
//
// 白名单来自同一环境变量 CORS_ORIGIN。空名单等于 Nest 的 origin: false：
// 不反射任何 Origin，也不返回 *。credentials 固定为 true，因此允许的
// Origin 必须是请求里的具体值，不能是通配符。
//
// X-Frame-Options 不在这里补。它来自 NestJS 进程入口的 helmet()，只出现在
// 被代理的响应上。浏览器 axios 读 JSON 不看这个头；Go 入口
//（httpx.TraceMiddleware）也不设置它。
package cors

import (
	"net/http"
	"net/url"
	"strings"
)

// allowMethods 是 cors 包的默认方法列表（Nest 没有覆盖 methods）。
const allowMethods = "GET,HEAD,PUT,PATCH,POST,DELETE"

// Policy 是一份已解析的来源白名单。
type Policy struct {
	allowlist []string
}

// New 解析 CORS_ORIGIN。条目按逗号拆分、去空白；能解析成绝对 URL 的
// 收成 scheme://host（含端口），解析不了的原样保留（与 parseCorsOriginAllowlist
// 一致，`*` 因此不会变成“允许任意来源”）。
func New(raw string) Policy {
	return Policy{allowlist: parseAllowlist(raw)}
}

func parseAllowlist(raw string) []string {
	if strings.TrimSpace(raw) == "" {
		return nil
	}
	parts := strings.Split(raw, ",")
	out := make([]string, 0, len(parts))
	for _, part := range parts {
		entry := strings.TrimSpace(part)
		if entry == "" {
			continue
		}
		out = append(out, normalizeEntry(entry))
	}
	return out
}

func normalizeEntry(entry string) string {
	parsed, err := url.Parse(entry)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return entry
	}
	return parsed.Scheme + "://" + parsed.Host
}

func (p Policy) enabled() bool {
	return len(p.allowlist) > 0
}

func (p Policy) allows(origin string) bool {
	if origin == "" || origin == "*" {
		return false
	}
	for _, allowed := range p.allowlist {
		if allowed == origin {
			return true
		}
	}
	return false
}

// FinishOptions 处理浏览器预检，或给即将由 Go 写出的实际响应补上来源头。
//
// 返回 true：这是带 Origin 和 Access-Control-Request-Method 的 OPTIONS 预检，
// 响应已写完（204）。调用方不得再鉴权、查库或写库。
// 返回 false：不是预检。非 OPTIONS 已写上实际响应需要的 CORS 头（若白名单
// 开启）；OPTIONS 但缺少预检头时不写状态，调用方应继续走原来的代理。
func (p Policy) FinishOptions(w http.ResponseWriter, r *http.Request) bool {
	if r.Method == http.MethodOptions {
		if !isPreflight(r) {
			return false
		}
		p.writePreflight(w, r)
		return true
	}
	p.applyActual(w, r)
	return false
}

func isPreflight(r *http.Request) bool {
	return strings.TrimSpace(r.Header.Get("Origin")) != "" &&
		strings.TrimSpace(r.Header.Get("Access-Control-Request-Method")) != ""
}

func (p Policy) applyActual(w http.ResponseWriter, r *http.Request) {
	if !p.enabled() {
		return
	}
	p.applyOrigin(w.Header(), r.Header.Get("Origin"))
	w.Header().Set("Access-Control-Allow-Credentials", "true")
}

func (p Policy) writePreflight(w http.ResponseWriter, r *http.Request) {
	if p.enabled() {
		p.applyOrigin(w.Header(), r.Header.Get("Origin"))
		w.Header().Set("Access-Control-Allow-Credentials", "true")
		w.Header().Set("Access-Control-Allow-Methods", allowMethods)
		addVary(w.Header(), "Access-Control-Request-Headers")
		if requested := r.Header.Get("Access-Control-Request-Headers"); requested != "" {
			w.Header().Set("Access-Control-Allow-Headers", requested)
		}
	}
	w.Header().Set("Content-Length", "0")
	w.WriteHeader(http.StatusNoContent)
}

// applyOrigin 在白名单开启时始终带上 Vary: Origin。只有请求 Origin 与
// 某一项完全一致时才回写 Access-Control-Allow-Origin，且值就是该 Origin。
func (p Policy) applyOrigin(header http.Header, origin string) {
	addVary(header, "Origin")
	if p.allows(origin) {
		header.Set("Access-Control-Allow-Origin", origin)
	}
}

func addVary(header http.Header, field string) {
	existing := header.Get("Vary")
	if existing == "" {
		header.Set("Vary", field)
		return
	}
	if strings.TrimSpace(existing) == "*" {
		return
	}
	for _, part := range strings.Split(existing, ",") {
		if strings.EqualFold(strings.TrimSpace(part), field) {
			return
		}
	}
	header.Set("Vary", existing+", "+field)
}

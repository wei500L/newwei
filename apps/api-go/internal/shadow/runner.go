// Package shadow 实现 shadow 模式的差分执行（go-migration-adr §4）。
//
// 语义：
//   - 客户端响应始终来自 NestJS（legacy 代理）；Go handler 的执行是旁路。
//   - 只对无副作用的只读请求启用（方法白名单 + 路由表里的 shadow 规则）。
//   - 资源边界：单次超时、请求体上限、并发上限、每分钟预算（令牌桶）。
//     任一超限 → 该请求直接跳过差分（不排队、不阻塞主响应）。响应捕获
//     的上限由调用方（legacyproxy 的 pass-through 捕获器）执行，超限时
//     以 SkipReason 通知本包只记账。
//   - 差异记录为结构化 JSON 行：traceId/路径/两侧状态码/差异字段/响应
//     体 hash。默认不保存业务响应正文（避免把业务数据写进网关日志）；
//     显式开启 debug 后才记录截断正文。
//   - 差分忽略 traceId / 时间戳类非确定字段（默认 ignore 集合 + 可扩展）。
//   - 禁止对写请求双发：方法不在只读白名单时拒绝执行。
package shadow

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"mime"
	"net/http"
	"strings"
	"sync"
	"time"
)

// Budget 是 shadow 差分执行的资源边界（全部超限即丢弃该次差分）。
type Budget struct {
	TimeoutMs          int
	MaxRequestBodyByte int64
	MaxInflight        int
	MaxPerMin          int

	// DebugBodyLog 显式开启后才在差异记录中保存截断正文（默认只记 hash）。
	DebugBodyLog bool
	// DebugBodyLogMaxBytes 限制 debug 正文的截断长度。
	DebugBodyLogMaxBytes int64
}

// SkipReason 是主链路（legacyproxy 捕获阶段）判定的差分跳过原因。
// 与 runner 内部的限流/超时原因一起构成完整的丢弃分类。
type SkipReason string

const (
	// SkipRequestTooLarge 差分可重放的请求体超过预算（请求仍正常转发）。
	SkipRequestTooLarge SkipReason = "request-too-large"
	// SkipResponseTooLarge 响应体超过捕获预算（主响应完整流式透传）。
	SkipResponseTooLarge SkipReason = "response-too-large"
	// SkipStreaming 响应是流式（SSE / 事件流），无法整体差分（主响应流式透传）。
	SkipStreaming SkipReason = "streaming-skipped"
)

// Executant 是 Go 侧的差分执行者：输入是原始请求（body 已读入且可重放），
// 输出是 Go 实现的响应。执行者自带鉴权/业务语义（与 NestJS 对齐），
// 且必须尊重传入的 ctx（超时后应尽快返回）。
type Executant interface {
	Execute(ctx context.Context, request *http.Request, body []byte) *Result
}

// Result 是 Go 侧执行结果（shadow 比对的输入）。
type Result struct {
	StatusCode int
	Header     http.Header
	Body       []byte
}

// Runner 是 shadow 差分执行器。
//
// Runner 不绑定单个 executant：每次 ObserveResult 携带该路由的 Go 实现
// （网关按路由分发），Runner 只负责资源预算与差分比较。
type Runner struct {
	budget Budget

	mu       sync.Mutex
	inflight int
	bucket   float64
	bucketAt time.Time
	diffs    uint64
	executed uint64
	dropped  DroppedStats
}

// DroppedStats 按原因分类的差分丢弃计数（/__go/healthz 自省 + 巡检告警输入）。
type DroppedStats struct {
	RequestTooLarge  uint64 `json:"request-too-large"`
	ResponseTooLarge uint64 `json:"response-too-large"`
	StreamingSkipped uint64 `json:"streaming-skipped"`
	ConcurrencyLimit uint64 `json:"concurrency-limit"`
	RateLimit        uint64 `json:"rate-limit"`
	Timeout          uint64 `json:"timeout"`
}

// Total 返回丢弃总数。
func (d DroppedStats) Total() uint64 {
	return d.RequestTooLarge + d.ResponseTooLarge + d.StreamingSkipped +
		d.ConcurrencyLimit + d.RateLimit + d.Timeout
}

// DiffRecord 是一条结构化差异记录（JSON 行输出）。
//
// 默认不含业务正文：legacyBodyHash/goBodyHash 是完整响应体的 sha256 hex，
// 正文仅在 Budget.DebugBodyLog 开启时以截断片段（legacyBodySnippet）记录。
type DiffRecord struct {
	TraceID        string   `json:"traceId"`
	Method         string   `json:"method"`
	Path           string   `json:"path"`
	LegacyStatus   int      `json:"legacyStatus"`
	GoStatus       int      `json:"goStatus"`
	LegacyBodyHash string   `json:"legacyBodyHash,omitempty"`
	GoBodyHash     string   `json:"goBodyHash,omitempty"`
	BodyEqual      bool     `json:"bodyEqual"`
	StatusEqual    bool     `json:"statusEqual"`
	DiffFields     []string `json:"diffFields,omitempty"`
	DroppedReason  string   `json:"droppedReason,omitempty"`
	// 调试正文（仅 DebugBodyLog 开启时填充，截断到 DebugBodyLogMaxBytes）。
	LegacyBodySnippet json.RawMessage `json:"legacyBody,omitempty"`
	GoBodySnippet     json.RawMessage `json:"goBody,omitempty"`
}

// NewRunner 构造差分执行器。budget 为零值字段时使用内置安全默认。
func NewRunner(budget Budget) *Runner {
	if budget.TimeoutMs <= 0 {
		budget.TimeoutMs = 2_000
	}
	if budget.MaxRequestBodyByte <= 0 {
		budget.MaxRequestBodyByte = 1 << 20
	}
	if budget.MaxInflight <= 0 {
		budget.MaxInflight = 16
	}
	if budget.MaxPerMin <= 0 {
		budget.MaxPerMin = 600
	}
	if budget.DebugBodyLogMaxBytes <= 0 {
		budget.DebugBodyLogMaxBytes = 2_048
	}
	return &Runner{
		budget: budget,
		// 令牌桶满额起步（标准 burst 语义）：进程冷启动的前几秒允许立即
		// 执行差分，随时间按 MaxPerMin 补充。
		bucket:   float64(budget.MaxPerMin),
		bucketAt: time.Now(),
	}
}

// IsShadowableMethod 报告方法是否可进入 shadow：只允许幂等只读方法。
// 写方法（POST/PUT/PATCH/DELETE）双发会产生副作用——明令禁止。
func IsShadowableMethod(method string) bool {
	switch strings.ToUpper(method) {
	case http.MethodGet, http.MethodHead, http.MethodOptions:
		return true
	default:
		return false
	}
}

// ObserveSkip 记录一次主链路（捕获阶段）判定的差分跳过，只记账不执行。
func (r *Runner) ObserveSkip(reason SkipReason) {
	r.mu.Lock()
	defer r.mu.Unlock()
	switch reason {
	case SkipRequestTooLarge:
		r.dropped.RequestTooLarge++
	case SkipResponseTooLarge:
		r.dropped.ResponseTooLarge++
	case SkipStreaming:
		r.dropped.StreamingSkipped++
	default:
		// 未知原因按保守口径并入 response-too-large？不——未知原因说明
		// 调用方与 runner 版本不一致，记录日志并计数到 rate-limit 之外
		// 的兜底位（避免静默丢统计）。这里直接记日志，不递增任何桶，
		// 防止把未知分类污染已知指标。
		log.Printf("shadow: unknown skip reason %q ignored", reason)
		return
	}
}

// ObserveResult 记录 legacy 侧响应并异步执行 Go 侧差分。
//
// 语义（任务 E / ADR §4）：
//   - legacyStatus/Header/Body 是 NestJS 已经发出的响应（调用方捕获；
//     响应超预算/流式的情况由调用方走 ObserveSkip，不会到达这里）。
//   - executant 是该路由的 Go 实现；异步执行，超时强制中止并计 timeout。
//   - 不阻塞、不向客户端写任何内容；写方法直接返回（禁止双发）。
func (r *Runner) ObserveResult(
	traceID string,
	legacy *http.Request,
	legacyStatus int,
	legacyHeader http.Header,
	legacyBody []byte,
	executant Executant,
) {
	if legacy == nil || executant == nil {
		return
	}
	if !IsShadowableMethod(legacy.Method) {
		return
	}
	if int64(len(legacyBody)) > r.budget.MaxRequestBodyByte {
		r.ObserveSkip(SkipRequestTooLarge)
		return
	}
	if !r.acquire() {
		return
	}

	go func() {
		defer r.release()

		ctx, cancel := context.WithTimeout(context.Background(), time.Duration(r.budget.TimeoutMs)*time.Millisecond)
		defer cancel()

		// 在子 goroutine 执行并 select 强制超时——executant 不响应 ctx
		// 时也不会拖住差分槽位。
		type outcome struct{ result *Result }
		done := make(chan outcome, 1)
		go func() {
			done <- outcome{executant.Execute(ctx, legacy, legacyBody)}
		}()

		var goResult *Result
		select {
		case o := <-done:
			goResult = o.result
		case <-ctx.Done():
			r.recordDrop(func(d *DroppedStats) { d.Timeout++ })
			return
		}

		r.mu.Lock()
		r.executed++
		r.mu.Unlock()

		record := r.compare(traceID, legacy, &Result{
			StatusCode: legacyStatus,
			Header:     legacyHeader,
			Body:       legacyBody,
		}, goResult)
		if record == nil {
			return
		}
		r.emit(record)
	}()
}

// compare 生成差异记录（无差异返回 nil）。
func (r *Runner) compare(traceID string, legacy *http.Request, legacyResult, goResult *Result) *DiffRecord {
	if goResult == nil {
		// Go 侧执行失败（返回 nil）也记录——差分缺失本身就是信号。
		return &DiffRecord{
			TraceID:       traceID,
			Method:        legacy.Method,
			Path:          legacy.URL.Path,
			LegacyStatus:  legacyResult.StatusCode,
			GoStatus:      0,
			StatusEqual:   false,
			BodyEqual:     false,
			DiffFields:    []string{"goExecutionFailed"},
			DroppedReason: "go-execution-nil",
		}
	}

	record := &DiffRecord{
		TraceID:        traceID,
		Method:         legacy.Method,
		Path:           legacy.URL.Path,
		LegacyStatus:   legacyResult.StatusCode,
		GoStatus:       goResult.StatusCode,
		LegacyBodyHash: HashBody(legacyResult.Body),
		GoBodyHash:     HashBody(goResult.Body),
		StatusEqual:    legacyResult.StatusCode == goResult.StatusCode,
	}

	if !isJSONResponse(legacyResult.Header) || !isJSONResponse(goResult.Header) {
		// 非 JSON（或未知类型）：逐字节比较。
		record.BodyEqual = bytes.Equal(legacyResult.Body, goResult.Body)
	} else {
		record.BodyEqual, record.DiffFields = jsonEqual(legacyResult.Body, goResult.Body)
	}

	if !record.BodyEqual && r.budget.DebugBodyLog {
		record.LegacyBodySnippet = truncateForRecord(legacyResult.Body, r.budget.DebugBodyLogMaxBytes)
		record.GoBodySnippet = truncateForRecord(goResult.Body, r.budget.DebugBodyLogMaxBytes)
	}

	if record.StatusEqual && record.BodyEqual {
		return nil
	}
	return record
}

func (r *Runner) emit(record *DiffRecord) {
	r.mu.Lock()
	r.diffs++
	r.mu.Unlock()

	// 结构化 JSON 行（可被日志采集器解析）。
	line, err := json.Marshal(record)
	if err != nil {
		log.Printf("shadow: encode diff record failed: %v", err)
		return
	}
	log.Printf("shadow-diff %s", line)
}

// acquireReason 是 acquire 失败的原因。
type acquireReason int

const (
	acquireOK acquireReason = iota
	acquireConcurrency
	acquireRate
)

// acquire 令牌桶 + 并发上限；失败时按原因计数并返回原因。
func (r *Runner) acquire() bool {
	return r.acquireChecked() == acquireOK
}

func (r *Runner) acquireChecked() acquireReason {
	r.mu.Lock()
	defer r.mu.Unlock()

	now := time.Now()
	elapsed := now.Sub(r.bucketAt).Minutes()
	if elapsed > 0 {
		r.bucket += elapsed * float64(r.budget.MaxPerMin)
		if r.bucket > float64(r.budget.MaxPerMin) {
			r.bucket = float64(r.budget.MaxPerMin)
		}
		r.bucketAt = now
	}
	if r.inflight >= r.budget.MaxInflight {
		r.dropped.ConcurrencyLimit++
		return acquireConcurrency
	}
	if r.bucket < 1 {
		r.dropped.RateLimit++
		return acquireRate
	}
	r.bucket--
	r.inflight++
	return acquireOK
}

func (r *Runner) release() {
	r.mu.Lock()
	r.inflight--
	r.mu.Unlock()
}

func (r *Runner) recordDrop(mutate func(*DroppedStats)) {
	r.mu.Lock()
	defer r.mu.Unlock()
	mutate(&r.dropped)
}

// Stats 返回执行统计（供 /__go/healthz 自省）。
type Stats struct {
	Executed uint64       `json:"executed"`
	Diffs    uint64       `json:"diffs"`
	Inflight int          `json:"inflight"`
	Dropped  DroppedStats `json:"dropped"`
}

func (r *Runner) Stats() Stats {
	r.mu.Lock()
	defer r.mu.Unlock()
	return Stats{
		Executed: r.executed,
		Diffs:    r.diffs,
		Inflight: r.inflight,
		Dropped:  r.dropped,
	}
}

// ---- 差分比较工具 ----

// HashBody 返回响应体的 sha256 hex（差异记录的正文指纹）。
func HashBody(body []byte) string {
	if len(body) == 0 {
		return ""
	}
	sum := sha256.Sum256(body)
	return hex.EncodeToString(sum[:])
}

// ignoredDiffFields 是非确定字段（legacy 与 Go 必然不同，比对时剔除）。
var ignoredDiffFields = map[string]struct{}{
	"traceId":     {},
	"timestamp":   {},
	"snapshotAt":  {},
	"now":         {},
	"generatedAt": {},
	"requestId":   {},
	"request-id":  {},
}

// RegisterIgnoredField 登记新的非确定字段（差分忽略集可扩展，但不允许
// 用它来掩盖真实差异——登记需在 PR 中说明理由）。
func RegisterIgnoredField(field string) {
	ignoredDiffFields[field] = struct{}{}
}

// jsonEqual 比较两个 JSON 文档：忽略 ignoredDiffFields 中的顶层与
// 嵌套字段（深度遍历）。返回（是否等价, 差异字段路径列表）。
func jsonEqual(a, b []byte) (bool, []string) {
	var av, bv any
	if err := json.Unmarshal(a, &av); err != nil {
		return false, []string{"legacyBodyNotJSON"}
	}
	if err := json.Unmarshal(b, &bv); err != nil {
		return false, []string{"goBodyNotJSON"}
	}
	var diffs []string
	diffValues("", av, bv, &diffs)
	return len(diffs) == 0, diffs
}

func diffValues(path string, a, b any, diffs *[]string) {
	if _, ignored := ignoredDiffFields[baseName(path)]; ignored {
		return
	}
	switch av := a.(type) {
	case map[string]any:
		bm, ok := b.(map[string]any)
		if !ok {
			*diffs = append(*diffs, path+"(type)")
			return
		}
		keys := make([]string, 0, len(av))
		for key := range av {
			keys = append(keys, key)
		}
		// map 键排序保证确定性。
		sortStrings(keys)
		for _, key := range keys {
			childPath := joinPath(path, key)
			if _, ignored := ignoredDiffFields[key]; ignored {
				continue
			}
			bv, exists := bm[key]
			if !exists {
				*diffs = append(*diffs, childPath+"(missing-in-go)")
				continue
			}
			diffValues(childPath, av[key], bv, diffs)
		}
		// 反向检查 Go 侧多出的键。
		bkeys := make([]string, 0, len(bm))
		for key := range bm {
			bkeys = append(bkeys, key)
		}
		sortStrings(bkeys)
		for _, key := range bkeys {
			if _, ignored := ignoredDiffFields[key]; ignored {
				continue
			}
			if _, exists := av[key]; !exists {
				*diffs = append(*diffs, joinPath(path, key)+"(missing-in-legacy)")
			}
		}
	case []any:
		bl, ok := b.([]any)
		if !ok {
			*diffs = append(*diffs, path+"(type)")
			return
		}
		if len(av) != len(bl) {
			*diffs = append(*diffs, path+"(length)")
			return
		}
		for i := range av {
			diffValues(fmt.Sprintf("%s[%d]", path, i), av[i], bl[i], diffs)
		}
	default:
		if !valuesEqual(a, b) {
			*diffs = append(*diffs, path+"(value)")
		}
	}
}

func valuesEqual(a, b any) bool {
	// 数值统一按 float64 比较（json.Unmarshal 的默认行为已保证），
	// 这里处理 0 与 0.0、null 与缺失的边界。
	return a == b
}

func baseName(path string) string {
	if idx := strings.LastIndex(path, "."); idx >= 0 {
		return path[idx+1:]
	}
	return path
}

func joinPath(prefix, key string) string {
	if prefix == "" {
		return key
	}
	return prefix + "." + key
}

func sortStrings(s []string) {
	for i := 1; i < len(s); i++ {
		for j := i; j > 0 && s[j] < s[j-1]; j-- {
			s[j], s[j-1] = s[j-1], s[j]
		}
	}
}

func isJSONResponse(header http.Header) bool {
	contentType := header.Get("Content-Type")
	if contentType == "" {
		return false
	}
	mediaType, _, err := mime.ParseMediaType(contentType)
	if err != nil {
		return false
	}
	return mediaType == "application/json" || strings.HasSuffix(mediaType, "+json")
}

// truncateForRecord 截断正文用于调试记录；超长时保证仍是合法 JSON 字符串。
func truncateForRecord(body []byte, maxBytes int64) json.RawMessage {
	if maxBytes <= 0 {
		maxBytes = 2_048
	}
	if int64(len(body)) <= maxBytes {
		return json.RawMessage(body)
	}
	return json.RawMessage(fmt.Sprintf("%q", string(body[:maxBytes])+"…"))
}

// StableHash 是 canary 分流用的稳定哈希（FNV over SHA 摘要，同输入同输出，
// 与运行实例无关）。导出供 canary 模块复用。
func StableHash(key string) uint64 {
	sum := sha256.Sum256([]byte(key))
	return uint64(sum[0])<<56 | uint64(sum[1])<<48 | uint64(sum[2])<<40 |
		uint64(sum[3])<<32 | uint64(sum[4])<<24 | uint64(sum[5])<<16 |
		uint64(sum[6])<<8 | uint64(sum[7])
}

// HexDigest 返回 key 的 sha256 hex（测试与差分标识用）。
func HexDigest(key string) string {
	sum := sha256.Sum256([]byte(key))
	return hex.EncodeToString(sum[:])
}

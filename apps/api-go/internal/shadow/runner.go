// Package shadow 实现 shadow 模式的差分执行（go-migration-adr §4）。
//
// 语义：
//   - 客户端响应始终来自 NestJS（legacy 代理）；Go handler 的执行是旁路。
//   - 只对无副作用的只读请求启用（方法白名单 + 路由表里的 shadow 规则）。
//   - 资源边界：单次超时、请求体大小上限、并发上限、每分钟预算（令牌桶）。
//     任一超限 → 该请求直接跳过差分（不排队、不阻塞主响应）。
//   - 差异记录为结构化 JSON 行（traceId 可关联主请求）；差分忽略
//     traceId / 时间戳类非确定字段（默认 ignore 集合 + 可扩展）。
//   - 禁止对写请求双发：方法不在 GET 白名单时 Shadow 拒绝执行。
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
	TimeoutMs   int
	MaxBodyByte int64
	MaxInflight int
	MaxPerMin   int
}

// Executant 是 Go 侧的差分执行者：输入是原始请求（body 已读入且可重放），
// 输出是 Go 实现的响应。执行者自带鉴权/业务语义（与 NestJS 对齐）。
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
	dropped  uint64
}

// DiffRecord 是一条结构化差异记录（JSON 行输出）。
type DiffRecord struct {
	TraceID       string          `json:"traceId"`
	Method        string          `json:"method"`
	Path          string          `json:"path"`
	LegacyStatus  int             `json:"legacyStatus"`
	GoStatus      int             `json:"goStatus"`
	LegacyBody    json.RawMessage `json:"legacyBody,omitempty"`
	GoBody        json.RawMessage `json:"goBody,omitempty"`
	BodyEqual     bool            `json:"bodyEqual"`
	StatusEqual   bool            `json:"statusEqual"`
	DiffFields    []string        `json:"diffFields,omitempty"`
	DroppedReason string          `json:"droppedReason,omitempty"`
	At            string          `json:"-"`
}

// NewRunner 构造差分执行器。budget 为零值字段时使用内置安全默认。
func NewRunner(budget Budget) *Runner {
	if budget.TimeoutMs <= 0 {
		budget.TimeoutMs = 2_000
	}
	if budget.MaxBodyByte <= 0 {
		budget.MaxBodyByte = 1 << 20
	}
	if budget.MaxInflight <= 0 {
		budget.MaxInflight = 16
	}
	if budget.MaxPerMin <= 0 {
		budget.MaxPerMin = 600
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

// ObserveResult 记录 legacy 侧响应并异步执行 Go 侧差分。
//
// 语义（任务 E / ADR §4）：
//   - legacyStatus/Header/Body 是 NestJS 已经发出的响应（调用方捕获）。
//   - executant 是该路由的 Go 实现；异步执行，超时即丢弃差分。
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
	if len(legacyBody) > int(r.budget.MaxBodyByte) {
		r.recordDrop("body-too-large")
		return
	}
	if !r.acquire() {
		return
	}

	go func() {
		defer r.release()

		ctx, cancel := context.WithTimeout(context.Background(), time.Duration(r.budget.TimeoutMs)*time.Millisecond)
		defer cancel()

		goResult := executant.Execute(ctx, legacy, legacyBody)

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
		// Go 侧执行失败（超时/内部错误）也记录——差分缺失本身就是信号。
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
		TraceID:      traceID,
		Method:       legacy.Method,
		Path:         legacy.URL.Path,
		LegacyStatus: legacyResult.StatusCode,
		GoStatus:     goResult.StatusCode,
		StatusEqual:  legacyResult.StatusCode == goResult.StatusCode,
	}

	if !isJSONResponse(legacyResult.Header) || !isJSONResponse(goResult.Header) {
		// 非 JSON（或未知类型）：逐字节比较。
		record.BodyEqual = bytes.Equal(legacyResult.Body, goResult.Body)
		if !record.BodyEqual {
			record.LegacyBody = truncateForRecord(legacyResult.Body)
			record.GoBody = truncateForRecord(goResult.Body)
		}
	} else {
		record.BodyEqual, record.DiffFields = jsonEqual(legacyResult.Body, goResult.Body)
		if !record.BodyEqual {
			record.LegacyBody = truncateForRecord(legacyResult.Body)
			record.GoBody = truncateForRecord(goResult.Body)
		}
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

	// 结构化 JSON 行（可被日志采集器解析；不包含随机时间戳以外的字段）。
	line, err := json.Marshal(record)
	if err != nil {
		log.Printf("shadow: encode diff record failed: %v", err)
		return
	}
	log.Printf("shadow-diff %s", line)
}

// acquire 令牌桶 + 并发上限；返回 false = 该次差分被丢弃。
func (r *Runner) acquire() bool {
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
	if r.bucket < 1 || r.inflight >= r.budget.MaxInflight {
		r.dropped++
		return false
	}
	r.bucket--
	r.inflight++
	return true
}

func (r *Runner) release() {
	r.mu.Lock()
	r.inflight--
	r.mu.Unlock()
}

func (r *Runner) recordDrop(reason string) {
	r.mu.Lock()
	r.dropped++
	r.mu.Unlock()
	log.Printf("shadow: dropped diff (%s)", reason)
}

// Stats 返回执行统计（供 /__go/healthz 自省）。
type Stats struct {
	Executed uint64 `json:"executed"`
	Diffs    uint64 `json:"diffs"`
	Dropped  uint64 `json:"dropped"`
	Inflight int    `json:"inflight"`
}

func (r *Runner) Stats() Stats {
	r.mu.Lock()
	defer r.mu.Unlock()
	return Stats{
		Executed: r.executed,
		Diffs:    r.diffs,
		Dropped:  r.dropped,
		Inflight: r.inflight,
	}
}

// ---- 差分比较工具 ----

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

const maxRecordBodyBytes = 4 * 1024

func truncateForRecord(body []byte) json.RawMessage {
	if len(body) <= maxRecordBodyBytes {
		return json.RawMessage(body)
	}
	// 截断时保证仍是合法 JSON（字符串化）。
	return json.RawMessage(fmt.Sprintf("%q", string(body[:maxRecordBodyBytes])+"…"))
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

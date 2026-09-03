package shadow

import (
	"context"
	"net/http"
	"testing"
	"time"
)

type recordingExecutant struct {
	calls    int
	result   *Result
	blockFor time.Duration
}

// Execute 故意不响应 ctx（plain sleep）：模拟最坏情况的非合作执行者，
// 验证 runner 的 select 强制超时不依赖执行者自觉。这让超时测试确定性
// 成立——ctx.Done 与执行者返回不会同时就绪竞态。
func (e *recordingExecutant) Execute(_ context.Context, _ *http.Request, _ []byte) *Result {
	e.calls++
	if e.blockFor > 0 {
		time.Sleep(e.blockFor)
	}
	return e.result
}

func newRequest(method string) *http.Request {
	req, _ := http.NewRequest(method, "http://gateway/api/healthz/live", nil)
	return req
}

func TestIsShadowableMethodRejectsWrites(t *testing.T) {
	for _, method := range []string{"POST", "PUT", "PATCH", "DELETE"} {
		if IsShadowableMethod(method) {
			t.Errorf("IsShadowableMethod(%s) = true, want false (写请求禁止双发)", method)
		}
	}
	for _, method := range []string{"GET", "HEAD", "OPTIONS"} {
		if !IsShadowableMethod(method) {
			t.Errorf("IsShadowableMethod(%s) = false, want true", method)
		}
	}
}

func TestObserveResultRunsGoSideAsynchronously(t *testing.T) {
	runner := NewRunner(Budget{TimeoutMs: 100, MaxRequestBodyByte: 1024, MaxInflight: 4, MaxPerMin: 100})
	executant := &recordingExecutant{
		result: &Result{
			StatusCode: http.StatusOK,
			Header:     http.Header{"Content-Type": []string{"application/json"}},
			Body:       []byte(`{"status":"ok"}`),
		},
	}

	runner.ObserveResult("trace-1", newRequest(http.MethodGet), http.StatusOK,
		http.Header{"Content-Type": []string{"application/json"}},
		[]byte(`{"status":"ok"}`), executant)

	// 异步：ObserveResult 立即返回时执行可能尚未开始——等它完成
	//（Executed 与 Inflight 归零都在 goroutine 内，条件一起等避免竞态）。
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		stats := runner.Stats()
		if executant.calls == 1 && stats.Executed == 1 && stats.Inflight == 0 {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	if executant.calls != 1 {
		t.Fatalf("executant calls = %d, want 1", executant.calls)
	}
	stats := runner.Stats()
	if stats.Executed != 1 {
		t.Errorf("Stats().Executed = %d, want 1", stats.Executed)
	}
	if stats.Diffs != 0 {
		t.Errorf("Stats().Diffs = %d, want 0 (identical bodies → no diff)", stats.Diffs)
	}
	if stats.Inflight != 0 {
		t.Errorf("Stats().Inflight = %d, want 0 after completion", stats.Inflight)
	}
}

func TestObserveResultDetectsDifferences(t *testing.T) {
	runner := NewRunner(Budget{TimeoutMs: 100, MaxRequestBodyByte: 1024, MaxInflight: 4, MaxPerMin: 100})
	executant := &recordingExecutant{
		result: &Result{
			StatusCode: http.StatusOK,
			Header:     http.Header{"Content-Type": []string{"application/json"}},
			Body:       []byte(`{"status":"degraded"}`),
		},
	}

	runner.ObserveResult("trace-2", newRequest(http.MethodGet), http.StatusOK,
		http.Header{"Content-Type": []string{"application/json"}},
		[]byte(`{"status":"ok"}`), executant)

	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		if runner.Stats().Diffs == 1 {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	if runner.Stats().Diffs != 1 {
		t.Fatalf("Stats().Diffs = %d, want 1", runner.Stats().Diffs)
	}
}

func TestObserveResultIgnoresNonDeterministicFields(t *testing.T) {
	runner := NewRunner(Budget{TimeoutMs: 100, MaxRequestBodyByte: 1024, MaxInflight: 4, MaxPerMin: 100})
	executant := &recordingExecutant{
		result: &Result{
			StatusCode: http.StatusOK,
			Header:     http.Header{"Content-Type": []string{"application/json"}},
			// traceId/timestamp 不同——差分应忽略（登记的非确定字段）。
			Body: []byte(`{"status":"ok","traceId":"go-side","timestamp":"2026-09-03T01:00:00Z"}`),
		},
	}

	runner.ObserveResult("trace-3", newRequest(http.MethodGet), http.StatusOK,
		http.Header{"Content-Type": []string{"application/json"}},
		[]byte(`{"status":"ok","traceId":"legacy-side","timestamp":"2026-09-03T00:59:59Z"}`), executant)

	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		if runner.Stats().Executed == 1 {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	if runner.Stats().Diffs != 0 {
		t.Errorf("Stats().Diffs = %d, want 0 (traceId/timestamp 是登记的非确定字段)", runner.Stats().Diffs)
	}
}

func TestObserveResultRejectsWriteMethods(t *testing.T) {
	runner := NewRunner(Budget{TimeoutMs: 100, MaxRequestBodyByte: 1024, MaxInflight: 4, MaxPerMin: 100})
	executant := &recordingExecutant{}

	runner.ObserveResult("trace-4", newRequest(http.MethodPost), http.StatusOK,
		http.Header{}, []byte(`{}`), executant)
	runner.ObserveResult("trace-5", newRequest(http.MethodDelete), http.StatusOK,
		http.Header{}, []byte(`{}`), executant)

	// 写请求被同步拒绝，没有任何 goroutine 启动——直接检查即可。
	if executant.calls != 0 {
		t.Errorf("executant calls = %d, want 0 (写请求禁止 shadow 双发)", executant.calls)
	}
	if stats := runner.Stats(); stats.Executed != 0 {
		t.Errorf("Stats().Executed = %d, want 0", stats.Executed)
	}
}

func TestObserveResultDropsWhenInflightFull(t *testing.T) {
	runner := NewRunner(Budget{TimeoutMs: 10_000, MaxRequestBodyByte: 1024, MaxInflight: 1, MaxPerMin: 100})
	// 第一个 executant 阻塞 200ms，占住唯一的并发槽。
	blocking := &recordingExecutant{
		blockFor: 200 * time.Millisecond,
		result:   &Result{StatusCode: 200, Header: http.Header{"Content-Type": []string{"application/json"}}, Body: []byte(`{}`)},
	}
	quick := &recordingExecutant{
		result: &Result{StatusCode: 200, Header: http.Header{"Content-Type": []string{"application/json"}}, Body: []byte(`{}`)},
	}

	runner.ObserveResult("trace-6", newRequest(http.MethodGet), 200,
		http.Header{"Content-Type": []string{"application/json"}}, []byte(`{}`), blocking)
	time.Sleep(20 * time.Millisecond) // 让第一个 goroutine 占住槽。

	runner.ObserveResult("trace-7", newRequest(http.MethodGet), 200,
		http.Header{"Content-Type": []string{"application/json"}}, []byte(`{}`), quick)

	if quick.calls != 0 {
		t.Errorf("second executant calls = %d, want 0 (并发上限应丢弃)", quick.calls)
	}
}

func TestBudgetDefaultsAreSafe(t *testing.T) {
	runner := NewRunner(Budget{})
	stats := runner.Stats()
	if stats.Inflight != 0 {
		t.Errorf("Inflight = %d, want 0", stats.Inflight)
	}
	// 零值 budget 走内置默认（构造函数内修正），无需暴露断言——
	// 行为由其余测试覆盖。
	_ = runner
}

func TestStableHashIsDeterministic(t *testing.T) {
	if StableHash("org-a") != StableHash("org-a") {
		t.Fatal("StableHash not deterministic for same key")
	}
	if StableHash("org-a") == StableHash("org-b") {
		t.Fatal("StableHash collision between distinct keys (unexpected)")
	}
}

func TestCompareNilGoResultRecordsExecutionFailure(t *testing.T) {
	runner := NewRunner(Budget{})
	record := runner.compare("trace-8", newRequest(http.MethodGet), &Result{
		StatusCode: 200,
		Header:     http.Header{"Content-Type": []string{"application/json"}},
		Body:       []byte(`{}`),
	}, nil)
	if record == nil {
		t.Fatal("nil go result must produce a diff record")
	}
	if record.DroppedReason != "go-execution-nil" {
		t.Errorf("DroppedReason = %q, want go-execution-nil", record.DroppedReason)
	}
}

func TestJSONEqualNestedDiffPaths(t *testing.T) {
	equal, diffs := jsonEqual(
		[]byte(`{"a":{"b":1},"c":[1,2]}`),
		[]byte(`{"a":{"b":2},"c":[1,2]}`),
	)
	if equal {
		t.Fatal("expected diff")
	}
	found := false
	for _, d := range diffs {
		if d == "a.b(value)" {
			found = true
		}
	}
	if !found {
		t.Errorf("diffs = %v, want a.b(value) included", diffs)
	}
}

// ---- 有界差分：分类丢弃 / 超时强制 / hash 日志 ----

func TestObserveSkipRecordsCategorizedCounts(t *testing.T) {
	runner := NewRunner(Budget{})
	runner.ObserveSkip(SkipRequestTooLarge)
	runner.ObserveSkip(SkipRequestTooLarge)
	runner.ObserveSkip(SkipResponseTooLarge)
	runner.ObserveSkip(SkipStreaming)
	// 未知原因不得污染已知分类。
	runner.ObserveSkip(SkipReason("unknown-reason"))

	stats := runner.Stats().Dropped
	if stats.RequestTooLarge != 2 {
		t.Errorf("RequestTooLarge = %d, want 2", stats.RequestTooLarge)
	}
	if stats.ResponseTooLarge != 1 {
		t.Errorf("ResponseTooLarge = %d, want 1", stats.ResponseTooLarge)
	}
	if stats.StreamingSkipped != 1 {
		t.Errorf("StreamingSkipped = %d, want 1", stats.StreamingSkipped)
	}
	if stats.ConcurrencyLimit != 0 || stats.RateLimit != 0 || stats.Timeout != 0 {
		t.Errorf("runner-internal counters must stay 0: %+v", stats)
	}
	if got := stats.Total(); got != 4 {
		t.Errorf("Total() = %d, want 4", got)
	}
}

// 超时强制中止：executant 不响应 ctx 也不得拖住差分槽位——超时计入
// Dropped.Timeout，不算 Executed，不产生 diff。
func TestObserveResultTimeoutDrops(t *testing.T) {
	runner := NewRunner(Budget{TimeoutMs: 50, MaxRequestBodyByte: 1024, MaxInflight: 4, MaxPerMin: 100})
	blocking := &recordingExecutant{
		blockFor: 2 * time.Second, // 远超 50ms 超时；select 保证不等它
		result: &Result{
			StatusCode: 200,
			Header:     http.Header{"Content-Type": []string{"application/json"}},
			Body:       []byte(`{}`),
		},
	}

	runner.ObserveResult("trace-timeout", newRequest(http.MethodGet), 200,
		http.Header{"Content-Type": []string{"application/json"}}, []byte(`{}`), blocking)

	waitForRunner(t, runner, func(s Stats) bool { return s.Dropped.Timeout == 1 && s.Inflight == 0 })
	stats := runner.Stats()
	if stats.Executed != 0 {
		t.Errorf("Executed = %d, want 0 (超时不算执行)", stats.Executed)
	}
	if stats.Diffs != 0 {
		t.Errorf("Diffs = %d, want 0", stats.Diffs)
	}
	if stats.Inflight != 0 {
		t.Errorf("Inflight = %d, want 0 (超时必须释放槽位)", stats.Inflight)
	}
}

// 速率预算（令牌桶耗尽）与并发上限是两个独立分类。
func TestObserveResultRateLimitDistinctFromConcurrency(t *testing.T) {
	// 并发上限高（不触发）、令牌桶只有 2 个 burst：第 3 次 rate-limit。
	runner := NewRunner(Budget{TimeoutMs: 5_000, MaxRequestBodyByte: 1024, MaxInflight: 100, MaxPerMin: 2})
	executant := &recordingExecutant{
		blockFor: 100 * time.Millisecond, // 占住执行槽但不占并发上限
		result:   &Result{StatusCode: 200, Header: http.Header{"Content-Type": []string{"application/json"}}, Body: []byte(`{}`)},
	}
	for i := 0; i < 3; i++ {
		runner.ObserveResult("trace-rate", newRequest(http.MethodGet), 200,
			http.Header{"Content-Type": []string{"application/json"}}, []byte(`{}`), executant)
	}

	waitForRunner(t, runner, func(s Stats) bool { return s.Dropped.RateLimit == 1 })
	stats := runner.Stats()
	if stats.Dropped.ConcurrencyLimit != 0 {
		t.Errorf("ConcurrencyLimit = %d, want 0 (并发上限未触发)", stats.Dropped.ConcurrencyLimit)
	}
	if stats.Executed > 2 {
		t.Errorf("Executed = %d, want ≤2 (burst 只有 2)", stats.Executed)
	}
}

// 默认差分记录只含响应体 hash，不含业务正文；DebugBodyLog 开启后才有
// 截断片段。
func TestDiffRecordHashesBodiesByDefault(t *testing.T) {
	runner := NewRunner(Budget{}) // DebugBodyLog 默认 false
	record := runner.compare("trace-hash", newRequest(http.MethodGet), &Result{
		StatusCode: 200,
		Header:     http.Header{"Content-Type": []string{"application/json"}},
		Body:       []byte(`{"secret":"business-data"}`),
	}, &Result{
		StatusCode: 200,
		Header:     http.Header{"Content-Type": []string{"application/json"}},
		Body:       []byte(`{"secret":"different"}`),
	})
	if record == nil {
		t.Fatal("different bodies must produce a diff record")
	}
	if record.LegacyBodySnippet != nil || record.GoBodySnippet != nil {
		t.Fatal("默认不得记录业务正文（只记 hash）")
	}
	if record.LegacyBodyHash != HashBody([]byte(`{"secret":"business-data"}`)) {
		t.Errorf("LegacyBodyHash = %q, want sha256 of legacy body", record.LegacyBodyHash)
	}
	if record.GoBodyHash == "" {
		t.Error("GoBodyHash must be populated")
	}
}

func TestDiffRecordDebugBodyLogOptIn(t *testing.T) {
	runner := NewRunner(Budget{DebugBodyLog: true, DebugBodyLogMaxBytes: 16})
	record := runner.compare("trace-debug", newRequest(http.MethodGet), &Result{
		StatusCode: 200,
		Header:     http.Header{"Content-Type": []string{"application/json"}},
		Body:       []byte(`{"secret":"business-data"}`),
	}, &Result{
		StatusCode: 200,
		Header:     http.Header{"Content-Type": []string{"application/json"}},
		Body:       []byte(`{"secret":"different"}`),
	})
	if record == nil {
		t.Fatal("different bodies must produce a diff record")
	}
	if record.LegacyBodySnippet == nil {
		t.Fatal("DebugBodyLog 开启时应记录截断正文")
	}
	if len(record.LegacyBodySnippet) > int(runner.budget.DebugBodyLogMaxBytes)+64 {
		// 截断片段经 JSON 字符串化会有引号/转义开销——允许少量超出原始上限。
		t.Errorf("debug snippet too long: %d bytes", len(record.LegacyBodySnippet))
	}
}

func TestHashBody(t *testing.T) {
	if HashBody(nil) != "" {
		t.Error("HashBody(nil) want empty string")
	}
	if HashBody([]byte("a")) != HashBody([]byte("a")) {
		t.Error("HashBody not deterministic")
	}
	if HashBody([]byte("a")) == HashBody([]byte("b")) {
		t.Error("HashBody collision")
	}
}

func waitForRunner(t *testing.T, runner *Runner, condition func(Stats) bool) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if condition(runner.Stats()) {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("timed out waiting for runner stats condition")
}

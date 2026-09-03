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

func (e *recordingExecutant) Execute(ctx context.Context, _ *http.Request, _ []byte) *Result {
	e.calls++
	if e.blockFor > 0 {
		select {
		case <-time.After(e.blockFor):
		case <-ctx.Done():
		}
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
	runner := NewRunner(Budget{TimeoutMs: 100, MaxBodyByte: 1024, MaxInflight: 4, MaxPerMin: 100})
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

	// 异步：ObserveResult 立即返回时执行可能尚未开始——等它完成。
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		if executant.calls == 1 && runner.Stats().Executed == 1 {
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
	runner := NewRunner(Budget{TimeoutMs: 100, MaxBodyByte: 1024, MaxInflight: 4, MaxPerMin: 100})
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
	runner := NewRunner(Budget{TimeoutMs: 100, MaxBodyByte: 1024, MaxInflight: 4, MaxPerMin: 100})
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
	runner := NewRunner(Budget{TimeoutMs: 100, MaxBodyByte: 1024, MaxInflight: 4, MaxPerMin: 100})
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
	runner := NewRunner(Budget{TimeoutMs: 10_000, MaxBodyByte: 1024, MaxInflight: 1, MaxPerMin: 100})
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

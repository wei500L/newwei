package policy

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/redis/go-redis/v9"
)

// fakeSettingsReader stands in for MySQLSettingsReader. deadlineSeen records the
// time left on the context BudgetFor passes in, so the bounded read is testable.
type fakeSettingsReader struct {
	limit        int
	window       int
	ok           bool
	err          error
	calls        int
	deadlineSeen time.Duration
}

func (f *fakeSettingsReader) LoginBucket(ctx context.Context) (int, int, bool, error) {
	f.calls++
	if deadline, ok := ctx.Deadline(); ok {
		f.deadlineSeen = time.Until(deadline)
	}
	return f.limit, f.window, f.ok, f.err
}

// fakeGetter stands in for the Redis read of the shared rate_limit:settings
// document: payload with a nil error is a hit, err is a miss (redis.Nil) or a
// transport failure.
type fakeGetter struct {
	payload string
	err     error
	calls   int
}

func (f *fakeGetter) Get(context.Context, string) *redis.StringCmd {
	f.calls++
	return redis.NewStringResult(f.payload, f.err)
}

func newTestLimiter(cache *fakeGetter, reader RateLimitSettingsReader) *Limiter {
	limiter := NewLimiter(nil, 5, 60, false)
	if cache != nil {
		limiter.settingsCache = cache
	}
	if reader != nil {
		limiter.WithSettingsReader(reader)
	}
	return limiter
}

// TestBudgetForFallsBackToDatabaseWhenCacheMisses is the R1-02 regression: the
// admin-configured SystemSetting row must win over the environment defaults when
// the shared Redis document expired.
func TestBudgetForFallsBackToDatabaseWhenCacheMisses(t *testing.T) {
	reader := &fakeSettingsReader{limit: 20, window: 120, ok: true}
	budget := newTestLimiter(&fakeGetter{err: redis.Nil}, reader).BudgetFor(context.Background())

	if budget.Limit != 600 || budget.WindowSeconds != 120 {
		t.Fatalf("budget = %+v, want {600 120}", budget)
	}
	if reader.calls != 1 {
		t.Fatalf("settings reader calls = %d, want 1", reader.calls)
	}
	if reader.deadlineSeen <= 0 || reader.deadlineSeen > settingsReadTimeout {
		t.Fatalf("database read deadline = %v, want (0, %v]", reader.deadlineSeen, settingsReadTimeout)
	}
}

// TestBudgetForFallsBackToDatabaseWhenCacheDocumentHasNoLoginBucket covers a
// cache entry that exists but cannot supply the login bucket: NestJS would treat
// the value as unusable, so the row is read instead of skipping straight to the
// environment.
func TestBudgetForFallsBackToDatabaseWhenCacheDocumentHasNoLoginBucket(t *testing.T) {
	cache := &fakeGetter{payload: `{"crawlCreate":{"limit":5,"windowSeconds":60}}`}
	reader := &fakeSettingsReader{limit: 8, window: 45, ok: true}
	budget := newTestLimiter(cache, reader).BudgetFor(context.Background())

	if budget.Limit != 240 || budget.WindowSeconds != 45 {
		t.Fatalf("budget = %+v, want {240 45}", budget)
	}
	if reader.calls != 1 {
		t.Fatalf("settings reader calls = %d, want 1", reader.calls)
	}
}

// TestBudgetForUsesEnvironmentWhenDatabaseMisses covers a missing row and a
// failing database: both degrade to the environment defaults instead of opening
// the bucket.
func TestBudgetForUsesEnvironmentWhenDatabaseMisses(t *testing.T) {
	cases := []struct {
		name   string
		reader *fakeSettingsReader
	}{
		{name: "no configured row", reader: &fakeSettingsReader{ok: false}},
		{name: "database error", reader: &fakeSettingsReader{err: errors.New("mysql unavailable")}},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			budget := newTestLimiter(&fakeGetter{err: redis.Nil}, testCase.reader).BudgetFor(context.Background())
			if budget.Limit != 150 || budget.WindowSeconds != 60 {
				t.Fatalf("budget = %+v, want the environment default {150 60}", budget)
			}
		})
	}
}

// TestBudgetForPrefersCacheOverDatabase keeps the NestJS order: a usable cache
// document means no database read at all.
func TestBudgetForPrefersCacheOverDatabase(t *testing.T) {
	cache := &fakeGetter{payload: `{"login":{"limit":5,"windowSeconds":60}}`}
	reader := &fakeSettingsReader{limit: 20, window: 120, ok: true}
	budget := newTestLimiter(cache, reader).BudgetFor(context.Background())

	if budget.Limit != 150 || budget.WindowSeconds != 60 {
		t.Fatalf("budget = %+v, want the cached bucket {150 60}", budget)
	}
	if reader.calls != 0 {
		t.Fatalf("settings reader calls = %d, want 0", reader.calls)
	}
}

// TestBudgetForClampsDatabaseBucket keeps the RateLimitConfigService clamps and
// the max(limit*30, 120) rule for values that come from the database.
func TestBudgetForClampsDatabaseBucket(t *testing.T) {
	cases := []struct {
		name       string
		limit      int
		window     int
		wantLimit  int
		wantWindow int
	}{
		{name: "limit above the maximum", limit: 5000, window: 1, wantLimit: 30000, wantWindow: 5},
		{name: "limit below the minimum", limit: 0, window: 2, wantLimit: 120, wantWindow: 5},
		{name: "window above the maximum", limit: 3, window: 999999, wantLimit: 120, wantWindow: 86400},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			reader := &fakeSettingsReader{limit: testCase.limit, window: testCase.window, ok: true}
			budget := newTestLimiter(&fakeGetter{err: redis.Nil}, reader).BudgetFor(context.Background())
			if budget.Limit != testCase.wantLimit || budget.WindowSeconds != testCase.wantWindow {
				t.Fatalf("budget = %+v, want {%d %d}", budget, testCase.wantLimit, testCase.wantWindow)
			}
		})
	}
}

// TestBudgetForWithoutSettingsReaderKeepsEnvironmentDefaults covers a limiter
// built without the MySQL reader and a nil receiver.
func TestBudgetForWithoutSettingsReaderKeepsEnvironmentDefaults(t *testing.T) {
	budget := newTestLimiter(&fakeGetter{err: redis.Nil}, nil).BudgetFor(context.Background())
	if budget.Limit != 150 || budget.WindowSeconds != 60 {
		t.Fatalf("budget = %+v, want {150 60}", budget)
	}

	var nilLimiter *Limiter
	fallback := nilLimiter.BudgetFor(context.Background())
	if fallback.Limit != 150 || fallback.WindowSeconds != 60 {
		t.Fatalf("nil limiter budget = %+v, want {150 60}", fallback)
	}
}

// TestMySQLSettingsReaderWithoutDatabase verifies the reader reports "no
// configured value" (not an error) when it has no handle, so the limiter keeps the
// environment defaults.
func TestMySQLSettingsReaderWithoutDatabase(t *testing.T) {
	reader := NewMySQLSettingsReader(nil)
	limit, window, ok, err := reader.LoginBucket(context.Background())
	if limit != 0 || window != 0 || ok || err != nil {
		t.Fatalf("LoginBucket = (%d, %d, %v, %v), want a clean miss", limit, window, ok, err)
	}

	var nilReader *MySQLSettingsReader
	limit, window, ok, err = nilReader.LoginBucket(context.Background())
	if limit != 0 || window != 0 || ok || err != nil {
		t.Fatalf("nil reader LoginBucket = (%d, %d, %v, %v), want a clean miss", limit, window, ok, err)
	}
}

// TestLoginBucketValueDecoding pins the SystemSetting.value shape written by
// RateLimitConfigService.updateRateLimitSettings.
func TestLoginBucketValueDecoding(t *testing.T) {
	var value loginBucketValue
	if err := json.Unmarshal([]byte(`{"limit":12,"windowSeconds":30}`), &value); err != nil {
		t.Fatalf("decode: %v", err)
	}
	limit, okLimit := floorJSONNumber(value.Limit)
	window, okWindow := floorJSONNumber(value.WindowSeconds)
	if !okLimit || !okWindow || limit != 12 || window != 30 {
		t.Fatalf("decoded bucket = (%d, %d, %v, %v), want (12, 30, true, true)", limit, window, okLimit, okWindow)
	}
}

// TestFloorJSONNumber mirrors Math.floor and rejects non-numeric values.
func TestFloorJSONNumber(t *testing.T) {
	cases := []struct {
		raw  string
		want int
		ok   bool
	}{
		{raw: "5", want: 5, ok: true},
		{raw: "5.9", want: 5, ok: true},
		{raw: "-2.5", want: -3, ok: true},
		{raw: "", want: 0, ok: false},
		{raw: "abc", want: 0, ok: false},
		{raw: "NaN", want: 0, ok: false},
	}
	for _, testCase := range cases {
		got, ok := floorJSONNumber(json.Number(testCase.raw))
		if ok != testCase.ok || got != testCase.want {
			t.Fatalf("floorJSONNumber(%q) = (%d, %v), want (%d, %v)", testCase.raw, got, ok, testCase.want, testCase.ok)
		}
	}
}

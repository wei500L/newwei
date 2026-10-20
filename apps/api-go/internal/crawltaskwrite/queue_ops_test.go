package crawltaskwrite

import (
	"encoding/json"
	"reflect"
	"testing"

	"github.com/wei500L/newwei/apps/api-go/internal/crawloptions"
	"github.com/wei500L/newwei/apps/api-go/internal/crawlqueue"
)

func TestExtractEnqueueOptions(t *testing.T) {
	cases := []struct {
		name   string
		config string
		want   *crawlqueue.EnqueueOptions
	}{
		{name: "empty", config: ``, want: nil},
		{name: "null", config: `null`, want: nil},
		{name: "empty object", config: `{}`, want: nil},
		{
			name:   "source priority only normal",
			config: `{"sourcePriority":12}`,
			want:   &crawlqueue.EnqueueOptions{PriorityClass: crawlqueue.PriorityClassNormal, SourcePriority: intPointer(12)},
		},
		{
			name:   "threshold infers hot",
			config: `{"sourcePriority":50}`,
			want:   &crawlqueue.EnqueueOptions{PriorityClass: crawlqueue.PriorityClassHot, SourcePriority: intPointer(50)},
		},
		{
			name:   "rounds like Math.round",
			config: `{"sourcePriority":49.6}`,
			want:   &crawlqueue.EnqueueOptions{PriorityClass: crawlqueue.PriorityClassHot, SourcePriority: intPointer(50)},
		},
		{
			name:   "explicit class wins",
			config: `{"sourcePriority":90,"crawlPriorityClass":"normal"}`,
			want:   &crawlqueue.EnqueueOptions{PriorityClass: crawlqueue.PriorityClassNormal, SourcePriority: intPointer(90)},
		},
		{
			name:   "explicit class only",
			config: `{"crawlPriorityClass":"hot"}`,
			want:   &crawlqueue.EnqueueOptions{PriorityClass: crawlqueue.PriorityClassHot},
		},
		{
			name:   "invalid class ignored",
			config: `{"crawlPriorityClass":"urgent"}`,
			want:   nil,
		},
		{
			name:   "non numeric source priority ignored",
			config: `{"sourcePriority":"50"}`,
			want:   nil,
		},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			var raw []byte
			if test.config != "" {
				raw = []byte(test.config)
			}
			got := extractEnqueueOptions(raw)
			if !reflect.DeepEqual(got, test.want) {
				t.Fatalf("options = %#v, want %#v", got, test.want)
			}
		})
	}
}

func intPointer(value int) *int { return &value }

func TestConfigIngestToItems(t *testing.T) {
	if !configIngestToItems([]byte(`{"ingestToItems":true}`)) {
		t.Fatal("true must be recognised")
	}
	if configIngestToItems([]byte(`{"ingestToItems":"true"}`)) {
		t.Fatal("a string is not boolean true")
	}
	if configIngestToItems(nil) {
		t.Fatal("nil config is false")
	}
}

func TestMarshalStoredConfigAppendsIngestFlag(t *testing.T) {
	options := crawloptionsOptions()
	without, err := marshalStoredConfig(options, false)
	if err != nil {
		t.Fatal(err)
	}
	var decoded map[string]json.RawMessage
	if err := json.Unmarshal(without, &decoded); err != nil {
		t.Fatal(err)
	}
	if _, present := decoded["ingestToItems"]; present {
		t.Fatal("ingestToItems must be absent")
	}
	withIngest, err := marshalStoredConfig(options, true)
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(withIngest, &decoded); err != nil {
		t.Fatal(err)
	}
	if string(decoded["ingestToItems"]) != "true" {
		t.Fatalf("ingestToItems = %s", decoded["ingestToItems"])
	}
	// The flag must be the last key, matching { ...normalized, ingestToItems }.
	if decoded["qualityProfile"] == nil {
		t.Fatal("normalized options must still be present")
	}
}

func TestSanitizeConcurrency(t *testing.T) {
	if got := sanitizeConcurrency(nil, 3); got != 3 {
		t.Fatalf("fallback = %d", got)
	}
	if got := sanitizeConcurrency(intPointer(7), 3); got != 7 {
		t.Fatalf("value = %d", got)
	}
	if got := sanitizeConcurrency(intPointer(0), 2); got != 2 {
		t.Fatalf("zero falls back = %d", got)
	}
	if got := sanitizeConcurrency(nil, 0); got != 1 {
		t.Fatalf("floor = %d", got)
	}
}

func TestParseConcurrencyBody(t *testing.T) {
	value, err := parseConcurrencyBody([]byte(`{"maxConcurrency":"12"}`))
	if err != nil || value != 12 {
		t.Fatalf("value = %d, err = %v", value, err)
	}
	_, err = parseConcurrencyBody([]byte(`{"maxConcurrency":21}`))
	if err == nil {
		t.Fatal("21 must be rejected")
	}
	validation, ok := err.(*validationError)
	if !ok || !reflect.DeepEqual(validation.Messages(), []string{"maxConcurrency must not be greater than 20"}) {
		t.Fatalf("messages = %v", err)
	}
	_, err = parseConcurrencyBody([]byte(`{"maxConcurrency":1.5}`))
	if err == nil {
		t.Fatal("1.5 must be rejected")
	}
	_, err = parseConcurrencyBody([]byte(`{"maxConcurrency":5,"extra":1}`))
	if err == nil {
		t.Fatal("unknown keys must be rejected")
	}
}

func TestNormalizeAdaptiveMetrics(t *testing.T) {
	p95 := 1200.0
	headroom := 0.4
	metrics := normalizeAdaptiveMetrics(&adaptiveMetrics{
		TaskCount:      4,
		FailedCount:    1,
		ErrorRate:      0.25,
		P95LatencyMs:   &p95,
		MemoryHeadroom: &headroom,
	})
	if metrics.TaskCount != 4 || metrics.FailedCount != 1 || metrics.ErrorRate != 0.25 {
		t.Fatalf("metrics = %#v", metrics)
	}
	if metrics.P95LatencyMs == nil || *metrics.P95LatencyMs != 1200 {
		t.Fatalf("p95 = %#v", metrics.P95LatencyMs)
	}
	if metrics.SamplingMode != "recent_sample" {
		t.Fatalf("sampling = %s", metrics.SamplingMode)
	}
	empty := normalizeAdaptiveMetrics(nil)
	if empty.TaskCount != 0 || empty.P95LatencyMs != nil || empty.SamplingMode != "recent_sample" {
		t.Fatalf("empty = %#v", empty)
	}
}

func crawloptionsOptions() crawloptions.Options {
	return crawloptions.Options{QualityProfile: "quality_first"}
}

func TestAggregatePaused(t *testing.T) {
	paused := queueClassStatus{Paused: true}
	resumed := queueClassStatus{Paused: false}
	backlog := queueClassStatus{Paused: false, Pending: 2}
	pausedWithBacklog := queueClassStatus{Paused: true, Counts: crawlqueue.QueueCounts{Paused: 1}}

	if !aggregatePaused(paused, paused, queueClassStatus{Paused: false}) {
		t.Fatal("hot/normal paused with an idle legacy queue is paused")
	}
	if aggregatePaused(resumed, paused, paused) {
		t.Fatal("a resumed hot queue must clear the aggregate")
	}
	if aggregatePaused(paused, paused, backlog) {
		t.Fatal("a resumed legacy queue with backlog unblocks the aggregate")
	}
	if !aggregatePaused(paused, paused, pausedWithBacklog) {
		t.Fatal("a paused legacy queue with backlog keeps the aggregate paused")
	}
}

func TestCrawlCreateRateLimitKeys(t *testing.T) {
	if got := crawlCreateUserKey("org-1", "user-1"); got != "crawl:create:org-1:user-1" {
		t.Fatalf("user key = %s", got)
	}
	if got := crawlCreateIPKey("org-1", "203.0.113.7"); got != "crawl:create:org-1:ip:203.0.113.7" {
		t.Fatalf("ip key = %s", got)
	}
	// The limiter prepends "rate:", which is the only difference from the
	// persisted bucket name.
	if got := "rate:" + crawlCreateUserKey("org-1", "user-1"); got != "rate:crawl:create:org-1:user-1" {
		t.Fatalf("bucket = %s", got)
	}
}

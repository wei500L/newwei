package llmlogs

import (
	"context"
	"math"
	"strings"
	"testing"
	"time"
)

func TestCompletionMetadataDefaultPolicyKeepsOnlyFeature(t *testing.T) {
	service := &Service{}
	kept := service.filterCompletionMetadata(context.Background(), &CompletionMetadata{
		Feature:    "news_event_brief",
		EventTitle: "Some event title",
		Sources:    3,
	})
	if kept == nil {
		t.Fatal("metadata must not collapse to null")
	}
	if len(*kept) != 1 || (*kept)[0].Key != "feature" || (*kept)[0].Value != "news_event_brief" {
		t.Fatalf("metadata = %#v", *kept)
	}
}

func TestCompletionMetadataCustomPolicyAndTruncation(t *testing.T) {
	if !metadataKeyAllowed("eventtitle", map[string]struct{}{"eventtitle": {}}, nil) {
		t.Fatal("exact allowlist key must pass")
	}
	if metadataKeyAllowed("sources", map[string]struct{}{"source": {}}, nil) {
		t.Fatal("a singular key must not match the plural one")
	}
	if !metadataKeyAllowed("x_trace", map[string]struct{}{}, []string{"x_"}) {
		t.Fatal("allowed prefix must pass")
	}
	if metadataKeyAllowed("eventtitle", map[string]struct{}{}, []string{"meta_"}) {
		t.Fatal("unlisted prefix must fail")
	}

	long := strings.Repeat("x", maxMetadataStringLength+20)
	entry := completionMetadataEntry{Key: "eventTitle", Text: &long}
	value, ok := entry.bsonValue()
	if !ok {
		t.Fatal("string value must survive")
	}
	text, _ := value.(string)
	if !strings.HasSuffix(text, "...[truncated]") {
		t.Fatalf("text = %q", text)
	}
	if len(text) != maxMetadataStringLength+len("...[truncated]") {
		t.Fatalf("text length = %d", len(text))
	}

	if _, ok := (completionMetadataEntry{Key: "sources", Number: floatPtr(math.Inf(1))}).bsonValue(); ok {
		t.Fatal("non-finite numbers must be dropped")
	}
}

func TestCompletionNormalizationHelpers(t *testing.T) {
	if got := normalizeCompletionOrgID("   "); got != completionUnknownOrgID {
		t.Fatalf("orgId = %q", got)
	}
	if got := normalizeCompletionModel("  "); got != completionUnknownModel {
		t.Fatalf("model = %q", got)
	}
	if got := normalizeCompletionStatus("error"); got != completionStatusError {
		t.Fatalf("status = %q", got)
	}
	if token := normalizeFeatureToken(" News_Event "); token == nil || *token != "news_event" {
		t.Fatalf("token = %v", token)
	}
	if token := normalizeFeatureToken("has space"); token != nil {
		t.Fatalf("token = %v", token)
	}
	if normalizeAuthMode("bogus") != nil {
		t.Fatal("unknown auth mode must be null")
	}
	if mode := normalizeAuthMode("managed_runtime_key"); mode == nil || *mode != "managed_runtime_key" {
		t.Fatalf("mode = %v", mode)
	}
	if normalizeLogProfileID(strings.Repeat("p", maxProfileIDLength+1)) != nil {
		t.Fatal("over-long profile id must be null")
	}
	if normalizeLatencyMS(-5*time.Millisecond) != 0 {
		t.Fatal("negative latency must clamp to 0")
	}
	if got := normalizeLatencyMS(1500 * time.Microsecond); got != 1 {
		t.Fatalf("latency = %v", got)
	}
	if normalizeCompletionError("success", "boom") != nil {
		t.Fatal("a successful attempt must not store an error")
	}
	errText := normalizeCompletionError("error", strings.Repeat("x", maxCompletionErrorLength+50))
	if errText == nil || len(*errText) != maxCompletionErrorLength {
		t.Fatalf("error = %v", errText)
	}
	if finiteOrNil(nil) != nil {
		t.Fatal("nil stays nil")
	}
	nan := math.NaN()
	if finiteOrNil(&nan) != nil {
		t.Fatal("NaN must be null, never zero")
	}
}

func TestCompletionWriterWithoutMongoFails(t *testing.T) {
	writer := NewCompletionWriter(nil, nil)
	err := writer.WriteAttempt(context.Background(), CompletionLogEntry{Status: "success"})
	if err == nil {
		t.Fatal("a writer without Mongo must report the failure to its caller")
	}
}

func floatPtr(value float64) *float64 { return &value }

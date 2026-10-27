package assistantruns

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/publicportal"
)

// cjkDelta is thirty Chinese characters: 30 JavaScript string units but 90
// UTF-8 bytes.
var cjkDelta = strings.Repeat("中", 30)

// newStreamTestService builds the streaming service with an explicit flush
// configuration. The time-based flush is pushed far out so the assertions only
// observe the character threshold.
func newStreamTestService(llm publicportal.AssistantLLM, publisher Publisher, flushChars, flushMs int) *Service {
	return NewService(Options{
		Store:        &fakeStore{},
		Queue:        &fakeQueue{},
		LLM:          llm,
		Items:        &fakeItems{},
		Series:       &fakeSeries{},
		Capabilities: fakeCapabilities{},
		Governance:   fakeGovernance{},
		ModelAccess:  fakeModelAccess{keys: 1},
		Forecaster:   &fakeForecaster{},
		Publisher:    publisher,
		Env:          Env{MaxRetries: 3, LLMTimeout: 300 * time.Second, StreamFlushChars: flushChars, StreamFlushMs: flushMs},
	})
}

// TestStreamMessagesFlushThresholdUsesUTF16Units covers the JavaScript
// String#length contract of ASSISTANT_STREAM_FLUSH_CHARS: two 30-character
// Chinese deltas are 60 units (below the 80-unit threshold) even though they are
// 180 UTF-8 bytes, so the whole answer is published once, exactly like the
// NestJS `buffer.length` comparison.
func TestStreamMessagesFlushThresholdUsesUTF16Units(t *testing.T) {
	llm := &fakeLLM{streamEvents: []publicportal.AssistantStreamEvent{
		{Delta: cjkDelta, Model: "gpt-test"},
		{Delta: cjkDelta},
	}}
	publisher := &fakePublisher{}
	service := newStreamTestService(llm, publisher, 80, 3_600_000)
	record := testRunRecord(t, RunTypeQuery, QueryInput{Message: "hello"})

	summary, raw, err := service.streamMessages(context.Background(), record, record.CreatedAt, RunTypeQuery, nil, streamOptions{})
	if err != nil {
		t.Fatalf("streamMessages returned %v", err)
	}
	if summary != cjkDelta+cjkDelta {
		t.Fatalf("summary length = %d, want %d", utf16Len(summary), 60)
	}
	if raw.Model == nil || *raw.Model != "gpt-test" || !raw.Stream {
		t.Fatalf("raw = %+v", raw)
	}
	if len(publisher.events) != 1 {
		t.Fatalf("published %d running chunks, want 1 (80 UTF-16 units threshold)", len(publisher.events))
	}
	if got := publisher.events[0].Run.Summary; got == nil || utf16Len(*got) != 60 {
		t.Fatalf("flushed chunk = %v, want the full 60-unit summary", got)
	}
}

// TestStreamMessagesFlushesAtThreshold checks the other direction: a delta that
// reaches the unit threshold is flushed immediately, so the final summary is not
// published twice.
func TestStreamMessagesFlushesAtThreshold(t *testing.T) {
	llm := &fakeLLM{streamEvents: []publicportal.AssistantStreamEvent{
		{Delta: strings.Repeat("中", 80)},
		{Delta: "tail"},
	}}
	publisher := &fakePublisher{}
	service := newStreamTestService(llm, publisher, 80, 3_600_000)
	record := testRunRecord(t, RunTypeQuery, QueryInput{Message: "hello"})

	summary, _, err := service.streamMessages(context.Background(), record, record.CreatedAt, RunTypeQuery, nil, streamOptions{})
	if err != nil {
		t.Fatalf("streamMessages returned %v", err)
	}
	if summary != strings.Repeat("中", 80)+"tail" {
		t.Fatalf("summary = %q", summary)
	}
	if len(publisher.events) != 2 {
		t.Fatalf("published %d running chunks, want 2", len(publisher.events))
	}
	if got := publisher.events[0].Run.Summary; got == nil || utf16Len(*got) != 80 {
		t.Fatalf("first chunk = %v, want the 80-unit flush", got)
	}
	if got := publisher.events[1].Run.Summary; got == nil || *got != "tail" {
		t.Fatalf("second chunk = %v, want the final flush", got)
	}
}

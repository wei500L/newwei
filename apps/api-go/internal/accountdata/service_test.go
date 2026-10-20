package accountdata

import (
	"context"
	"net/http"
	"testing"
)

// TestRequestIPMirrorsTrustProxy pins the Express req.ip resolution: without
// TRUST_PROXY the socket address wins and X-Forwarded-For is ignored.
func TestRequestIPMirrorsTrustProxy(t *testing.T) {
	request, err := http.NewRequest(http.MethodGet, "/api/auth/data-export", nil)
	if err != nil {
		t.Fatal(err)
	}
	request.RemoteAddr = "10.0.0.9:51234"
	request.Header.Set("X-Forwarded-For", "203.0.113.7, 10.0.0.1")

	untrusted := NewService(Options{})
	if got := untrusted.RequestIP(request); got == nil || *got != "10.0.0.9" {
		t.Fatalf("untrusted ip = %v, want 10.0.0.9", got)
	}
	leftmost := NewService(Options{Config: Config{TrustProxy: "true"}})
	if got := leftmost.RequestIP(request); got == nil || *got != "203.0.113.7" {
		t.Fatalf("trusted ip = %v, want 203.0.113.7", got)
	}
	oneHop := NewService(Options{Config: Config{TrustProxy: "1"}})
	if got := oneHop.RequestIP(request); got == nil || *got != "10.0.0.1" {
		t.Fatalf("one-hop ip = %v, want 10.0.0.1", got)
	}
	if got := untrusted.RequestIP(nil); got != nil {
		t.Fatalf("nil request ip = %v", got)
	}
}

// TestMongoAssistantRunsWithoutDatabaseFailsClosed pins the typed-nil
// avoidance: a nil database produces a source that reports an error instead of
// a nil interface that would panic later.
func TestMongoAssistantRunsWithoutDatabaseFailsClosed(t *testing.T) {
	source := NewMongoAssistantRuns(nil)
	if source == nil {
		t.Fatal("NewMongoAssistantRuns returned a nil pointer")
	}
	if err := source.ForEachAssistantRun(context.Background(), "org-1", "user-1", func(AssistantRun) error { return nil }); err == nil {
		t.Fatal("expected an error when no Mongo database is configured")
	}
}

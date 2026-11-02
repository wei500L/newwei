package exceptioningest

import (
	"strings"
	"testing"
)

func TestNormalizeClientReportRejectsEmptyMessage(t *testing.T) {
	_, message := normalizeClientReport([]byte(`{}`), "")
	if message != "message is required" {
		t.Fatalf("message = %q", message)
	}
	_, message = normalizeClientReport([]byte(`{"message":"   "}`), "")
	if message != "message is required" {
		t.Fatalf("blank message = %q", message)
	}
}

func TestNormalizeClientReportTracePriority(t *testing.T) {
	body := []byte(`{"message":"boom","traceId":"body-trace","kind":"graphql","method":"get","statusCode":"404"}`)
	event, message := normalizeClientReport(body, "header-trace")
	if message != "" {
		t.Fatalf("unexpected error: %s", message)
	}
	if event.TraceID != "header-trace" {
		t.Fatalf("trace id = %q, want header-trace", event.TraceID)
	}
	if event.Kind != KindGraphQL {
		t.Fatalf("kind = %q", event.Kind)
	}
	if event.Method != "GET" {
		t.Fatalf("method = %q", event.Method)
	}
	if event.StatusCode == nil || *event.StatusCode != 404 {
		t.Fatalf("statusCode = %v", event.StatusCode)
	}

	event, _ = normalizeClientReport(body, "")
	if event.TraceID != "body-trace" {
		t.Fatalf("trace id = %q, want body-trace", event.TraceID)
	}
}

func TestNormalizeClientReportEnforcesLengths(t *testing.T) {
	tooLong := strings.Repeat("a", messageMaxLength+1)
	_, message := normalizeClientReport([]byte(`{"message":"`+tooLong+`"}`), "")
	want := "message is too long (max 1000 characters)"
	if message != want {
		t.Fatalf("message = %q, want %q", message, want)
	}
	// A valid x-trace-id short-circuits the body traceId check, mirroring the
	// JavaScript ?? evaluation order.
	bodyTrace := strings.Repeat("b", traceIDMaxLength+1)
	_, message = normalizeClientReport([]byte(`{"message":"ok","traceId":"`+bodyTrace+`"}`), "header")
	if message != "" {
		t.Fatalf("short-circuited error = %q", message)
	}
	_, message = normalizeClientReport([]byte(`{"message":"ok","traceId":"`+bodyTrace+`"}`), "")
	if !strings.Contains(message, "traceId is too long") {
		t.Fatalf("traceId error = %q", message)
	}
}

func TestNormalizeClientReportDropsIdentityAndStack(t *testing.T) {
	body := []byte(`{"message":"boom","stack":"secret stack","orgId":"other","userId":"other"}`)
	event, message := normalizeClientReport(body, "")
	if message != "" {
		t.Fatalf("unexpected error: %s", message)
	}
	if event.Stack != "" || event.OrgID != "" || event.UserID != "" {
		t.Fatalf("client report kept ignored fields: %+v", event)
	}
}

func TestNormalizeClientReportStatusCodeRange(t *testing.T) {
	for _, raw := range []string{`99`, `600`, `"abc"`, `null`} {
		event, message := normalizeClientReport([]byte(`{"message":"ok","statusCode":`+raw+`}`), "")
		if message != "" {
			t.Fatalf("statusCode %s error: %s", raw, message)
		}
		if event.StatusCode != nil {
			t.Fatalf("statusCode %s = %v, want nil", raw, *event.StatusCode)
		}
	}
	event, _ := normalizeClientReport([]byte(`{"message":"ok","statusCode":503.9}`), "")
	if event.StatusCode == nil || *event.StatusCode != 503 {
		t.Fatalf("statusCode = %v, want 503", event.StatusCode)
	}
}

func TestNormalizeClientReportKindFallback(t *testing.T) {
	event, _ := normalizeClientReport([]byte(`{"message":"ok","kind":" HTTP "}`), "")
	if event.Kind != KindUnknown {
		t.Fatalf("kind = %q, want unknown", event.Kind)
	}
	event, _ = normalizeClientReport([]byte(`{"message":"ok","kind":"http"}`), "")
	if event.Kind != KindHTTP {
		t.Fatalf("kind = %q, want http", event.Kind)
	}
}

func TestNormalizeInternalReportKeepsIdentityAndTruncatesStack(t *testing.T) {
	stack := strings.Repeat("s", stackMaxLength+1)
	body := []byte(`{"message":"boom","orgId":"org-1","userId":"user-1","stack":"` + stack + `"}`)
	event, message := normalizeInternalReport(body, "")
	if message != "" {
		t.Fatalf("unexpected error: %s", message)
	}
	if event.OrgID != "org-1" || event.UserID != "user-1" {
		t.Fatalf("identity = %q/%q", event.OrgID, event.UserID)
	}
	if jsStringLength(event.Stack) != stackMaxLength {
		t.Fatalf("stack length = %d, want %d", jsStringLength(event.Stack), stackMaxLength)
	}
}

func TestNormalizeInternalReportTracePriority(t *testing.T) {
	event, _ := normalizeInternalReport([]byte(`{"message":"boom","traceId":"body-trace"}`), "header-trace")
	if event.TraceID != "body-trace" {
		t.Fatalf("trace id = %q, want body-trace", event.TraceID)
	}
	event, _ = normalizeInternalReport([]byte(`{"message":"boom"}`), "header-trace")
	if event.TraceID != "header-trace" {
		t.Fatalf("trace id = %q, want header-trace", event.TraceID)
	}
}

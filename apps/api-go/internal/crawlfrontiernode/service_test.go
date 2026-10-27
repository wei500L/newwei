package crawlfrontiernode

// service_test.go covers the three pure decision points of the node state
// machine plus the error contract:
//
//   - the executeNode branch condition (crawl-frontier.service.ts 1459-1487);
//   - classifyFrontierFailureKind and shouldDemoteHotRetryToNormal (:1020-1060,
//     :1444-1457);
//   - the workflow event literals the state machine appends (:959-972,
//     :1039-1055, :1090-1103);
//   - the NestJS error messages, the 404/400 status pair and the "do not wrap
//     the crawl4ai error" rule (errors.go).
//
// Every test here is DB-free: the Service value is built with only the clock
// and the crawlfrontierllm recorder seam it needs, because the functions under
// test never touch the MySQL/Redis handles.

import (
	"encoding/json"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/crawl4ai"
	"github.com/wei500L/newwei/apps/api-go/internal/crawlfrontierllm"
)

// testClock is the pinned service clock.
func testClock() time.Time {
	return time.Date(2025, 3, 4, 5, 6, 7, 891_000_000, time.UTC)
}

// testService builds the smallest Service the pure helpers accept: the clock and
// the crawlfrontierllm recorder surface used for the ISO timestamps.
func testService() *Service {
	return &Service{
		now:      testClock,
		frontier: crawlfrontierllm.New(crawlfrontierllm.Options{Now: testClock}),
	}
}

// testObject parses a JSON object literal without failing the test on a typo in
// the fixture (a broken fixture is a test bug, not a production signal).
func testObject(t *testing.T, raw string) *crawlfrontierllm.Object {
	t.Helper()
	object, ok := crawlfrontierllm.ParseObject(json.RawMessage(raw))
	if !ok {
		t.Fatalf("fixture is not a JSON object: %s", raw)
	}
	return object
}

// testStringPointer returns a pointer to value.
func testStringPointer(value string) *string { return &value }

func TestServiceRequiresDatabaseAndCrawlClient(t *testing.T) {
	// New is the only place the wiring contract is enforced. A worker that
	// loses either handle must fail at construction instead of at the first
	// node execution.
	if _, err := New(Options{}); err == nil {
		t.Fatal("New without a database must fail")
	}
	if _, err := New(Options{Crawl: crawl4ai.New(crawl4ai.Options{})}); err == nil {
		t.Fatal("New without a crawl client must fail")
	}
}

func TestErrorContractMessagesAndStatus(t *testing.T) {
	// NestJS throws NotFoundException for the node lookup and
	// BadRequestException for the three run-shape failures
	// (crawl-frontier.service.ts 918-940). The message text is part of the
	// worker contract: the crawl worker classifies retryable failures from it,
	// so it must stay byte-identical to the NestJS literals.
	cases := []struct {
		name    string
		err     error
		status  int
		message string
	}{
		{"node not found", newNodeNotFoundError(), 404, "Crawl frontier node not found"},
		{"profile unresolved", newBadRequestError(messageProfileUnresolved), 400, "Crawl frontier run cannot resolve site profile"},
		{"missing crawl task id", newBadRequestError(messageMissingCrawlTaskID), 400, "Crawl frontier run is missing crawlTaskId"},
		{"synthetic task missing", newBadRequestError(messageSyntheticTaskMissing), 400, "Synthetic crawl task not found for crawl frontier run"},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			if got := testCase.err.Error(); got != testCase.message {
				t.Fatalf("message = %q, want %q", got, testCase.message)
			}
			var nestErr *crawlfrontierllm.NestError
			if !errors.As(testCase.err, &nestErr) {
				t.Fatalf("error is not a *crawlfrontierllm.NestError: %T", testCase.err)
			}
			if nestErr.Status != testCase.status {
				t.Fatalf("status = %d, want %d", nestErr.Status, testCase.status)
			}
			if nestErr.Message != testCase.message {
				t.Fatalf("NestError message = %q, want %q", nestErr.Message, testCase.message)
			}
		})
	}
}

func TestCrawl4aiErrorStatusSurvivesErrorsAs(t *testing.T) {
	// errors.go rule 2: executeNode returns the client error untouched, so the
	// worker can read the HTTP status with errors.As. The test proves both
	// halves of that rule: an untouched *crawl4ai.Error is found, and the same
	// error stays findable through one %w wrap (which is why executeNode must
	// not wrap it with a message prefix that changes Error() text).
	clientErr := &crawl4ai.Error{Status: 503, Message: "Request failed with status code 503"}
	var direct *crawl4ai.Error
	if !errors.As(error(clientErr), &direct) {
		t.Fatal("errors.As must find the direct *crawl4ai.Error")
	}
	if direct.Status != 503 {
		t.Fatalf("direct status = %d, want 503", direct.Status)
	}

	wrapped := fmt.Errorf("frontier node: %w", clientErr)
	var throughWrap *crawl4ai.Error
	if !errors.As(wrapped, &throughWrap) {
		t.Fatal("errors.As must find a %w-wrapped *crawl4ai.Error")
	}
	if throughWrap.Status != 503 {
		t.Fatalf("wrapped status = %d, want 503", throughWrap.Status)
	}
	// crawl4ai.StatusOf unwraps with errors.As, so it keeps returning the HTTP
	// status even when a caller adds a message prefix: a wrapped 503 stays
	// retryable instead of silently turning into a permanent failure.
	if got := crawl4ai.StatusOf(clientErr); got != 503 {
		t.Fatalf("StatusOf(clientErr) = %d, want 503", got)
	}
	if got := crawl4ai.StatusOf(wrapped); got != 503 {
		t.Fatalf("StatusOf(wrapped) = %d, want 503", got)
	}
}

func TestShouldUseNativeAtRoot(t *testing.T) {
	// executeNode's branch condition (crawl-frontier.service.ts 1459-1476):
	//
	//	useNativeAtRoot = node.depth === 0
	//	               && (run.executionMode === "native" || run.executionMode === "hybrid")
	//	               && Boolean(profile.config.nativeOptions?.deepCrawlStrategy)
	//
	// Every other combination runs executeLayeredNode, including a native run
	// whose profile has no deepCrawlStrategy (the layered fallback is how a
	// native profile without the native payload keeps working).
	service := testService()
	cases := []struct {
		name          string
		depth         int
		executionMode string
		config        string
		want          bool
	}{
		{
			name:          "depth is not zero",
			depth:         1,
			executionMode: "native",
			config:        `{"nativeOptions":{"deepCrawlStrategy":{"type":"bfs"}}}`,
			want:          false,
		},
		{
			name:          "layered run",
			depth:         0,
			executionMode: "layered",
			config:        `{"nativeOptions":{"deepCrawlStrategy":{"type":"bfs"}}}`,
			want:          false,
		},
		{
			name:          "native run without native options",
			depth:         0,
			executionMode: "native",
			config:        `{"layeredOptions":{"maxPages":10}}`,
			want:          false,
		},
		{
			name:          "native run without deep crawl strategy",
			depth:         0,
			executionMode: "native",
			config:        `{"nativeOptions":{"maxDepth":2}}`,
			want:          false,
		},
		{
			name:          "hybrid run without deep crawl strategy",
			depth:         0,
			executionMode: "hybrid",
			config:        `{"nativeOptions":{}}`,
			want:          false,
		},
		{
			name:          "native run with deep crawl strategy",
			depth:         0,
			executionMode: "native",
			config:        `{"nativeOptions":{"deepCrawlStrategy":{"type":"bfs"}}}`,
			want:          true,
		},
		{
			name:          "hybrid run with deep crawl strategy",
			depth:         0,
			executionMode: "hybrid",
			config:        `{"nativeOptions":{"deepCrawlStrategy":"bfs"}}`,
			want:          true,
		},
		{
			name:          "native run with a null deep crawl strategy",
			depth:         0,
			executionMode: "native",
			config:        `{"nativeOptions":{"deepCrawlStrategy":null}}`,
			want:          false,
		},
		{
			name:          "native run with an empty native options object",
			depth:         0,
			executionMode: "native",
			config:        `{}`,
			want:          false,
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			options := executeNodeOptions{
				Node:    &crawlfrontierllm.NodeRecord{Depth: testCase.depth},
				Run:     &runRecord{RunRecord: crawlfrontierllm.RunRecord{ExecutionMode: testCase.executionMode}},
				Profile: &crawlfrontierllm.ProfileRecord{Config: testObject(t, testCase.config)},
			}
			if got := service.shouldUseNativeAtRoot(options); got != testCase.want {
				t.Fatalf("shouldUseNativeAtRoot = %v, want %v", got, testCase.want)
			}
		})
	}
}

func TestDeepCrawlStrategyConfiguredCoercesLikeBoolean(t *testing.T) {
	// Boolean(profile.config.nativeOptions?.deepCrawlStrategy): NestJS treats
	// undefined/null/false/0/"" as falsy and every other value (including an
	// empty object or a non-zero number) as truthy.
	cases := []struct {
		name   string
		config string
		want   bool
	}{
		{"missing native options", `{}`, false},
		{"null native options", `{"nativeOptions":null}`, false},
		{"missing strategy", `{"nativeOptions":{"maxDepth":3}}`, false},
		{"null strategy", `{"nativeOptions":{"deepCrawlStrategy":null}}`, false},
		{"false strategy", `{"nativeOptions":{"deepCrawlStrategy":false}}`, false},
		{"zero strategy", `{"nativeOptions":{"deepCrawlStrategy":0}}`, false},
		{"empty string strategy", `{"nativeOptions":{"deepCrawlStrategy":""}}`, false},
		{"empty object strategy", `{"nativeOptions":{"deepCrawlStrategy":{}}}`, true},
		{"true strategy", `{"nativeOptions":{"deepCrawlStrategy":true}}`, true},
		{"string strategy", `{"nativeOptions":{"deepCrawlStrategy":"bfs"}}`, true},
		{"non zero strategy", `{"nativeOptions":{"deepCrawlStrategy":2}}`, true},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			if got := deepCrawlStrategyConfigured(testObject(t, testCase.config)); got != testCase.want {
				t.Fatalf("deepCrawlStrategyConfigured = %v, want %v", got, testCase.want)
			}
		})
	}
	if deepCrawlStrategyConfigured(nil) {
		t.Fatal("a nil config has no native options")
	}
}

func TestClassifyFailureKind(t *testing.T) {
	// classifyFrontierFailureKind (crawl-frontier.utils.ts 1445-1485) returns
	// only three kinds: ssrf_blocked, challenge_detected and
	// network_tunnel_error; everything else is null. Note the two inputs the
	// worker's retryability check uses as *hints* - the words "timeout" and
	// "rate limit" - are deliberately NOT failure kinds unless they appear in
	// one of the classifier's own needles, which is why the table covers both
	// spellings.
	cases := []struct {
		name    string
		message string
		want    *string
	}{
		{"empty message", "", nil},
		{"unclassified text", "crawl frontier node failed", nil},
		{"bare timeout word", "request timeout", nil},
		{"bare rate limit word", "rate limit exceeded", nil},
		{"navigation timeout", "net::ERR_TIMED_OUT navigation timeout of 30000 ms exceeded", testStringPointer("network_tunnel_error")},
		{"request timed out", "crawl4ai request timed out after 120000ms", testStringPointer("network_tunnel_error")},
		{"tunnel connection failed", "net::ERR_TUNNEL_CONNECTION_FAILED", testStringPointer("network_tunnel_error")},
		{"connection reset", "read ECONNRESET", testStringPointer("network_tunnel_error")},
		{"challenge detected", "cloudflare challenge page served", testStringPointer("challenge_detected")},
		{"captcha", "captcha required before content", testStringPointer("challenge_detected")},
		{"status code 429", "Request failed with status code 429\n(status 429)", testStringPointer("challenge_detected")},
		{"status code 503 is not a challenge", "Request failed with status code 503\n(status 503)", nil},
		{"access denied", "access denied by upstream", testStringPointer("challenge_detected")},
		{"ssrf blocked", "URL blocked by SSRF protection: Private/internal IP address is not allowed", testStringPointer("ssrf_blocked")},
		{"case insensitive", "CLOUDFLARE CHALLENGE", testStringPointer("challenge_detected")},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			got := classifyFailureKind(testCase.message)
			switch {
			case testCase.want == nil && got != nil:
				t.Fatalf("classifyFailureKind(%q) = %q, want nil", testCase.message, *got)
			case testCase.want != nil && got == nil:
				t.Fatalf("classifyFailureKind(%q) = nil, want %q", testCase.message, *testCase.want)
			case testCase.want != nil && *got != *testCase.want:
				t.Fatalf("classifyFailureKind(%q) = %q, want %q", testCase.message, *got, *testCase.want)
			}
		})
	}
}

func TestShouldDemoteHotRetryToNormal(t *testing.T) {
	// shouldDemoteHotRetryToNormal (:1444-1457): only the first
	// network_tunnel_error of a hot node is demoted to the normal queue. Every
	// other combination keeps the ordinary failed-node path, including a
	// network_tunnel_error that already carries retryDemotedToNormal
	// (otherwise the node would bounce between the queues forever).
	service := testService()
	cases := []struct {
		name          string
		queueClass    string
		failureKind   *string
		metadata      string
		want          bool
		metadataIsNil bool
	}{
		{
			name:        "hot network tunnel error is demoted",
			queueClass:  "hot",
			failureKind: testStringPointer("network_tunnel_error"),
			metadata:    `{}`,
			want:        true,
		},
		{
			name:          "hot network tunnel error without metadata is demoted",
			queueClass:    "hot",
			failureKind:   testStringPointer("network_tunnel_error"),
			metadataIsNil: true,
			want:          true,
		},
		{
			name:        "hot challenge is not demoted",
			queueClass:  "hot",
			failureKind: testStringPointer("challenge_detected"),
			metadata:    `{}`,
			want:        false,
		},
		{
			name:        "hot unclassified failure is not demoted",
			queueClass:  "hot",
			failureKind: nil,
			metadata:    `{}`,
			want:        false,
		},
		{
			name:        "hot already demoted is not demoted again",
			queueClass:  "hot",
			failureKind: testStringPointer("network_tunnel_error"),
			metadata:    `{"retryDemotedToNormal":true}`,
			want:        false,
		},
		{
			name:        "hot with a false demotion marker is demoted",
			queueClass:  "hot",
			failureKind: testStringPointer("network_tunnel_error"),
			metadata:    `{"retryDemotedToNormal":false}`,
			want:        true,
		},
		{
			name:        "normal queue network tunnel error is not demoted",
			queueClass:  "normal",
			failureKind: testStringPointer("network_tunnel_error"),
			metadata:    `{}`,
			want:        false,
		},
		{
			name:        "cold queue network tunnel error is not demoted",
			queueClass:  "cold",
			failureKind: testStringPointer("network_tunnel_error"),
			metadata:    `{}`,
			want:        false,
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			node := &crawlfrontierllm.NodeRecord{QueueClass: testCase.queueClass}
			if !testCase.metadataIsNil {
				node.Metadata = testObject(t, testCase.metadata)
			}
			if got := service.shouldDemoteHotRetryToNormal(node, testCase.failureKind); got != testCase.want {
				t.Fatalf("shouldDemoteHotRetryToNormal = %v, want %v", got, testCase.want)
			}
		})
	}
}

func TestWarningFlagsWith(t *testing.T) {
	// warningFlagsWith is
	// uniqueStringList(collectNodeWarningFlags(...), failureKind ? [failureKind]
	// : undefined, extra) ?? [] (service.go). uniqueStringList trims, drops empty
	// entries, keeps the first occurrence order and returns nil when everything
	// is empty - the `?? []` is what makes the stored metadata column `[]`
	// instead of a dropped key.
	empty := warningFlagsWith(nil, nil, nil)
	if empty == nil {
		t.Fatal("warningFlagsWith must return an empty slice, not nil")
	}
	if len(empty) != 0 {
		t.Fatalf("warningFlagsWith() = %v, want empty", empty)
	}

	cases := []struct {
		name        string
		existing    []string
		failureKind *string
		extra       []string
		want        []string
	}{
		{
			name:        "failure kind is appended",
			existing:    []string{"llm_judge_failed"},
			failureKind: testStringPointer("challenge_detected"),
			want:        []string{"llm_judge_failed", "challenge_detected"},
		},
		{
			name:        "demotion flag follows the failure kind",
			existing:    nil,
			failureKind: testStringPointer("network_tunnel_error"),
			extra:       []string{"retry_demoted_to_normal"},
			want:        []string{"network_tunnel_error", "retry_demoted_to_normal"},
		},
		{
			name:        "duplicates are removed keeping the first position",
			existing:    []string{"challenge_detected", "other"},
			failureKind: testStringPointer("challenge_detected"),
			extra:       []string{"other", "challenge_detected"},
			want:        []string{"challenge_detected", "other"},
		},
		{
			name:     "entries are trimmed and empty ones dropped",
			existing: []string{"  padded  ", "", "   "},
			want:     []string{"padded"},
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			got := warningFlagsWith(testCase.existing, testCase.failureKind, testCase.extra)
			if len(got) != len(testCase.want) {
				t.Fatalf("warningFlagsWith = %v, want %v", got, testCase.want)
			}
			for index := range got {
				if got[index] != testCase.want[index] {
					t.Fatalf("warningFlagsWith = %v, want %v", got, testCase.want)
				}
			}
		})
	}
}

func TestFrontierNodeStartedEventShape(t *testing.T) {
	// frontier_node_started (:959-972): level info, nodeType
	// legacy.frontier_node, the four detail keys in the NestJS order and the
	// service clock for the timestamp.
	service := testService()
	event := service.frontierNodeStartedEvent(&crawlfrontierllm.NodeRecord{
		ID: "node-1", URL: "https://example.com", PageType: "home", Depth: 0, QueueClass: "hot",
	})
	if event.Level != "info" || event.EventType != "frontier_node_started" {
		t.Fatalf("level/eventType = %q/%q", event.Level, event.EventType)
	}
	if event.Message != "Frontier node execution started" {
		t.Fatalf("message = %q", event.Message)
	}
	if event.NodeID == nil || *event.NodeID != "node-1" {
		t.Fatalf("nodeId = %v", event.NodeID)
	}
	if event.NodeType == nil || *event.NodeType != "legacy.frontier_node" {
		t.Fatalf("nodeType = %v", event.NodeType)
	}
	if event.Timestamp != "2025-03-04T05:06:07.891Z" {
		t.Fatalf("timestamp = %q", event.Timestamp)
	}
	details, err := event.Details.MarshalJSON()
	if err != nil {
		t.Fatalf("marshal details: %v", err)
	}
	wantDetails := `{"url":"https://example.com","pageType":"home","depth":0,"queueClass":"hot"}`
	if string(details) != wantDetails {
		t.Fatalf("details = %s, want %s", details, wantDetails)
	}
}

func TestRetryDemotedEventShape(t *testing.T) {
	// retry_demoted_to_normal (:1039-1055): level warn, nodeType budget-control,
	// the failure kind as triggerReason, the three fixed counters, the queue
	// transition in details and the demotion time (not the service clock) as
	// timestamp.
	service := testService()
	queuedAt := time.Date(2025, 3, 4, 5, 6, 8, 42_000_000, time.UTC)
	event := service.retryDemotedEvent(&crawlfrontierllm.NodeRecord{
		ID: "node-2", URL: "https://example.com/a", QueueClass: "hot",
	}, testStringPointer("network_tunnel_error"), queuedAt)
	if event.Level != "warn" || event.EventType != "retry_demoted_to_normal" {
		t.Fatalf("level/eventType = %q/%q", event.Level, event.EventType)
	}
	if event.Message != "Frontier node retry was demoted from hot to normal queue" {
		t.Fatalf("message = %q", event.Message)
	}
	if event.TriggerReason == nil || *event.TriggerReason != "network_tunnel_error" {
		t.Fatalf("triggerReason = %v", event.TriggerReason)
	}
	if event.NodeType == nil || *event.NodeType != "budget-control" {
		t.Fatalf("nodeType = %v", event.NodeType)
	}
	if event.BeforeCount == nil || *event.BeforeCount != 1 ||
		event.AfterCount == nil || *event.AfterCount != 1 ||
		event.RescuedCount == nil || *event.RescuedCount != 1 {
		t.Fatalf("counters = %v/%v/%v", event.BeforeCount, event.AfterCount, event.RescuedCount)
	}
	if event.Timestamp != "2025-03-04T05:06:08.042Z" {
		t.Fatalf("timestamp = %q", event.Timestamp)
	}
	details, err := event.Details.MarshalJSON()
	if err != nil {
		t.Fatalf("marshal details: %v", err)
	}
	wantDetails := `{"url":"https://example.com/a","previousQueueClass":"hot","nextQueueClass":"normal"}`
	if string(details) != wantDetails {
		t.Fatalf("details = %s, want %s", details, wantDetails)
	}
}

func TestNodeFailedEventShape(t *testing.T) {
	// frontier_node_failed (:1090-1103): level error, the failure message
	// verbatim (the worker re-derives retryability from it), the failure kind as
	// triggerReason and the three position details.
	service := testService()
	event := service.nodeFailedEvent(&crawlfrontierllm.NodeRecord{
		ID: "node-3", URL: "https://example.com/b", PageType: "article", Depth: 2,
	}, "Crawl frontier run is missing crawlTaskId", nil)
	if event.Level != "error" || event.EventType != "frontier_node_failed" {
		t.Fatalf("level/eventType = %q/%q", event.Level, event.EventType)
	}
	if event.Message != "Crawl frontier run is missing crawlTaskId" {
		t.Fatalf("message = %q", event.Message)
	}
	if event.TriggerReason != nil {
		t.Fatalf("triggerReason = %v, want nil for an unclassified failure", event.TriggerReason)
	}
	if event.NodeType == nil || *event.NodeType != "legacy.frontier_node" {
		t.Fatalf("nodeType = %v", event.NodeType)
	}
	details, err := event.Details.MarshalJSON()
	if err != nil {
		t.Fatalf("marshal details: %v", err)
	}
	wantDetails := `{"url":"https://example.com/b","pageType":"article","depth":2}`
	if string(details) != wantDetails {
		t.Fatalf("details = %s, want %s", details, wantDetails)
	}
}

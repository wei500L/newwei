package realtimeevents

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/graphqlsubscriptions"
)

func TestUpperQueueEvent(t *testing.T) {
	cases := map[string]string{"active": "ACTIVE", "progress": "PROGRESS", "completed": "COMPLETED", "failed": "FAILED"}
	for input, want := range cases {
		got, ok := upperQueueEvent(input)
		if !ok || got != want {
			t.Fatalf("upperQueueEvent(%q) = %q/%v", input, got, ok)
		}
	}
	if _, ok := upperQueueEvent("waiting"); ok {
		t.Fatal("waiting must not be mapped")
	}
}

func TestBuildQueueEventData(t *testing.T) {
	cases := []struct {
		name   string
		event  string
		fields map[string]string
		want   string
		absent bool
	}{
		{name: "active prev", event: "ACTIVE", fields: map[string]string{"prev": "waiting"}, want: `{"prev":"waiting"}`},
		{name: "active no prev", event: "ACTIVE", fields: map[string]string{}, absent: true},
		{name: "progress object", event: "PROGRESS", fields: map[string]string{"data": `{"percent":50}`}, want: `{"percent":50}`},
		{name: "progress array", event: "PROGRESS", fields: map[string]string{"data": `[1,2]`}, want: `[1,2]`},
		{name: "progress primitive", event: "PROGRESS", fields: map[string]string{"data": `42`}, want: `{"progress":42}`},
		{name: "progress null", event: "PROGRESS", fields: map[string]string{"data": `null`}, want: `{"progress":null}`},
		{name: "progress invalid", event: "PROGRESS", fields: map[string]string{"data": `nope`}, absent: true},
		{name: "completed object", event: "COMPLETED", fields: map[string]string{"returnvalue": `{"ok":true}`}, want: `{"ok":true}`},
		{name: "completed string", event: "COMPLETED", fields: map[string]string{"returnvalue": `"done"`}, want: `{"returnvalue":"done"}`},
		{name: "completed number", event: "COMPLETED", fields: map[string]string{"returnvalue": `7`}, want: `{"returnvalue":7}`},
		{name: "completed none", event: "COMPLETED", fields: map[string]string{}, absent: true},
		{name: "failed reason", event: "FAILED", fields: map[string]string{"failedReason": "boom"}, want: `{"reason":"boom"}`},
		{name: "failed empty", event: "FAILED", fields: map[string]string{}, absent: true},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			got, ok := buildQueueEventData(testCase.event, testCase.fields)
			if testCase.absent {
				if ok {
					t.Fatalf("expected no data, got %s", got)
				}
				return
			}
			if !ok || string(got) != testCase.want {
				t.Fatalf("data = %s/%v, want %s", got, ok, testCase.want)
			}
		})
	}
}

func TestHandleQueueEntryPipelineEmitsThreeNamespaces(t *testing.T) {
	sink := newFakeSink()
	resolver := &fakeResolver{
		found: true,
		context: queueContext{
			OrgID:           "org1",
			PipelineJobID:   "p1",
			SourceID:        "s1",
			RawItemID:       "r1",
			ItemMetaID:      "m1",
			ProcessedItemID: "x1",
		},
	}
	sources := testSources()
	sources.sink = sink
	sources.orgResolvers = map[string]queueContextResolver{queuePipeline: resolver}

	sources.handleQueueEntry(t.Context(), queueStream{queue: queuePipeline, kind: queueKindPipeline}, graphqlsubscriptions.StreamEntry{
		ID:     "1-0",
		Fields: map[string]string{"event": "completed", "jobId": "j1", "returnvalue": `{"ok":true}`},
	})

	orgCalls := sink.orgCalls()
	if len(orgCalls) != 3 {
		t.Fatalf("PublishOrg calls = %d", len(orgCalls))
	}
	timestamp := "2026-10-20T12:00:00.000Z"
	wantQueue := `{"orgId":"org1","event":"COMPLETED","jobId":"j1","data":{"ok":true},"timestamp":"` + timestamp +
		`","pipelineJobId":"p1","sourceId":"s1","rawItemId":"r1","itemMetaId":"m1","processedItemId":"x1"}`
	wantOps := `{"orgId":"org1","source":"pipeline","event":"COMPLETED","jobId":"j1","data":{"ok":true},"timestamp":"` + timestamp +
		`","pipelineJobId":"p1","sourceId":"s1","rawItemId":"r1","itemMetaId":"m1","processedItemId":"x1"}`
	wantQuality := `{"orgId":"org1","source":"pipeline","event":"COMPLETED","jobId":"j1","timestamp":"` + timestamp + `"}`

	if orgCalls[0].namespace != NamespaceQueue || orgCalls[0].payload != wantQueue {
		t.Fatalf("queue call = %#v\nwant %s", orgCalls[0], wantQueue)
	}
	if orgCalls[1].namespace != NamespaceOps || orgCalls[1].payload != wantOps {
		t.Fatalf("ops call = %#v\nwant %s", orgCalls[1], wantOps)
	}
	if orgCalls[2].namespace != NamespaceQuality || orgCalls[2].payload != wantQuality {
		t.Fatalf("quality call = %#v\nwant %s", orgCalls[2], wantQuality)
	}
	if len(resolver.forgot) != 1 || resolver.forgot[0] != "j1" {
		t.Fatalf("terminal event must forget the cached context: %#v", resolver.forgot)
	}
}

func TestHandleQueueEntryCrawlEmitsOpsAndQualityOnly(t *testing.T) {
	sink := newFakeSink()
	priority := 3
	resolver := &fakeResolver{
		found: true,
		context: queueContext{
			OrgID:          "org1",
			SourceID:       "s1",
			TaskID:         "t1",
			PriorityClass:  "hot",
			SourcePriority: &priority,
		},
	}
	sources := testSources()
	sources.sink = sink
	sources.orgResolvers = map[string]queueContextResolver{queueCrawlHot: resolver}

	sources.handleQueueEntry(t.Context(), queueStream{queue: queueCrawlHot, kind: queueKindCrawl}, graphqlsubscriptions.StreamEntry{
		Fields: map[string]string{"event": "progress", "jobId": "j9", "data": `{"percent":3}`},
	})

	orgCalls := sink.orgCalls()
	if len(orgCalls) != 2 {
		t.Fatalf("PublishOrg calls = %d", len(orgCalls))
	}
	timestamp := "2026-10-20T12:00:00.000Z"
	wantOps := `{"orgId":"org1","source":"crawl","event":"PROGRESS","jobId":"j9","data":{"percent":3},"timestamp":"` + timestamp +
		`","sourceId":"s1","taskId":"t1","priorityClass":"hot","sourcePriority":3}`
	wantQuality := `{"orgId":"org1","source":"crawl","event":"PROGRESS","jobId":"j9","timestamp":"` + timestamp + `"}`
	if orgCalls[0].namespace != NamespaceOps || orgCalls[0].payload != wantOps {
		t.Fatalf("ops call = %#v\nwant %s", orgCalls[0], wantOps)
	}
	if orgCalls[1].namespace != NamespaceQuality || orgCalls[1].payload != wantQuality {
		t.Fatalf("quality call = %#v\nwant %s", orgCalls[1], wantQuality)
	}
}

func TestHandleQueueEntryDropsEventsWithoutOrgContext(t *testing.T) {
	sink := newFakeSink()
	sources := testSources()
	sources.sink = sink
	sources.orgResolvers = map[string]queueContextResolver{queuePipeline: &fakeResolver{found: false}}
	sources.handleQueueEntry(t.Context(), queueStream{queue: queuePipeline, kind: queueKindPipeline}, graphqlsubscriptions.StreamEntry{
		Fields: map[string]string{"event": "completed", "jobId": "j1"},
	})
	if len(sink.orgCalls()) != 0 {
		t.Fatal("event without org context must be dropped")
	}
}

func TestCrawlContextFromJobFields(t *testing.T) {
	fields := map[string]json.RawMessage{
		"orgId":          json.RawMessage(`" org1 "`),
		"sourceId":       json.RawMessage(`" s1 "`),
		"taskId":         json.RawMessage(`"t1"`),
		"priorityClass":  json.RawMessage(`" hot "`),
		"sourcePriority": json.RawMessage(`2.5`),
	}
	resolved, ok := crawlContextFromJobFields(fields)
	if !ok || resolved.OrgID != "org1" || resolved.SourceID != "s1" || resolved.TaskID != "t1" {
		t.Fatalf("resolved = %#v", resolved)
	}
	if resolved.SourcePriority == nil || *resolved.SourcePriority != 3 {
		t.Fatalf("sourcePriority = %#v", resolved.SourcePriority)
	}
	if _, ok := crawlContextFromJobFields(map[string]json.RawMessage{"orgId": json.RawMessage(`" "`)}); ok {
		t.Fatal("blank orgId must be rejected")
	}
	invalidPriority, _ := crawlContextFromJobFields(map[string]json.RawMessage{
		"orgId":         json.RawMessage(`"org1"`),
		"priorityClass": json.RawMessage(`"bogus"`),
	})
	if invalidPriority.PriorityClass != "" {
		t.Fatalf("invalid priority class = %q", invalidPriority.PriorityClass)
	}
	// A malformed optional field is ignored; the orgId still resolves.
	malformed, ok := crawlContextFromJobFields(map[string]json.RawMessage{
		"orgId":          json.RawMessage(`"org1"`),
		"sourcePriority": json.RawMessage(`"not-a-number"`),
	})
	if !ok || malformed.OrgID != "org1" || malformed.SourcePriority != nil {
		t.Fatalf("malformed optional field = %#v/%v", malformed, ok)
	}
}

// fakeOrgLookup is one orgIDLookup for the resolver precedence tests.
type fakeOrgLookup struct {
	orgID         string
	identifier    orgLookupIdentifier
	inferID       orgLookupIdentifier
	orgIDCalls    int
	identifierHit int
	resolveCalls  int
	inferCalls    int
}

func (l *fakeOrgLookup) OrgIDFromJobData(map[string]json.RawMessage) (string, bool) {
	l.orgIDCalls++
	if l.orgID == "" {
		return "", false
	}
	return l.orgID, true
}

func (l *fakeOrgLookup) IdentifierFromJobData(map[string]json.RawMessage) (orgLookupIdentifier, bool) {
	l.identifierHit++
	if l.identifier.id == "" {
		return orgLookupIdentifier{}, false
	}
	return l.identifier, true
}

func (l *fakeOrgLookup) ResolveIdentifier(_ context.Context, _ orgLookupIdentifier) (string, bool) {
	l.resolveCalls++
	if l.orgID == "" {
		return "", false
	}
	return l.orgID, true
}

func (l *fakeOrgLookup) InferIdentifier(string) (orgLookupIdentifier, bool) {
	l.inferCalls++
	if l.inferID.id == "" {
		return orgLookupIdentifier{}, false
	}
	return l.inferID, true
}

func TestSimpleOrgResolverPrecedence(t *testing.T) {
	newSources := func(jobData string) (*Sources, *simpleOrgResolver) {
		store := &fakeQueueStore{jobs: map[string]string{}}
		if jobData != "" {
			store.jobs[queueAnalysis+"/job-1"] = jobData
		}
		sources := testSources()
		sources.store = store
		resolver := &simpleOrgResolver{
			kind:   "analysis",
			queue:  queueAnalysis,
			store:  store,
			cache:  newQueueContextCache(sources.now),
			lookup: &fakeOrgLookup{orgID: "org-from-lookup", identifier: orgLookupIdentifier{kind: identifierAnalysis, id: "a1"}, inferID: orgLookupIdentifier{kind: identifierAnalysis, id: "a2"}},
		}
		return sources, resolver
	}

	// 1. job.data.orgId wins.
	_, resolver := newSources(`{"orgId":"org-direct","analysisId":"a1"}`)
	context, ok := resolver.Resolve(t.Context(), "job-1")
	if !ok || context.OrgID != "org-direct" {
		t.Fatalf("direct orgId context = %#v/%v", context, ok)
	}

	// 2. job.data.analysisId -> Mongo lookup.
	_, resolver = newSources(`{"analysisId":"a1"}`)
	context, ok = resolver.Resolve(t.Context(), "job-1")
	if !ok || context.OrgID != "org-from-lookup" {
		t.Fatalf("identifier context = %#v/%v", context, ok)
	}

	// 3. job id prefix fallback.
	_, resolver = newSources(`{}`)
	context, ok = resolver.Resolve(t.Context(), "corr-a2")
	if !ok || context.OrgID != "org-from-lookup" {
		t.Fatalf("inferred context = %#v/%v", context, ok)
	}

	// 4. The per-instance cache answers after the job hash disappears (and the
	// lookup would no longer resolve).
	delete(resolver.store.(*fakeQueueStore).jobs, queueAnalysis+"/corr-a2")
	resolver.lookup.(*fakeOrgLookup).orgID = ""
	resolver.lookup.(*fakeOrgLookup).inferID = orgLookupIdentifier{}
	context, ok = resolver.Resolve(t.Context(), "corr-a2")
	if !ok || context.OrgID != "org-from-lookup" {
		t.Fatalf("cached context = %#v/%v", context, ok)
	}
}

func TestQueueContextCacheExpiry(t *testing.T) {
	now := time.Date(2026, 10, 20, 12, 0, 0, 0, time.UTC)
	clock := func() time.Time { return now }
	cache := newQueueContextCache(clock)
	cache.set("job", queueContext{OrgID: "org1"})
	if _, ok := cache.get("job"); !ok {
		t.Fatal("fresh cache entry missing")
	}
	now = now.Add(11 * time.Minute)
	if _, ok := cache.get("job"); ok {
		t.Fatal("expired cache entry must be dropped")
	}
}

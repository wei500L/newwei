package realtimeevents

import (
	"context"
	"encoding/json"
	"sync"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/graphqlsubscriptions"
)

// fakeSink records every local push. It implements realtimeevents.Sink without
// a Redis adapter (B1 semantics).
type fakeSink struct {
	mu        sync.Mutex
	rooms     []sinkCall
	orgs      []sinkCall
	users     []sinkCall
	localOrgs map[string][]string
	localUser map[string]map[string][]string
}

type sinkCall struct {
	namespace string
	rooms     []string
	except    []string
	event     string
	payload   string
}

func newFakeSink() *fakeSink {
	return &fakeSink{
		localOrgs: map[string][]string{},
		localUser: map[string]map[string][]string{},
	}
}

func (s *fakeSink) PublishRooms(namespace string, rooms, except []string, event string, payloadJSON json.RawMessage) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.rooms = append(s.rooms, sinkCall{namespace: namespace, rooms: cloneStrings(rooms), except: cloneStrings(except), event: event, payload: string(payloadJSON)})
}

func (s *fakeSink) PublishOrg(namespace, orgID, event string, payloadJSON json.RawMessage) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.orgs = append(s.orgs, sinkCall{namespace: namespace, rooms: []string{"org:" + orgID}, event: event, payload: string(payloadJSON)})
}

func (s *fakeSink) PublishUser(namespace, orgID, userID, event string, payloadJSON json.RawMessage) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.users = append(s.users, sinkCall{namespace: namespace, rooms: []string{"org:" + orgID, "user:" + userID}, event: event, payload: string(payloadJSON)})
}

func (s *fakeSink) LocalOrgIDs(namespace string) []string {
	return cloneStrings(s.localOrgs[namespace])
}

func (s *fakeSink) LocalUsers(namespace, orgID string) []string {
	return cloneStrings(s.localUser[namespace][orgID])
}

func (s *fakeSink) orgCalls() []sinkCall {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]sinkCall{}, s.orgs...)
}

func (s *fakeSink) userCalls() []sinkCall {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]sinkCall{}, s.users...)
}

func cloneStrings(values []string) []string {
	if values == nil {
		return nil
	}
	return append([]string{}, values...)
}

// fakeRedisOps records the newsnow fanout claims and adapter publishes.
type fakeRedisOps struct {
	mu        sync.Mutex
	claims    map[string]bool
	claimKeys []string
	published []publishedAdapter
	claimErr  error
	pubErr    error
}

type publishedAdapter struct {
	channel string
	payload []byte
}

func newFakeRedisOps() *fakeRedisOps {
	return &fakeRedisOps{claims: map[string]bool{}}
}

func (r *fakeRedisOps) Claim(_ context.Context, key string, _ time.Duration) (bool, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.claimKeys = append(r.claimKeys, key)
	if r.claimErr != nil {
		return false, r.claimErr
	}
	if r.claims[key] {
		return false, nil
	}
	r.claims[key] = true
	return true, nil
}

func (r *fakeRedisOps) Publish(_ context.Context, channel string, payload []byte) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.published = append(r.published, publishedAdapter{channel: channel, payload: append([]byte{}, payload...)})
	return r.pubErr
}

func (r *fakeRedisOps) publishedMessages() []publishedAdapter {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]publishedAdapter{}, r.published...)
}

// fakeQueueStore implements graphqlsubscriptions.QueueStore for the unit
// tests. Only the job hash read surface is exercised.
type fakeQueueStore struct {
	jobs map[string]string
}

func (s *fakeQueueStore) ReadStream(context.Context, string, string, int64, time.Duration) ([]graphqlsubscriptions.StreamEntry, error) {
	return nil, nil
}

func (s *fakeQueueStore) ReadJobData(_ context.Context, queue, jobID string) (string, bool, error) {
	value, ok := s.jobs[queue+"/"+jobID]
	return value, ok, nil
}

func (s *fakeQueueStore) ReadSharedContext(context.Context, string) ([]byte, bool, error) {
	return nil, false, nil
}

func (s *fakeQueueStore) WriteSharedContext(context.Context, string, []byte, time.Duration) error {
	return nil
}

func (s *fakeQueueStore) Close() error { return nil }

// fakeResolver is one queueContextResolver for the entry-mapping tests.
type fakeResolver struct {
	context queueContext
	found   bool
	forgot  []string
}

func (r *fakeResolver) Resolve(context.Context, string) (queueContext, bool) {
	return r.context, r.found
}

func (r *fakeResolver) Forget(jobID string) { r.forgot = append(r.forgot, jobID) }

func testSources() *Sources {
	return &Sources{
		options:  Options{AdapterKey: "socket.io", BridgeChannel: DefaultBridgeChannel},
		now:      func() time.Time { return time.Date(2026, 10, 20, 12, 0, 0, 0, time.UTC) },
		newUID:   func() (string, error) { return "OWNUID", nil },
		uid:      "OWNUID",
		newsnow:  newNewsnowRegistry(),
		redisOps: newFakeRedisOps(),
	}
}

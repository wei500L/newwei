//go:build integration

package realtimeintegration

import (
	"testing"

	"github.com/wei500L/newwei/apps/api-go/internal/realtimeevents"
)

// defaultAdapterKey mirrors the NestJS WS_REDIS_ADAPTER_KEY default.
const defaultAdapterKey = "socket.io"

// newRealtimeSources builds the event sources against the harness Redis and
// starts them with the real transport as the local sink. Tests override the
// callback/option fields they need before calling this helper.
func (h *harness) newRealtimeSources(t *testing.T, options realtimeevents.Options, sink realtimeevents.Sink) *realtimeevents.Sources {
	t.Helper()
	if options.Redis == nil {
		options.Redis = h.redis
	}
	if options.RedisOptions == nil {
		options.RedisOptions = h.redisOptions
	}
	if options.AdapterKey == "" {
		options.AdapterKey = defaultAdapterKey
	}
	sources, err := realtimeevents.New(options)
	if err != nil {
		t.Fatalf("realtimeevents.New: %v", err)
	}
	if err := sources.Start(h.ctx, sink); err != nil {
		t.Fatalf("realtimeevents.Start: %v", err)
	}
	t.Cleanup(func() {
		if err := sources.Close(); err != nil {
			t.Logf("realtimeevents.Close: %v", err)
		}
	})
	return sources
}

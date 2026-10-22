package crawl4ai

import (
	"context"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// healthTestSettings are the settings both health probe tests use. The probe
// budget is far longer than the test timeout, so a probe that blocked the caller
// would time out the test instead of failing quickly.
var healthTestSettings = Settings{RequestTimeoutNormalMs: 30_000, HealthCheckTTLMs: 60_000}

// healthTestTarget is a public IP literal: the shared SSRF rules accept it
// without a DNS lookup and the stub transport answers every request, so the test
// never touches the network.
const healthTestTarget = "https://8.8.8.8/article"

// TestHealthProbeMergesConcurrentWaiters pins the single-flight behaviour of
// ensureHealthy: concurrent crawls that arrive with an expired TTL share one GET
// /health instead of issuing one probe each.
func TestHealthProbeMergesConcurrentWaiters(t *testing.T) {
	var probes int32
	release := make(chan struct{})
	probeStarted := make(chan struct{}, 1)
	client, _ := newTestClient(t, func(req *http.Request, body string) (*http.Response, error) {
		if strings.HasSuffix(req.URL.Path, "/health") {
			atomic.AddInt32(&probes, 1)
			select {
			case probeStarted <- struct{}{}:
			default:
			}
			<-release
			return jsonResponse(http.StatusOK, `{}`), nil
		}
		return jsonResponse(http.StatusOK, `{"results":[]}`), nil
	})

	var waitGroup sync.WaitGroup
	errs := make(chan error, 2)
	for index := 0; index < 2; index++ {
		waitGroup.Add(1)
		go func() {
			defer waitGroup.Done()
			_, err := client.Crawl(context.Background(),
				CrawlRequest{URL: healthTestTarget, Options: CrawlOptions{CacheMode: "bypass"}},
				healthTestSettings)
			errs <- err
		}()
	}
	<-probeStarted
	// Give the other crawl time to join the in-flight probe before it finishes.
	time.Sleep(50 * time.Millisecond)
	close(release)
	waitGroup.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatalf("crawl failed: %v", err)
		}
	}
	if got := atomic.LoadInt32(&probes); got != 1 {
		t.Fatalf("health probes = %d, want 1 (merged)", got)
	}
}

// TestHealthProbeWaitHonorsContext pins the cancellation contract: a crawl that
// waits for another crawl's health probe must return as soon as its own context
// is canceled. The worker relies on it — a canceled attempt has to stop instead
// of staying blocked behind an unresponsive GET /health while its job lock keeps
// renewing.
func TestHealthProbeWaitHonorsContext(t *testing.T) {
	release := make(chan struct{})
	probeStarted := make(chan struct{}, 1)
	client, _ := newTestClient(t, func(req *http.Request, body string) (*http.Response, error) {
		if strings.HasSuffix(req.URL.Path, "/health") {
			select {
			case probeStarted <- struct{}{}:
			default:
			}
			<-release
			return jsonResponse(http.StatusOK, `{}`), nil
		}
		return jsonResponse(http.StatusOK, `{"results":[]}`), nil
	})

	ownerDone := make(chan error, 1)
	go func() {
		_, err := client.Crawl(context.Background(),
			CrawlRequest{URL: healthTestTarget, Options: CrawlOptions{CacheMode: "bypass"}},
			healthTestSettings)
		ownerDone <- err
	}()
	<-probeStarted

	waitCtx, cancelWait := context.WithCancel(context.Background())
	waitDone := make(chan error, 1)
	go func() {
		_, err := client.Crawl(waitCtx,
			CrawlRequest{URL: healthTestTarget, Options: CrawlOptions{CacheMode: "bypass"}},
			healthTestSettings)
		waitDone <- err
	}()
	// Let the second crawl reach the probe wait before canceling it.
	time.Sleep(50 * time.Millisecond)
	cancelWait()

	select {
	case err := <-waitDone:
		if err == nil {
			t.Fatal("the canceled crawl must report an error instead of returning a response")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("the health probe wait did not honor its context cancellation")
	}

	close(release)
	if err := <-ownerDone; err != nil {
		t.Fatalf("probe owner failed: %v", err)
	}
}

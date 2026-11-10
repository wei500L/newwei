package rsstranslation

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"

	"github.com/wei500L/newwei/apps/api-go/internal/itemsreading"
)

// fakeTranslationCache is an in-memory translationCache. setErr, when set,
// makes every write fail while the read path keeps working, reproducing a
// Redis outage on the write side only.
type fakeTranslationCache struct {
	mu     sync.Mutex
	values map[string]string
	setErr error
}

func newFakeTranslationCache() *fakeTranslationCache {
	return &fakeTranslationCache{values: make(map[string]string)}
}

func (c *fakeTranslationCache) getManyStrings(_ context.Context, keys []string) ([]*string, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	out := make([]*string, len(keys))
	for index, key := range keys {
		if value, ok := c.values[key]; ok && value != "" {
			copied := value
			out[index] = &copied
		}
	}
	return out, nil
}

func (c *fakeTranslationCache) getString(_ context.Context, key string) (string, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	value, ok := c.values[key]
	return value, ok
}

func (c *fakeTranslationCache) setString(_ context.Context, key, value string, _ int) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.setErr != nil {
		return c.setErr
	}
	c.values[key] = value
	return nil
}

// fakeSettings is a SettingsReader with a fixed runtime.
type fakeSettings struct {
	runtime itemsreading.TranslationRuntimeConfig
}

func (f fakeSettings) RssTranslationStatus(context.Context, *string) ([]itemsreading.RssTranslationProviderStatus, error) {
	return nil, nil
}

func (f fakeSettings) TranslationRuntime(context.Context) (itemsreading.TranslationRuntimeConfig, error) {
	return f.runtime, nil
}

// newDeepLxTestServer returns a DeepLX-shaped endpoint. When fail reports true
// for the source text it answers HTTP 500, otherwise it returns the translation
// "zh:<source>".
func newDeepLxTestServer(t *testing.T, fail func(text string) bool) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var request deepLxRequest
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		if fail != nil && fail(request.Text) {
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]string{"data": "zh:" + request.Text})
	}))
}

func deepLxTestRuntime(serverURL string) itemsreading.TranslationRuntimeConfig {
	return itemsreading.TranslationRuntimeConfig{
		Enabled:         true,
		BaseURL:         serverURL,
		APIKey:          "test-key",
		FallbackEnabled: false,
		TimeoutMs:       5_000,
		MaxRetries:      0,
		MaxConcurrency:  3,
	}
}

func newDeepLxTestClient(serverURL string, cache translationCache) *deepLxClient {
	runtime := deepLxTestRuntime(serverURL)
	return &deepLxClient{
		settings: fakeSettings{runtime: runtime},
		cache:    cache,
		http:     &http.Client{},
		sem:      newSemaphore(runtime.MaxConcurrency),
	}
}

// TestTranslateBestEffortReturnsSuccessfulTextsWhenOneFails is the regression
// for T1: one failing text must not discard the whole page's translations.
func TestTranslateBestEffortReturnsSuccessfulTextsWhenOneFails(t *testing.T) {
	server := newDeepLxTestServer(t, func(text string) bool { return text == "fail" })
	defer server.Close()
	client := newDeepLxTestClient(server.URL, newFakeTranslationCache())

	got := client.TranslateBestEffort(context.Background(), []string{"alpha", "fail", "beta"})

	if len(got) != 2 {
		t.Fatalf("expected 2 translated texts, got %d: %#v", len(got), got)
	}
	if got["alpha"] != "zh:alpha" {
		t.Fatalf("alpha translation = %q, want %q", got["alpha"], "zh:alpha")
	}
	if got["beta"] != "zh:beta" {
		t.Fatalf("beta translation = %q, want %q", got["beta"], "zh:beta")
	}
	if _, ok := got["fail"]; ok {
		t.Fatalf("failed text must not appear in the result: %#v", got)
	}
}

// TestTranslateBestEffortReturnsTranslationWhenCacheWriteFails is the
// regression for the cache-write branch: a Redis write failure on the inner
// cache must not drop an already translated text.
func TestTranslateBestEffortReturnsTranslationWhenCacheWriteFails(t *testing.T) {
	server := newDeepLxTestServer(t, nil)
	defer server.Close()
	cache := newFakeTranslationCache()
	cache.setErr = errors.New("redis write failed")
	client := newDeepLxTestClient(server.URL, cache)

	got := client.TranslateBestEffort(context.Background(), []string{"alpha", "beta"})

	if len(got) != 2 {
		t.Fatalf("expected both translations despite the cache write failure, got %d: %#v", len(got), got)
	}
	if got["alpha"] != "zh:alpha" || got["beta"] != "zh:beta" {
		t.Fatalf("unexpected translations: %#v", got)
	}
}

// TestTranslateHashesReturnsErrorWhenAllFail pins the "only all failed returns
// an error" contract that preserves the overall-unavailable log semantics.
func TestTranslateHashesReturnsErrorWhenAllFail(t *testing.T) {
	server := newDeepLxTestServer(t, func(string) bool { return true })
	defer server.Close()
	client := newDeepLxTestClient(server.URL, newFakeTranslationCache())
	targets := map[string]string{"h1": "alpha", "h2": "beta"}

	translated, err := client.translateHashes(context.Background(), targets, []string{"h1", "h2"}, deepLxTestRuntime(server.URL))

	if err == nil {
		t.Fatalf("expected an error when every text fails")
	}
	if translated != nil {
		t.Fatalf("expected a nil result when every text fails, got %#v", translated)
	}
}

// TestTranslateBestEffortReturnsEmptyWhenAllFail checks the public best-effort
// entry point still degrades to an empty map (never an error) for a dead
// provider.
func TestTranslateBestEffortReturnsEmptyWhenAllFail(t *testing.T) {
	server := newDeepLxTestServer(t, func(string) bool { return true })
	defer server.Close()
	client := newDeepLxTestClient(server.URL, newFakeTranslationCache())

	got := client.TranslateBestEffort(context.Background(), []string{"alpha", "beta"})

	if len(got) != 0 {
		t.Fatalf("expected an empty result when every text fails, got %#v", got)
	}
}

// TestTranslateTextListReturnsTranslationWhenCacheWriteFails covers the outer
// 7 day cache: its write failure used to fail the whole field/item, and must
// now only log.
func TestTranslateTextListReturnsTranslationWhenCacheWriteFails(t *testing.T) {
	server := newDeepLxTestServer(t, nil)
	defer server.Close()
	cache := newFakeTranslationCache()
	cache.setErr = errors.New("redis write failed")
	runtime := deepLxTestRuntime(server.URL)
	service := &Service{
		cache:  cache,
		deeplx: &deepLxClient{settings: fakeSettings{runtime: runtime}, cache: cache, http: &http.Client{}, sem: newSemaphore(runtime.MaxConcurrency)},
	}
	metrics := newMetricsAccumulator(1)

	values, err := service.translateTextList(context.Background(), []string{"alpha"}, translateOptions{
		provider:       ProviderDeepLx,
		targetLanguage: "zh-CN",
		metrics:        metrics,
	})

	if err != nil {
		t.Fatalf("cache write failure must not fail the translation: %v", err)
	}
	if len(values) != 1 || values[0] != "zh:alpha" {
		t.Fatalf("expected the translated text, got %#v", values)
	}
	if metrics.translatedCount != 1 {
		t.Fatalf("expected one counted translation, got %d", metrics.translatedCount)
	}
}

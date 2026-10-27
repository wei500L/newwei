package newssourcescheduler

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"
)

// errTestMigration is the injected database failure.
var errTestMigration = errors.New("database is unavailable")

// newMigrationService builds a service over the in-memory ports with a fixed
// clock so the marker payload and the updatedAt values are stable.
func newMigrationService(t *testing.T) (*Service, *fakeRepo, *fakeCache) {
	t.Helper()
	repo := newFakeRepo()
	cache := newFakeCache()
	service := newServiceWithPorts(repo, cache, Options{
		Settings: Settings{},
		Now:      func() time.Time { return time.Date(2026, 10, 22, 12, 0, 0, 0, time.UTC) },
	})
	return service, repo, cache
}

// TestRemoveLegacyRSSSeedCacheTTLOverride pins the value-level rules of
// removeLegacyRssSeedCacheTtlOverride: only an RSS seed whose rounded
// cacheTtlSeconds is exactly 600 loses the key, and the rest of the document
// keeps its bytes.
func TestRemoveLegacyRSSSeedCacheTTLOverride(t *testing.T) {
	base := `{"enabled":true,"seed":{"enabled":true,"mode":"rss","feedUrl":"https://example.com/feed.xml",` +
		`"maxUrls":200,"cacheTtlSeconds":%s}}`

	cases := []struct {
		name         string
		raw          string
		wantMigrated bool
	}{
		{"number 600", `600`, true},
		{"float that rounds to 600", `600.4`, true},
		{"string 600", `"600"`, true},
		{"string with padding", `" 600.0 "`, true},
		{"mode default value", `60`, false},
		{"other override", `900`, false},
		{"string other override", `"900"`, false},
		{"null", `null`, false},
		{"boolean", `true`, false},
		{"empty string", `""`, false},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			raw := []byte(strings.Replace(base, "%s", testCase.raw, 1))
			migrated, ok := removeLegacyRSSSeedCacheTTLOverride(raw)
			if ok != testCase.wantMigrated {
				t.Fatalf("migrated = %v, want %v (raw=%s)", ok, testCase.wantMigrated, raw)
			}
			if !ok {
				if migrated != nil {
					t.Fatalf("migrated config = %s, want nil", migrated)
				}
				return
			}
			var decoded map[string]json.RawMessage
			if err := json.Unmarshal(migrated, &decoded); err != nil {
				t.Fatalf("migrated config is not valid JSON: %v", err)
			}
			var seed map[string]json.RawMessage
			if err := json.Unmarshal(decoded["seed"], &seed); err != nil {
				t.Fatalf("seed is not an object: %v", err)
			}
			if _, exists := seed["cacheTtlSeconds"]; exists {
				t.Fatalf("cacheTtlSeconds survived: %s", migrated)
			}
			// Untouched leaves keep their exact encoding.
			if string(seed["feedUrl"]) != `"https://example.com/feed.xml"` {
				t.Fatalf("feedUrl changed: %s", seed["feedUrl"])
			}
			if string(seed["maxUrls"]) != "200" {
				t.Fatalf("maxUrls changed: %s", seed["maxUrls"])
			}
			if string(decoded["enabled"]) != "true" {
				t.Fatalf("enabled changed: %s", decoded["enabled"])
			}
		})
	}
}

// TestRemoveLegacyRSSSeedCacheTTLOverrideRejectsShapes covers the config shapes
// the NestJS helper ignores: non-objects, a missing seed, a non-object seed and a
// non-RSS mode.
func TestRemoveLegacyRSSSeedCacheTTLOverrideRejectsShapes(t *testing.T) {
	raws := []string{
		`null`,
		`[]`,
		`"config"`,
		`{}`,
		`{"seed":null}`,
		`{"seed":[]}`,
		`{"seed":{"mode":"sitemap","cacheTtlSeconds":600}}`,
		`{"seed":{"cacheTtlSeconds":600}}`,
		`{"seed":{"mode":" RSS ","cacheTtlSeconds":60}}`,
	}
	for _, raw := range raws {
		if migrated, ok := removeLegacyRSSSeedCacheTTLOverride([]byte(raw)); ok {
			t.Fatalf("%s migrated unexpectedly: %s", raw, migrated)
		}
	}
	// A trimmed, case-insensitive rss mode is still the RSS branch.
	migrated, ok := removeLegacyRSSSeedCacheTTLOverride([]byte(`{"seed":{"mode":" RSS ","cacheTtlSeconds":600}}`))
	if !ok {
		t.Fatal(`mode " RSS " must be treated as rss`)
	}
	if string(migrated) != `{"seed":{"mode":" RSS "}}` {
		t.Fatalf("migrated config = %s", migrated)
	}
}

// TestMigrateLegacyRSSSeedCacheTTLWritesMarkerAndClearsCache covers a full run:
// the matching row loses the override, the other rows stay untouched, the
// discovery cache prefix is cleared once and the done marker records the counts.
func TestMigrateLegacyRSSSeedCacheTTLWritesMarkerAndClearsCache(t *testing.T) {
	service, repo, cache := newMigrationService(t)
	legacy := []byte(`{"seed":{"mode":"rss","cacheTtlSeconds":600,"maxUrls":200}}`)
	modern := []byte(`{"seed":{"mode":"rss","maxUrls":200}}`)
	repo.sourceConfigs["source-legacy"] = legacy
	repo.sourceConfigs["source-modern"] = modern
	cache.values["news-source:rss:source-legacy:24h"] = `[]`

	service.migrateLegacyRSSSeedCacheTTL(context.Background())

	if len(repo.configUpdates) != 1 || repo.configUpdates[0].ID != "source-legacy" {
		t.Fatalf("config updates = %+v, want only source-legacy", repo.configUpdates)
	}
	if string(repo.sourceConfigs["source-modern"]) != string(modern) {
		t.Fatalf("modern source was rewritten: %s", repo.sourceConfigs["source-modern"])
	}
	if len(cache.delByPrefixCalls) != 1 || cache.delByPrefixCalls[0] != "news-source:rss:" {
		t.Fatalf("prefix deletes = %v, want [news-source:rss:]", cache.delByPrefixCalls)
	}
	if _, exists := cache.values["news-source:rss:source-legacy:24h"]; exists {
		t.Fatal("RSS discovery cache entry survived the migration")
	}

	markerRaw, ok := cache.values[rssSeedTTLMigrationDoneKey]
	if !ok {
		t.Fatal("done marker missing")
	}
	var marker rssSeedTTLMigrationMarker
	if err := json.Unmarshal([]byte(markerRaw), &marker); err != nil {
		t.Fatalf("marker is not valid JSON: %v", err)
	}
	if marker.ScannedCount != 2 || marker.MatchedCount != 1 || marker.UpdatedCount != 1 {
		t.Fatalf("marker counts = %+v", marker)
	}
	if marker.CompletedAt != "2026-10-22T12:00:00.000Z" {
		t.Fatalf("marker completedAt = %q", marker.CompletedAt)
	}
	if cache.ttls[rssSeedTTLMigrationDoneKey] != rssSeedTTLMigrationDoneTTL {
		t.Fatalf("marker TTL = %v", cache.ttls[rssSeedTTLMigrationDoneKey])
	}
}

// TestMigrateLegacyRSSSeedCacheTTLKeepsCacheWhenNothingChanged pins the NestJS
// condition that the discovery cache is only cleared when a row actually changed.
func TestMigrateLegacyRSSSeedCacheTTLKeepsCacheWhenNothingChanged(t *testing.T) {
	service, repo, cache := newMigrationService(t)
	repo.sourceConfigs["source-modern"] = []byte(`{"seed":{"mode":"rss","maxUrls":200}}`)
	cache.values["news-source:rss:source-modern:24h"] = `[]`

	service.migrateLegacyRSSSeedCacheTTL(context.Background())

	if len(cache.delByPrefixCalls) != 0 {
		t.Fatalf("prefix deletes = %v, want none", cache.delByPrefixCalls)
	}
	if _, exists := cache.values["news-source:rss:source-modern:24h"]; !exists {
		t.Fatal("RSS discovery cache entry was deleted without an update")
	}
	if !strings.Contains(cache.values[rssSeedTTLMigrationDoneKey], `"updatedCount":0`) {
		t.Fatalf("marker = %s", cache.values[rssSeedTTLMigrationDoneKey])
	}
}

// TestMigrateLegacyRSSSeedCacheTTLIsIdempotent covers the done marker: a second
// call scans nothing.
func TestMigrateLegacyRSSSeedCacheTTLIsIdempotent(t *testing.T) {
	service, repo, cache := newMigrationService(t)
	repo.sourceConfigs["source-legacy"] = []byte(`{"seed":{"mode":"rss","cacheTtlSeconds":600}}`)

	service.migrateLegacyRSSSeedCacheTTL(context.Background())
	if repo.configListCalls != 1 {
		t.Fatalf("list calls after first run = %d", repo.configListCalls)
	}
	service.migrateLegacyRSSSeedCacheTTL(context.Background())
	if repo.configListCalls != 1 {
		t.Fatalf("list calls after second run = %d, want the marker to short-circuit", repo.configListCalls)
	}
	if len(cache.delByPrefixCalls) != 1 {
		t.Fatalf("prefix deletes = %v, want exactly one", cache.delByPrefixCalls)
	}
}

// TestMigrateLegacyRSSSeedCacheTTLSkipsWhenLockHeld covers the shared lease: a
// tick on another instance (or NestJS) owning the lock leaves the scan to it.
func TestMigrateLegacyRSSSeedCacheTTLSkipsWhenLockHeld(t *testing.T) {
	service, repo, cache := newMigrationService(t)
	repo.sourceConfigs["source-legacy"] = []byte(`{"seed":{"mode":"rss","cacheTtlSeconds":600}}`)
	cache.values["lock:"+rssSeedTTLMigrationLockKey] = "other-owner"

	service.migrateLegacyRSSSeedCacheTTL(context.Background())

	if repo.configListCalls != 0 {
		t.Fatalf("list calls = %d, want 0 while the lease is held", repo.configListCalls)
	}
	if len(repo.configUpdates) != 0 {
		t.Fatalf("config updates = %+v, want none", repo.configUpdates)
	}
	if _, exists := cache.values[rssSeedTTLMigrationDoneKey]; exists {
		t.Fatal("done marker written without running the migration")
	}
}

// TestMigrateLegacyRSSSeedCacheTTLRetriesLostRace covers the optimistic write:
// the first conditional update loses against a concurrent edit, the re-read value
// still carries the legacy override, and the retry succeeds.
func TestMigrateLegacyRSSSeedCacheTTLRetriesLostRace(t *testing.T) {
	service, repo, cache := newMigrationService(t)
	repo.sourceConfigs["source-legacy"] = []byte(`{"seed":{"mode":"rss","cacheTtlSeconds":600}}`)
	repo.configConflicts = 1

	service.migrateLegacyRSSSeedCacheTTL(context.Background())

	if len(repo.configUpdates) != 1 {
		t.Fatalf("config updates = %+v, want the retry to succeed", repo.configUpdates)
	}
	if !strings.Contains(cache.values[rssSeedTTLMigrationDoneKey], `"updatedCount":1`) {
		t.Fatalf("marker = %s", cache.values[rssSeedTTLMigrationDoneKey])
	}
}

// TestMigrateLegacyRSSSeedCacheTTLGivesUpAfterRetries pins the retry budget: a
// row that keeps losing the race is counted as matched but not updated, and the
// migration still writes the marker so it does not spin on every boot.
func TestMigrateLegacyRSSSeedCacheTTLGivesUpAfterRetries(t *testing.T) {
	service, repo, cache := newMigrationService(t)
	repo.sourceConfigs["source-legacy"] = []byte(`{"seed":{"mode":"rss","cacheTtlSeconds":600}}`)
	repo.configConflicts = rssSeedTTLMigrationMaxRetries

	service.migrateLegacyRSSSeedCacheTTL(context.Background())

	if len(repo.configUpdates) != 0 {
		t.Fatalf("config updates = %+v, want none", repo.configUpdates)
	}
	if !strings.Contains(cache.values[rssSeedTTLMigrationDoneKey], `"updatedCount":0`) ||
		!strings.Contains(cache.values[rssSeedTTLMigrationDoneKey], `"matchedCount":1`) {
		t.Fatalf("marker = %s", cache.values[rssSeedTTLMigrationDoneKey])
	}
	if len(cache.delByPrefixCalls) != 0 {
		t.Fatalf("prefix deletes = %v, want none", cache.delByPrefixCalls)
	}
}

// TestMigrateLegacyRSSSeedCacheTTLFailureIsNotFatal covers the NestJS try/catch:
// a database error is logged and no marker is written, so the next boot retries.
func TestMigrateLegacyRSSSeedCacheTTLFailureIsNotFatal(t *testing.T) {
	service, repo, cache := newMigrationService(t)
	repo.sourceConfigs["source-legacy"] = []byte(`{"seed":{"mode":"rss","cacheTtlSeconds":600}}`)
	repo.configReplaceErr = errTestMigration

	service.migrateLegacyRSSSeedCacheTTL(context.Background())

	if _, exists := cache.values[rssSeedTTLMigrationDoneKey]; exists {
		t.Fatal("done marker written after a failed migration")
	}
	if _, exists := cache.values["lock:"+rssSeedTTLMigrationLockKey]; exists {
		t.Fatal("lease was not released after a failed migration")
	}
}

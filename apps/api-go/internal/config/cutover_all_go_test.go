package config

import (
	"bufio"
	"os"
	"reflect"
	"strings"
	"testing"
)

// readEnvFixture parses a KEY=VALUE fixture. Blank lines and lines starting with
// '#' are ignored; a value is never defaulted here so a missing switch shows up
// as a failed assertion instead of silently keeping its legacy default.
func readEnvFixture(t *testing.T, path string) map[string]string {
	t.Helper()
	file, err := os.Open(path)
	if err != nil {
		t.Fatalf("open %s: %v", path, err)
	}
	defer file.Close()

	env := map[string]string{}
	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		key, value, ok := strings.Cut(line, "=")
		if !ok {
			t.Fatalf("invalid fixture line %q in %s", line, path)
		}
		env[strings.TrimSpace(key)] = strings.TrimSpace(value)
	}
	if err := scanner.Err(); err != nil {
		t.Fatalf("scan %s: %v", path, err)
	}
	return env
}

// TestAllGoCutoverConfigLoads is the T2 cutover gate for config.Load: the
// all-go fixture (every API_GO_* switch = go plus placeholder resources, and
// API_GO_LEGACY_FALLBACK_MODE=reject) must pass every cross-switch and resource
// validation, and every *Mode field must actually read "go". If a future switch
// is added without updating testdata/all-go.env, the field keeps its legacy
// default and this test fails.
//
// API_GO_LEGACY_FALLBACK_MODE is the single exception: its accepted values are
// proxy and reject, so it can never read "go". tests in
// cutover_legacy_fallback_test.go cover its own validation.
func TestAllGoCutoverConfigLoads(t *testing.T) {
	env := readEnvFixture(t, "testdata/all-go.env")
	cfg, err := Load(func(key string) string { return env[key] })
	if err != nil {
		t.Fatalf("config.Load rejected the all-go cutover fixture: %v", err)
	}

	value := reflect.ValueOf(cfg)
	typ := value.Type()
	seen := 0
	for i := 0; i < typ.NumField(); i++ {
		field := typ.Field(i)
		if !strings.HasSuffix(field.Name, "Mode") || field.Type.Kind() != reflect.String {
			continue
		}
		if _, exempt := legacyRejectExemptModes[field.Name]; exempt {
			continue
		}
		seen++
		if got := value.Field(i).String(); got != "go" {
			t.Errorf("%s = %q, want go; testdata/all-go.env is missing its API_GO_* switch", field.Name, got)
		}
	}
	// The switch matrix documents 135 API_GO_* switches (130 before the
	// refactor/go-ops-entrypoints and refactor/go-crawl-frontier-writes batches)
	// and every one of them lands in exactly one *Mode field. One of them,
	// API_GO_LEGACY_FALLBACK_MODE, is exempt from this "must read go" check, so
	// 134 non-exempt fields remain. Keep the count in sync with config.go and
	// the switch matrix.
	if seen != 134 {
		t.Fatalf("config has %d non-exempt string *Mode fields, want 134", seen)
	}
}

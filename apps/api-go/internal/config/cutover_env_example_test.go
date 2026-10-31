package config

import (
	"bufio"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"testing"
)

// readDotEnvFile parses a dotenv file used by the repository samples. It is
// stricter than readEnvFixture: duplicate keys fail the test because the last
// assignment would silently hide a stale legacy/shadow value.
func readDotEnvFile(t *testing.T, path string) map[string]string {
	t.Helper()
	file, err := os.Open(path)
	if err != nil {
		t.Fatalf("open %s: %v", path, err)
	}
	defer file.Close()

	env := map[string]string{}
	seen := map[string]struct{}{}
	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		key, value, ok := strings.Cut(line, "=")
		if !ok {
			t.Fatalf("invalid dotenv line %q in %s", line, path)
		}
		key = strings.TrimSpace(key)
		if _, exists := seen[key]; exists {
			t.Fatalf("duplicate key %s in %s; last assignment would win silently", key, path)
		}
		seen[key] = struct{}{}

		value = strings.TrimSpace(value)
		if len(value) >= 2 && value[0] == '"' && value[len(value)-1] == '"' {
			if unquoted, unquoteErr := strconv.Unquote(value); unquoteErr == nil {
				value = unquoted
			}
		}
		env[key] = value
	}
	if err := scanner.Err(); err != nil {
		t.Fatalf("scan %s: %v", path, err)
	}
	return env
}

// mergeExampleOverResources builds the environment a user gets after copying
// .env.example and filling the required resources: the resource fixture supplies
// every empty required value, while non-empty example entries override it.
func mergeExampleOverResources(example map[string]string, resources map[string]string) map[string]string {
	env := make(map[string]string, len(resources)+len(example))
	for key, value := range resources {
		env[key] = value
	}
	for key, value := range example {
		if strings.TrimSpace(value) != "" {
			env[key] = value
		}
	}
	return env
}

func modeFieldNames() []string {
	typ := reflect.TypeOf(Config{})
	names := make([]string, 0, 137)
	for i := 0; i < typ.NumField(); i++ {
		field := typ.Field(i)
		if strings.HasSuffix(field.Name, "Mode") && field.Type.Kind() == reflect.String {
			names = append(names, field.Name)
		}
	}
	return names
}

// TestRootEnvExampleResolvesToGoDefault is the follow-up gate for the file users
// actually copy. The earlier default test deliberately starts from resources
// only; it cannot catch a shipped example that still pins onboarding=shadow,
// user-settings-write=legacy or the old API/Socket.IO addresses. This test feeds
// the real .env.example (plus placeholder resources for the empty secrets) into
// config.Load and asserts the resulting chain is the all-Go default.
func TestRootEnvExampleResolvesToGoDefault(t *testing.T) {
	examplePath := filepath.Join("..", "..", "..", "..", ".env.example")
	example := readDotEnvFile(t, examplePath)
	resources := readResourceFixture(t, "testdata/default-resources.env")
	env := mergeExampleOverResources(example, resources)

	cfg, err := Load(func(key string) string { return env[key] })
	if err != nil {
		t.Fatalf("config.Load rejected the shipped .env.example: %v", err)
	}

	if cfg.Port != 4020 {
		t.Errorf("PORT from .env.example = %d, want 4020", cfg.Port)
	}
	if cfg.LegacyAPIURL != "http://localhost:4000" {
		t.Errorf("LegacyAPIURL = %q, want the historical NestJS default", cfg.LegacyAPIURL)
	}
	if cfg.CanaryPercent != 0 {
		t.Errorf("CanaryPercent = %d, want 0", cfg.CanaryPercent)
	}
	if cfg.LegacyFallbackMode != LegacyFallbackModeReject {
		t.Errorf("LegacyFallbackMode = %q, want reject", cfg.LegacyFallbackMode)
	}

	value := reflect.ValueOf(cfg)
	typ := value.Type()
	checked := 0
	for i := 0; i < typ.NumField(); i++ {
		field := typ.Field(i)
		if !strings.HasSuffix(field.Name, "Mode") || field.Type.Kind() != reflect.String {
			continue
		}
		if _, exempt := legacyRejectExemptModes[field.Name]; exempt {
			continue
		}
		checked++
		if got := value.Field(i).String(); got != "go" {
			t.Errorf("%s = %q after loading .env.example, want go", field.Name, got)
		}
	}
	if checked != 136 {
		t.Fatalf("config has %d non-exempt string *Mode fields, want 136", checked)
	}

	for key, value := range example {
		if !strings.HasPrefix(key, "API_GO_") || !strings.HasSuffix(key, "_MODE") {
			continue
		}
		if key == "API_GO_LEGACY_FALLBACK_MODE" {
			if value != "reject" {
				t.Errorf(".env.example %s = %q, want reject", key, value)
			}
			continue
		}
		if value != "go" {
			t.Errorf(".env.example %s = %q, want go (explicit legacy/shadow belongs only in the rollback sample)", key, value)
		}
	}

	for key, want := range map[string]string{
		"API_BASE_URL":                          "http://localhost:4020",
		"NEXT_PUBLIC_API_BASE_URL":              "http://localhost:4020/api",
		"NEXT_PUBLIC_NOTIFICATIONS_SOCKET_PATH": "/socket.io-notifications",
		"NEXT_PUBLIC_REALTIME_SOCKET_PATH":      "/socket.io-realtime",
		"VECTOR_SERVICE_BASE_URL":               "http://localhost:4010",
		"REALTIME_SIGNALS_AIS_BASE_URL":         "http://localhost:3004",
		"AIS_RELAY_PORT":                        "3004",
		"API_GO_LEGACY_FALLBACK_MODE":           "reject",
		"CANARY_PERCENT":                        "0",
	} {
		if got := example[key]; got != want {
			t.Errorf(".env.example %s = %q, want %q", key, got, want)
		}
	}
}

// TestLegacyRollbackSampleMatchesConfig closes the other half: the explicit
// rollback sample must name every API_GO_*_MODE switch exactly once, with only
// values config.Load accepts. onboarding and user-settings-read have no legacy
// value, so their fallback spelling is shadow; every other business switch is
// legacy and the fallback itself is proxy.
func TestLegacyRollbackSampleMatchesConfig(t *testing.T) {
	samplePath := filepath.Join("..", "..", "..", "..", "infra", "docker", "legacy-rollback.env.sample")
	sample := readDotEnvFile(t, samplePath)

	expected := make(map[string]struct{}, 137)
	for _, field := range modeFieldNames() {
		expected[modeSwitchEnvName(field)] = struct{}{}
	}
	if len(expected) != 137 {
		t.Fatalf("config has %d API_GO_*_MODE environment names, want 137", len(expected))
	}

	for key := range expected {
		if _, ok := sample[key]; !ok {
			t.Errorf("%s is missing from legacy-rollback.env.sample", key)
		}
	}
	for key := range sample {
		if !strings.HasPrefix(key, "API_GO_") || !strings.HasSuffix(key, "_MODE") {
			t.Errorf("legacy-rollback.env.sample contains unexpected non-switch key %s", key)
			continue
		}
		if _, ok := expected[key]; !ok {
			t.Errorf("legacy-rollback.env.sample contains unknown switch %s", key)
		}
	}

	if got := sample["API_GO_LEGACY_FALLBACK_MODE"]; got != "proxy" {
		t.Errorf("API_GO_LEGACY_FALLBACK_MODE = %q, want proxy", got)
	}
	for _, key := range []string{"API_GO_ONBOARDING_MODE", "API_GO_USER_SETTINGS_READ_MODE"} {
		if got := sample[key]; got != "shadow" {
			t.Errorf("%s = %q, want the legal shadow fallback", key, got)
		}
	}
	for key, value := range sample {
		if !strings.HasPrefix(key, "API_GO_") || !strings.HasSuffix(key, "_MODE") {
			continue
		}
		if key == "API_GO_LEGACY_FALLBACK_MODE" ||
			key == "API_GO_ONBOARDING_MODE" ||
			key == "API_GO_USER_SETTINGS_READ_MODE" {
			continue
		}
		if value != "legacy" {
			t.Errorf("%s = %q, want legacy", key, value)
		}
	}

	resources := readResourceFixture(t, "testdata/default-resources.env")
	for key, value := range sample {
		resources[key] = value
	}
	if _, err := Load(func(key string) string { return resources[key] }); err != nil {
		t.Fatalf("config.Load rejected legacy-rollback.env.sample: %v", err)
	}
}

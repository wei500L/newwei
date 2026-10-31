package config

import (
	"os"
	"reflect"
	"strings"
	"testing"
)

// readResourceFixture parses a KEY=VALUE file the same way readEnvFixture does,
// but is used for the resource-only fixture that deliberately contains no
// API_GO_*_MODE switch.
func readResourceFixture(t *testing.T, path string) map[string]string {
	t.Helper()
	return readEnvFixture(t, path)
}

// defaultResources returns the placeholder resources the go defaults need.
//
// Tests that only care about one switch used to load an empty environment,
// because every other switch defaulted to legacy and required nothing. With the
// go default, an empty environment fails startup on the first missing store, so
// those tests supply these resources and leave the switches alone -- which is
// exactly what an operator does in the default deployment.
func defaultResources(t *testing.T) map[string]string {
	t.Helper()
	return readResourceFixture(t, "testdata/default-resources.env")
}

// loadDefaultsWithoutEncryptionKey resolves the default configuration with
// SYSTEM_SETTINGS_ENCRYPTION_KEY removed.
//
// The default fixture carries a placeholder key because several go modes require
// one at startup. Tests that assert what happens when it is unset need this
// variant, otherwise the placeholder would satisfy the assertion.
// The three modes that require the key are pinned to legacy for this variant, so
// the assertion is about the unset key rather than about a mode that cannot start
// without one.
func loadDefaultsWithoutEncryptionKey(t *testing.T) Config {
	t.Helper()
	env := defaultResources(t)
	delete(env, "SYSTEM_SETTINGS_ENCRYPTION_KEY")
	for _, key := range []string{
		"API_GO_ARCHIVE_PREPARATION_WORKER_MODE",
		"API_GO_CRAWL_FRONTIER_LLM_WORKER_MODE",
		"API_GO_CRAWL_WORKER_MODE",
		"API_GO_ITEM_PIPELINE_WORKER_MODE",
		"API_GO_SITUATION_SETTINGS_MODE",
		"API_GO_SITUATION_TELEGRAM_AUTH_MODE",
	} {
		env[key] = "legacy"
	}
	// reject mode requires every switch to be go, so rolling those three back
	// means the fallback has to be proxy for this variant.
	env["API_GO_LEGACY_FALLBACK_MODE"] = "proxy"
	cfg, err := Load(func(key string) string { return env[key] })
	if err != nil {
		t.Fatalf("config.Load rejected the default resources without an encryption key: %v", err)
	}
	return cfg
}

// loadDefaults resolves the configuration from the placeholder resources only,
// i.e. every API_GO_*_MODE switch keeps its default value.
func loadDefaults(t *testing.T) Config {
	t.Helper()
	env := defaultResources(t)
	cfg, err := Load(func(key string) string { return env[key] })
	if err != nil {
		t.Fatalf("config.Load rejected the default (resource-only) configuration: %v", err)
	}
	return cfg
}

// loadWithDefaults is loadDefaults plus the given switch overrides. Use it when
// a test needs one switch pinned but every other switch should keep its default.
func loadWithDefaults(t *testing.T, overrides map[string]string) (Config, error) {
	t.Helper()
	env := defaultResources(t)
	for key, value := range overrides {
		env[key] = value
	}
	return Load(func(key string) string { return env[key] })
}

// legacyUnset wraps a fixture so that *Mode keys it does not name read as their
// rollback value instead of the go default.
//
// Many switch tests were written against "empty environment = all legacy": they
// pin the switch under test and let every other switch fall through to "". That
// was a statement about the old defaults, not about the switch under test. After
// the cutover "" means go, so those fixtures would start requiring the full
// credentialed stack and assert the wrong branch.
//
// named lists the keys the fixture answers itself, including an explicit "". Those
// are passed through untouched so a test that asserts the default branch still
// reaches the parser. Everything else falls back to the rollback value.
// onboarding and user-settings-read accept shadow|go, and the fallback accepts
// proxy|reject, so those three take their rollback spelling.
func legacyUnset(fn func(string) string, named ...string) func(string) string {
	owned := make(map[string]struct{}, len(named))
	for _, key := range named {
		owned[key] = struct{}{}
	}
	return func(key string) string {
		value := fn(key)
		if !strings.HasPrefix(key, "API_GO_") || !strings.HasSuffix(key, "_MODE") {
			return value
		}
		if _, ok := owned[key]; ok {
			return value
		}
		if value != "" {
			return value
		}
		switch key {
		case "API_GO_ONBOARDING_MODE", "API_GO_USER_SETTINGS_READ_MODE":
			return "shadow"
		case "API_GO_LEGACY_FALLBACK_MODE":
			return "proxy"
		default:
			return "legacy"
		}
	}
}

// loadOverResources resolves fn on top of the placeholder resources.
//
// Most switch tests only care about one switch and used to load an empty
// environment, which worked while every other switch defaulted to legacy and
// demanded nothing. The repository default is now go, so an empty environment
// fails startup on the first missing store. Layering the test's own overrides on
// top of the resource placeholders restores the original intent: the tested
// switch keeps whatever the test sets, everything else keeps its default.
func loadOverResources(t *testing.T, fn func(string) string) (Config, error) {
	t.Helper()
	env := defaultResources(t)
	return Load(func(key string) string {
		if fn != nil {
			if value := fn(key); value != "" {
				return value
			}
		}
		return env[key]
	})
}

// legacyOverlayLoad resolves fn on top of the explicit legacy baseline: a key fn
// returns empty for keeps its baseline value. That makes the intent of the
// independence and dependency tests explicit -- "pin this switch to go, leave the
// rest on the rollback configuration" -- without depending on the switch default,
// which is now go.
func legacyOverlayLoad(t *testing.T, fn func(string) string) (Config, error) {
	t.Helper()
	env := legacyEnv(t)
	return Load(func(key string) string {
		if fn != nil {
			if value := fn(key); value != "" {
				return value
			}
		}
		return env[key]
	})
}

// legacyEnvForKeys returns a getenv function that puts every non-exempt switch
// on its rollback value and leaves resources unset.
//
// Test fixtures use it to keep the switches they do not name on the rollback
// configuration, so a fixture that pins one switch does not have to satisfy the
// go stack required by all the others.
func legacyEnvForKeys() func(string) string {
	env := map[string]string{}
	typ := reflect.TypeOf(Config{})
	for i := 0; i < typ.NumField(); i++ {
		field := typ.Field(i)
		if !strings.HasSuffix(field.Name, "Mode") || field.Type.Kind() != reflect.String {
			continue
		}
		if _, exempt := legacyRejectExemptModes[field.Name]; exempt {
			continue
		}
		name := modeSwitchEnvName(field.Name)
		switch name {
		case "API_GO_ONBOARDING_MODE", "API_GO_USER_SETTINGS_READ_MODE":
			env[name] = "shadow"
		default:
			env[name] = "legacy"
		}
	}
	env["API_GO_LEGACY_FALLBACK_MODE"] = "proxy"
	return func(key string) string { return env[key] }
}

// legacyEnv returns an environment where every non-exempt switch is on its
// rollback value and no resource is set.
//
// This reproduces what an empty environment meant before the cutover. Tests that
// assert "switch X = go fails without DATABASE_URL" need exactly this: only the
// switch under test is go, so the startup error names that switch and no other.
//
// onboarding and user-settings-read accept shadow|go (not legacy) and the
// fallback accepts proxy|reject, so those three take their rollback spelling.
func legacyEnv(t *testing.T) map[string]string {
	t.Helper()
	env := map[string]string{}
	typ := reflect.TypeOf(Config{})
	for i := 0; i < typ.NumField(); i++ {
		field := typ.Field(i)
		if !strings.HasSuffix(field.Name, "Mode") || field.Type.Kind() != reflect.String {
			continue
		}
		if _, exempt := legacyRejectExemptModes[field.Name]; exempt {
			continue
		}
		name := modeSwitchEnvName(field.Name)
		switch name {
		case "API_GO_ONBOARDING_MODE", "API_GO_USER_SETTINGS_READ_MODE":
			env[name] = "shadow"
		default:
			env[name] = "legacy"
		}
	}
	env["API_GO_LEGACY_FALLBACK_MODE"] = "proxy"
	return env
}

// TestDefaultConfigIsAllGoWithoutAnyModeSwitch is the repository-default gate.
//
// testdata/default-resources.env holds only connection and secret placeholders:
// it deliberately sets no API_GO_*_MODE variable. Loading it must therefore
// exercise the switch defaults themselves -- every non-exempt *Mode field has to
// read "go" and the fallback has to read "reject". This is the test the cutover
// exists for: it fails if any switch's default branch is still legacy, shadow,
// empty or proxy, and it cannot be masked by an all-go fixture that spells the
// switches out.
func TestDefaultConfigIsAllGoWithoutAnyModeSwitch(t *testing.T) {
	env := readResourceFixture(t, "testdata/default-resources.env")

	for key := range env {
		if strings.HasPrefix(key, "API_GO_") {
			t.Fatalf("testdata/default-resources.env must not set %s: the point of this test is the default branch", key)
		}
	}

	cfg, err := Load(func(key string) string { return env[key] })
	if err != nil {
		t.Fatalf("config.Load rejected the resource-only default fixture: %v", err)
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
			t.Errorf("%s = %q with no switch set, want go (default branch is not the takeover branch)",
				field.Name, got)
		}
	}
	if checked != 136 {
		t.Fatalf("config has %d non-exempt string *Mode fields, want 136", checked)
	}
}

// TestDefaultFixtureCoversEveryResourceRequirement guards the fixture above:
// if a mode gains a new required resource, loading the default fixture would
// start failing for a reason unrelated to the switch defaults. Asserting the
// error is empty keeps the failure message pointed at the fixture instead.
func TestDefaultFixtureCoversEveryResourceRequirement(t *testing.T) {
	env := readResourceFixture(t, "testdata/default-resources.env")
	if _, err := Load(func(key string) string { return env[key] }); err != nil {
		t.Fatalf("default fixture is missing a resource required by the go default: %v", err)
	}
}

// TestAllGoFixtureStillDetectsMissingSwitch keeps the existing all-go gate
// meaningful after the default flipped to go.
//
// Before the cutover, omitting a switch from testdata/all-go.env left that field
// at its legacy default, so the "every field must read go" assertion caught it.
// Now the default is go too, so that assertion can no longer detect a missing
// line. The completeness check therefore moves to the fixture text: every
// non-exempt *Mode field must still be spelled out in all-go.env. The all-go
// fixture keeps its own purpose -- proving that naming every switch explicitly
// produces the same result as relying on the defaults.
func TestAllGoFixtureStillDetectsMissingSwitch(t *testing.T) {
	env := readEnvFixture(t, "testdata/all-go.env")

	cfg, err := Load(func(key string) string { return env[key] })
	if err != nil {
		t.Fatalf("all-go fixture must load: %v", err)
	}

	value := reflect.ValueOf(cfg)
	typ := value.Type()
	for i := 0; i < typ.NumField(); i++ {
		field := typ.Field(i)
		if !strings.HasSuffix(field.Name, "Mode") || field.Type.Kind() != reflect.String {
			continue
		}
		if _, exempt := legacyRejectExemptModes[field.Name]; exempt {
			continue
		}
		name := modeSwitchEnvName(field.Name)
		if _, ok := env[name]; !ok {
			t.Errorf("testdata/all-go.env does not name %s (%s); the fixture must stay complete even though the field now defaults to go",
				name, field.Name)
		}
	}
}

// TestAllGoFixtureMatchesOmittedSwitches pins the property that makes the two
// fixtures interchangeable for validation: spelling every switch out and
// omitting them all must produce the same resolved configuration.
func TestAllGoFixtureMatchesOmittedSwitches(t *testing.T) {
	explicit := readEnvFixture(t, "testdata/all-go.env")
	defaults := readResourceFixture(t, "testdata/default-resources.env")

	explicitCfg, err := Load(func(key string) string { return explicit[key] })
	if err != nil {
		t.Fatalf("all-go fixture: %v", err)
	}
	defaultCfg, err := Load(func(key string) string { return defaults[key] })
	if err != nil {
		t.Fatalf("default fixture: %v", err)
	}

	explicitValue := reflect.ValueOf(explicitCfg)
	defaultValue := reflect.ValueOf(defaultCfg)
	typ := explicitValue.Type()
	for i := 0; i < typ.NumField(); i++ {
		field := typ.Field(i)
		if !strings.HasSuffix(field.Name, "Mode") || field.Type.Kind() != reflect.String {
			continue
		}
		if got, want := defaultValue.Field(i).String(), explicitValue.Field(i).String(); got != want {
			t.Errorf("%s: default = %q, all-go fixture = %q; the two must agree",
				field.Name, got, want)
		}
	}
}

// TestResourceFixtureIsPlaceholdersOnly keeps secrets out of the repository.
func TestResourceFixtureIsPlaceholdersOnly(t *testing.T) {
	raw, err := os.ReadFile("testdata/default-resources.env")
	if err != nil {
		t.Fatalf("read fixture: %v", err)
	}
	text := strings.ToLower(string(raw))
	for _, forbidden := range []string{"sk-", "-----begin", "akia"} {
		if strings.Contains(text, forbidden) {
			t.Fatalf("testdata/default-resources.env contains something that looks like a real credential: %q", forbidden)
		}
	}
}

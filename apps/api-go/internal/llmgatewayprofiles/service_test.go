package llmgatewayprofiles

import (
	"context"
	"encoding/json"
	"errors"
	"regexp"
	"strings"
	"testing"
)

// testEnv is the effective environment configuration used by the unit tests.
func testEnv() EnvDefaults {
	return EnvDefaults{
		Model:           "openai/gpt-4o-mini",
		APIBase:         "http://localhost:4001",
		TimeoutMs:       60000,
		Temperature:     0.2,
		TopP:            0.9,
		MaxOutputTokens: 2048,
		MaxRetries:      3,
		FallbackModels:  []string{"openai/gpt-4o-mini"},
	}
}

// testService builds a Service that never touches MySQL: every test here uses a
// code path that only needs the resolved configuration.
func testService(env EnvDefaults) *Service {
	return &Service{cfg: Config{Env: env}}
}

// plaintextSecurity makes encodeSecretForStorage take the explicit plaintext
// branch without needing SYSTEM_SETTINGS_ENCRYPTION_KEY.
func plaintextSecurity() func(context.Context) (securitySettingsProjection, error) {
	return func(context.Context) (securitySettingsProjection, error) {
		return securitySettingsProjection{SecretEncryptionEnabled: json.RawMessage(`false`)}, nil
	}
}

func TestNormalizeEnabledGP3(t *testing.T) {
	cases := []struct {
		raw  string
		want bool
	}{
		{raw: `"false"`, want: false},
		{raw: `"true"`, want: false},
		{raw: `1`, want: false},
		{raw: `0`, want: false},
		{raw: `{}`, want: false},
		{raw: `[]`, want: false},
		{raw: `true`, want: true},
		{raw: `false`, want: false},
		{raw: `null`, want: true},
		{raw: ``, want: true},
	}
	for _, tc := range cases {
		profile, ok := NormalizeProfile(json.RawMessage(`{"id":"p1","model":"m","enabled":`+tc.raw+`}`), testEnv())
		if !ok {
			t.Fatalf("enabled=%s profile was filtered", tc.raw)
		}
		if profile.Enabled != tc.want {
			t.Fatalf("enabled=%s normalized to %v, want %v", tc.raw, profile.Enabled, tc.want)
		}
		// The public projection always serializes a real JSON boolean.
		public := PublicProfileOf(profile, false)
		payload, err := json.Marshal(public)
		if err != nil {
			t.Fatal(err)
		}
		needle := `"enabled":false`
		if tc.want {
			needle = `"enabled":true`
		}
		if !strings.Contains(string(payload), needle) {
			t.Fatalf("public enabled=%s payload=%s, want %s", tc.raw, payload, needle)
		}
	}
}

func TestNormalizeSettingsClearsUnusableActiveIDs(t *testing.T) {
	document := `{
		"activeId": "disabled",
		"embeddingActiveId": "no-embedding",
		"rerankActiveId": "missing",
		"embeddingMode": " use_default ",
		"rerankMode": "bogus",
		"profiles": [
			{"id":"disabled","model":"m","enabled":false},
			{"id":"no-embedding","model":"m","enabled":true},
			{"id":"with-embedding","model":"m","enabled":true,"embeddingModel":"e"},
			{"id":"with-rerank","model":"m","enabled":true,"rerankModel":"r"}
		]
	}`
	settings := NormalizeSettings(json.RawMessage(document), testEnv())
	if settings.ActiveID != nil {
		t.Fatalf("activeId = %v, want null", *settings.ActiveID)
	}
	if settings.EmbeddingActiveID == nil || *settings.EmbeddingActiveID != "with-embedding" {
		// The stored id no longer exists, so it must be cleared.
		if settings.EmbeddingActiveID != nil {
			t.Fatalf("embeddingActiveId = %v, want null", *settings.EmbeddingActiveID)
		}
	}
	if settings.RerankActiveID != nil {
		t.Fatalf("rerankActiveId = %v, want null", *settings.RerankActiveID)
	}
	if settings.EmbeddingMode != EmbeddingModeUseDefault {
		t.Fatalf("embeddingMode = %s, want use_default", settings.EmbeddingMode)
	}
	if settings.RerankMode != RerankModeFollowCompletion {
		t.Fatalf("rerankMode = %s, want follow_completion", settings.RerankMode)
	}
}

func TestNormalizeSettingsKeepsUsableActiveIDs(t *testing.T) {
	document := `{
		"activeId": "completion",
		"embeddingActiveId": "embed",
		"rerankActiveId": "rerank",
		"profiles": [
			{"id":"completion","model":"m","enabled":true},
			{"id":"embed","model":"m","enabled":true,"embeddingModel":"e"},
			{"id":"rerank","model":"m","enabled":true,"rerankModel":"r"}
		]
	}`
	settings := NormalizeSettings(json.RawMessage(document), testEnv())
	if settings.ActiveID == nil || *settings.ActiveID != "completion" {
		t.Fatalf("activeId = %v", settings.ActiveID)
	}
	if settings.EmbeddingActiveID == nil || *settings.EmbeddingActiveID != "embed" {
		t.Fatalf("embeddingActiveId = %v", settings.EmbeddingActiveID)
	}
	if settings.RerankActiveID == nil || *settings.RerankActiveID != "rerank" {
		t.Fatalf("rerankActiveId = %v", settings.RerankActiveID)
	}
}

func TestNormalizeProfileFiltering(t *testing.T) {
	env := testEnv()
	if _, ok := NormalizeProfile(json.RawMessage(`{"model":"m"}`), env); ok {
		t.Fatal("profile without id must be filtered")
	}
	if _, ok := NormalizeProfile(json.RawMessage(`{"id":"p1"}`), env); ok {
		t.Fatal("profile without model must be filtered")
	}
	if _, ok := NormalizeProfile(json.RawMessage(`{"id":"  ","model":"m"}`), env); ok {
		t.Fatal("profile with a blank id must be filtered")
	}
	if _, ok := NormalizeProfile(json.RawMessage(`42`), env); ok {
		t.Fatal("non-object profile must be filtered")
	}
	// A missing model is never backfilled from LITELLM_MODEL.
	settings := NormalizeSettings(json.RawMessage(`{"profiles":[{"id":"p1"},{"id":"p2","model":"m"}]}`), env)
	if len(settings.Profiles) != 1 || settings.Profiles[0].ID != "p2" {
		t.Fatalf("profiles = %+v", settings.Profiles)
	}
	// Non-array documents produce an empty list, never nil.
	empty := NormalizeSettings(json.RawMessage(`{"profiles":"nope"}`), env)
	if empty.Profiles == nil || len(empty.Profiles) != 0 {
		t.Fatalf("profiles = %#v, want an empty array", empty.Profiles)
	}
	payload, err := json.Marshal(empty)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(payload), `"profiles":[]`) {
		t.Fatalf("empty document = %s", payload)
	}
}

func TestNormalizeProfileDefaultsAndOrder(t *testing.T) {
	env := testEnv()
	document := `{"profiles":[
		{"id":"b","model":"m"},
		{"id":"a","model":"m","name":"  ","apiBase":"   ","sendMetadata":"x","assistantWebSearchEnabled":"x",
		 "responseFormatMode":"bogus","apiSurface":"bogus","createdAt":"","updatedAt":"  "}
	]}`
	settings := NormalizeSettings(json.RawMessage(document), env)
	if len(settings.Profiles) != 2 {
		t.Fatalf("profiles = %+v", settings.Profiles)
	}
	// Order is preserved, never sorted.
	if settings.Profiles[0].ID != "b" || settings.Profiles[1].ID != "a" {
		t.Fatalf("profile order changed: %+v", settings.Profiles)
	}
	first := settings.Profiles[0]
	if first.Name != "b" {
		t.Fatalf("name = %q, want the id fallback", first.Name)
	}
	if first.APIBase != env.APIBase {
		t.Fatalf("apiBase = %q, want the env fallback", first.APIBase)
	}
	if first.SendMetadata.Null || !first.SendMetadata.Value {
		t.Fatalf("sendMetadata = %+v, want true", first.SendMetadata)
	}
	if first.AssistantWebSearchEnabled.Null || first.AssistantWebSearchEnabled.Value {
		t.Fatalf("assistantWebSearchEnabled = %+v, want false", first.AssistantWebSearchEnabled)
	}
	if first.ResponseFormatMode != ResponseFormatJSONSchema || first.APISurface != APISurfaceChatCompletions {
		t.Fatalf("enum fallbacks = %s/%s", first.ResponseFormatMode, first.APISurface)
	}
	if first.CreatedAt == "" || first.UpdatedAt == "" {
		t.Fatalf("timestamps must be generated: %+v", first)
	}
	// A provided timestamp is preserved verbatim.
	kept := NormalizeSettings(json.RawMessage(`{"profiles":[{"id":"p","model":"m","createdAt":"2020-01-02T03:04:05.000Z","updatedAt":"2020-01-02T03:04:06.000Z"}]}`), env)
	if kept.Profiles[0].CreatedAt != "2020-01-02T03:04:05.000Z" || kept.Profiles[0].UpdatedAt != "2020-01-02T03:04:06.000Z" {
		t.Fatalf("timestamps = %+v", kept.Profiles[0])
	}
}

func TestNormalizeProfileNumbers(t *testing.T) {
	env := testEnv()
	cases := []struct {
		document string
		timeout  float64
		temp     float64
	}{
		{document: `{"id":"p","model":"m"}`, timeout: env.TimeoutMs, temp: env.Temperature},
		{document: `{"id":"p","model":"m","timeoutMs":null,"temperature":null}`, timeout: env.TimeoutMs, temp: 0},
		{document: `{"id":"p","model":"m","timeoutMs":true,"temperature":5}`, timeout: 1, temp: 2},
		{document: `{"id":"p","model":"m","timeoutMs":"5000","temperature":-1}`, timeout: 5000, temp: 0},
		{document: `{"id":"p","model":"m","timeoutMs":[],"temperature":{}}`, timeout: env.TimeoutMs, temp: env.Temperature},
		{document: `{"id":"p","model":"m","timeoutMs":1500.9,"temperature":0.5}`, timeout: 1500, temp: 0.5},
	}
	for _, tc := range cases {
		profile, ok := NormalizeProfile(json.RawMessage(tc.document), env)
		if !ok {
			t.Fatalf("%s was filtered", tc.document)
		}
		if profile.TimeoutMs != tc.timeout {
			t.Fatalf("%s timeoutMs = %v, want %v", tc.document, profile.TimeoutMs, tc.timeout)
		}
		if profile.Temperature != tc.temp {
			t.Fatalf("%s temperature = %v, want %v", tc.document, profile.Temperature, tc.temp)
		}
	}
}

func TestNormalizeStringLists(t *testing.T) {
	env := testEnv()
	profile, ok := NormalizeProfile(json.RawMessage(
		`{"id":"p","model":"m","fallbackModels":[" a ","","b","a",5],"rerankFallbackModels":"nope"}`), env)
	if !ok {
		t.Fatal("profile was filtered")
	}
	if strings.Join(profile.FallbackModels, ",") != "a,b" {
		t.Fatalf("fallbackModels = %v, want stable de-duplication", profile.FallbackModels)
	}
	if len(profile.RerankFallbackModels) != 0 || profile.RerankFallbackModels == nil {
		t.Fatalf("rerankFallbackModels = %#v, want an empty array", profile.RerankFallbackModels)
	}
}

func TestBuildCreateProfileFallbacks(t *testing.T) {
	env := testEnv()
	service := testService(env)
	service.securityFn = plaintextSecurity()
	ctx := context.Background()
	identity := profileIdentity{ID: "id-1", CreatedAt: "2026-01-01T00:00:00.000Z", UpdatedAt: "2026-01-01T00:00:00.000Z"}

	input, err := parseProfileInput(json.RawMessage(`{"name":" g ","apiBase":" http://localhost:4001 ","model":" m "}`), true)
	if err != nil {
		t.Fatal(err)
	}
	profile, err := service.buildProfileFromInput(ctx, nil, identity, profileDefaultsFor(env), input)
	if err != nil {
		t.Fatal(err)
	}
	if profile.Name != "g" || profile.APIBase != "http://localhost:4001" || profile.Model != "m" {
		t.Fatalf("trim failure: %+v", profile)
	}
	if profile.TimeoutMs != env.TimeoutMs || profile.TopP != env.TopP || profile.MaxOutputTokens != env.MaxOutputTokens || profile.MaxRetries != env.MaxRetries {
		t.Fatalf("env numeric fallbacks: %+v", profile)
	}
	// Create never inherits the environment embedding model or fallback models.
	if profile.EmbeddingModel != nil {
		t.Fatalf("embeddingModel = %v, want absent", profile.EmbeddingModel)
	}
	if profile.RerankModel != nil {
		t.Fatalf("rerankModel = %v, want absent", profile.RerankModel)
	}
	if len(profile.FallbackModels) != 0 || profile.FallbackModels == nil {
		t.Fatalf("fallbackModels = %#v, want []", profile.FallbackModels)
	}
	if profile.APIKey != nil {
		t.Fatalf("apiKey = %+v, want absent", profile.APIKey)
	}
	if profile.AssistantWebSearchEnabled.Null || profile.AssistantWebSearchEnabled.Value {
		t.Fatalf("assistantWebSearchEnabled = %+v", profile.AssistantWebSearchEnabled)
	}
	if profile.SendMetadata.Null || !profile.SendMetadata.Value {
		t.Fatalf("sendMetadata = %+v", profile.SendMetadata)
	}
	if !profile.Enabled {
		t.Fatal("enabled must default to true")
	}

	// A missing model is a business 400, not an env backfill.
	missingModel, err := parseProfileInput(json.RawMessage(`{"name":"g","apiBase":"http://localhost:4001"}`), true)
	if err != nil {
		t.Fatal(err)
	}
	_, err = service.buildProfileFromInput(ctx, nil, identity, profileDefaultsFor(env), missingModel)
	if got := messageOf(t, err); got != "apiBase and model are required" {
		t.Fatalf("missing model message = %q", got)
	}

	blankName, err := parseProfileInput(json.RawMessage(`{"name":"   ","apiBase":"http://localhost:4001","model":"m"}`), true)
	if err != nil {
		t.Fatal(err)
	}
	_, err = service.buildProfileFromInput(ctx, nil, identity, profileDefaultsFor(env), blankName)
	if got := messageOf(t, err); got != "name is required" {
		t.Fatalf("blank name message = %q", got)
	}

	// Explicit nulls use Number(null) === 0 semantics, not Go zero values.
	nulls, err := parseProfileInput(json.RawMessage(
		`{"name":"g","apiBase":"http://localhost:4001","model":"m","timeoutMs":null,"temperature":null,"topP":null,"maxOutputTokens":null,"maxRetries":null,"enabled":null,"apiSurface":null,"responseFormatMode":null}`), true)
	if err != nil {
		t.Fatal(err)
	}
	nullProfile, err := service.buildProfileFromInput(ctx, nil, identity, profileDefaultsFor(env), nulls)
	if err != nil {
		t.Fatal(err)
	}
	if nullProfile.TimeoutMs != env.TimeoutMs || nullProfile.MaxOutputTokens != env.MaxOutputTokens || nullProfile.MaxRetries != env.MaxRetries {
		t.Fatalf("null positive ints must fall back: %+v", nullProfile)
	}
	if nullProfile.Temperature != 0 || nullProfile.TopP != 0 {
		t.Fatalf("null temperature/topP must be 0: %+v", nullProfile)
	}
	if !nullProfile.Enabled {
		t.Fatal("null enabled must inherit the default true")
	}
	if nullProfile.APISurface != APISurfaceChatCompletions || nullProfile.ResponseFormatMode != ResponseFormatJSONSchema {
		t.Fatalf("null enums must fall back to the defaults: %+v", nullProfile)
	}
}

func TestBuildUpdateProfileInheritanceAndClearing(t *testing.T) {
	env := testEnv()
	service := testService(env)
	service.securityFn = plaintextSecurity()
	ctx := context.Background()

	base := StoredProfile{
		ID:                        "p1",
		Name:                      "existing",
		APIBase:                   "http://existing:1/v1",
		APIKey:                    newPlaintextSecret("old-key"),
		Model:                     "m-existing",
		EmbeddingModel:            stringPointer("e-existing"),
		RerankModel:               stringPointer("r-existing"),
		RerankFallbackModels:      []string{"r1"},
		AssistantModel:            stringPointer("a-existing"),
		AssistantWebSearchEnabled: boolNullable(true),
		TimeoutMs:                 1111,
		Temperature:               1.5,
		TopP:                      0.5,
		MaxOutputTokens:           111,
		MaxRetries:                4,
		FallbackModels:            []string{"f1"},
		SendMetadata:              boolNullable(false),
		ResponseFormatMode:        ResponseFormatJSONObject,
		APISurface:                APISurfaceResponses,
		Enabled:                   true,
		CreatedAt:                 "2020-01-01T00:00:00.000Z",
		UpdatedAt:                 "2020-01-01T00:00:00.000Z",
	}
	identity := profileIdentity{ID: "p1", CreatedAt: base.CreatedAt, UpdatedAt: "2026-01-01T00:00:00.000Z"}

	// Null and blank values inherit the existing scalars.
	input, err := parseProfileInput(json.RawMessage(`{"name":null,"apiBase":"   ","model":null}`), false)
	if err != nil {
		t.Fatal(err)
	}
	next, err := service.buildProfileFromInput(ctx, &base, identity, updateDefaultsFor(base), input)
	if err != nil {
		t.Fatal(err)
	}
	if next.Name != base.Name || next.APIBase != base.APIBase || next.Model != base.Model {
		t.Fatalf("nullish scalars must inherit: %+v", next)
	}
	if next.CreatedAt != base.CreatedAt || next.UpdatedAt != identity.UpdatedAt {
		t.Fatalf("identity fields = %s/%s", next.CreatedAt, next.UpdatedAt)
	}
	if next.TimeoutMs != base.TimeoutMs || next.Temperature != base.Temperature || next.TopP != base.TopP {
		t.Fatalf("absent numerics must inherit: %+v", next)
	}
	// An absent nullable boolean keeps the existing value.
	if next.SendMetadata.Null || next.SendMetadata.Value {
		t.Fatalf("sendMetadata = %+v, want false", next.SendMetadata)
	}

	// Explicit null clears the optional models and the apiKey; the arrays keep
	// the existing value because null is not an array.
	clearing, err := parseProfileInput(json.RawMessage(
		`{"apiKey":null,"embeddingModel":null,"rerankModel":null,"assistantModel":null,"fallbackModels":null,"rerankFallbackModels":null}`), false)
	if err != nil {
		t.Fatal(err)
	}
	cleared, err := service.buildProfileFromInput(ctx, &base, identity, updateDefaultsFor(base), clearing)
	if err != nil {
		t.Fatal(err)
	}
	if cleared.EmbeddingModel != nil || cleared.RerankModel != nil || cleared.AssistantModel != nil {
		t.Fatalf("null optional models must clear: %+v", cleared)
	}
	if cleared.APIKey == nil || cleared.APIKey.Kind() != SecretNull {
		t.Fatalf("apiKey = %+v, want an explicit null", cleared.APIKey)
	}
	if strings.Join(cleared.FallbackModels, ",") != "f1" || strings.Join(cleared.RerankFallbackModels, ",") != "r1" {
		t.Fatalf("null arrays must keep the existing value: %+v", cleared)
	}

	// An explicit empty array clears the list.
	emptied, err := parseProfileInput(json.RawMessage(`{"fallbackModels":[]}`), false)
	if err != nil {
		t.Fatal(err)
	}
	emptyProfile, err := service.buildProfileFromInput(ctx, &base, identity, updateDefaultsFor(base), emptied)
	if err != nil {
		t.Fatal(err)
	}
	if len(emptyProfile.FallbackModels) != 0 || emptyProfile.FallbackModels == nil {
		t.Fatalf("empty array must clear: %#v", emptyProfile.FallbackModels)
	}

	// An omitted apiKey keeps the stored value byte-for-byte.
	untouched, err := parseProfileInput(json.RawMessage(`{}`), false)
	if err != nil {
		t.Fatal(err)
	}
	kept, err := service.buildProfileFromInput(ctx, &base, identity, updateDefaultsFor(base), untouched)
	if err != nil {
		t.Fatal(err)
	}
	if kept.APIKey == nil || kept.APIKey.Kind() != SecretPlaintext {
		t.Fatalf("apiKey = %+v, want the existing plaintext", kept.APIKey)
	}
	if value, ok := kept.APIKey.Plaintext(); !ok || value != "old-key" {
		t.Fatalf("apiKey value = %q ok=%v", value, ok)
	}

	// A standalone "Bearer" clears the key; a real key is stripped and encoded.
	bearer, err := parseProfileInput(json.RawMessage(`{"apiKey":"Bearer"}`), false)
	if err != nil {
		t.Fatal(err)
	}
	bearerProfile, err := service.buildProfileFromInput(ctx, &base, identity, updateDefaultsFor(base), bearer)
	if err != nil {
		t.Fatal(err)
	}
	if bearerProfile.APIKey == nil || bearerProfile.APIKey.Kind() != SecretNull {
		t.Fatalf("apiKey = %+v, want null", bearerProfile.APIKey)
	}
	realKey, err := parseProfileInput(json.RawMessage(`{"apiKey":"Bearer sk-new"}`), false)
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := service.buildProfileFromInput(ctx, &base, identity, updateDefaultsFor(base), realKey)
	if err != nil {
		t.Fatal(err)
	}
	if value, ok := encoded.APIKey.Plaintext(); !ok || value != "sk-new" {
		t.Fatalf("apiKey = %q ok=%v, want sk-new", value, ok)
	}

	// An explicit null enum falls back to the default instead of inheriting a
	// non-default stored value.
	nullEnum, err := parseProfileInput(json.RawMessage(`{"apiSurface":null,"responseFormatMode":null}`), false)
	if err != nil {
		t.Fatal(err)
	}
	enumProfile, err := service.buildProfileFromInput(ctx, &base, identity, updateDefaultsFor(base), nullEnum)
	if err != nil {
		t.Fatal(err)
	}
	if enumProfile.APISurface != APISurfaceChatCompletions || enumProfile.ResponseFormatMode != ResponseFormatJSONSchema {
		t.Fatalf("null enums = %s/%s, want the defaults", enumProfile.APISurface, enumProfile.ResponseFormatMode)
	}

	// Explicit null numerics fall back to the per-operation default (which for
	// an update is the existing value).
	nullNumbers, err := parseProfileInput(json.RawMessage(`{"timeoutMs":null,"temperature":null,"topP":null}`), false)
	if err != nil {
		t.Fatal(err)
	}
	numberProfile, err := service.buildProfileFromInput(ctx, &base, identity, updateDefaultsFor(base), nullNumbers)
	if err != nil {
		t.Fatal(err)
	}
	if numberProfile.TimeoutMs != base.TimeoutMs {
		t.Fatalf("timeoutMs = %v, want %v", numberProfile.TimeoutMs, base.TimeoutMs)
	}
	if numberProfile.Temperature != 0 || numberProfile.TopP != 0 {
		t.Fatalf("temperature/topP = %v/%v, want 0/0", numberProfile.Temperature, numberProfile.TopP)
	}

	// A disabled flag from the request wins over the existing profile.
	disabled, err := parseProfileInput(json.RawMessage(`{"enabled":false}`), false)
	if err != nil {
		t.Fatal(err)
	}
	disabledProfile, err := service.buildProfileFromInput(ctx, &base, identity, updateDefaultsFor(base), disabled)
	if err != nil {
		t.Fatal(err)
	}
	if disabledProfile.Enabled {
		t.Fatal("enabled must become false")
	}
}

func TestBuildNullableBooleansImmediateVersusNextList(t *testing.T) {
	env := testEnv()
	service := testService(env)
	service.securityFn = plaintextSecurity()
	ctx := context.Background()
	identity := profileIdentity{ID: "p1", CreatedAt: "2026-01-01T00:00:00.000Z", UpdatedAt: "2026-01-01T00:00:00.000Z"}

	input, err := parseProfileInput(json.RawMessage(
		`{"name":"g","apiBase":"http://localhost:4001","model":"m","assistantWebSearchEnabled":null,"sendMetadata":null}`), true)
	if err != nil {
		t.Fatal(err)
	}
	profile, err := service.buildProfileFromInput(ctx, nil, identity, profileDefaultsFor(env), input)
	if err != nil {
		t.Fatal(err)
	}
	// The immediate response keeps the explicit nulls.
	immediate, err := json.Marshal(PublicProfileOf(profile, false))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(immediate), `"assistantWebSearchEnabled":null`) || !strings.Contains(string(immediate), `"sendMetadata":null`) {
		t.Fatalf("immediate response = %s, want null flags", immediate)
	}
	// The next read normalizes null back to false/true.
	persisted := service.persistedView(StoredSettings{Profiles: []StoredProfile{profile}, EmbeddingMode: EmbeddingModeFollowCompletion, RerankMode: RerankModeFollowCompletion})
	nextList, err := json.Marshal(PublicSettingsOf(persisted, service.hasAPIKey))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(nextList), `"assistantWebSearchEnabled":false`) || !strings.Contains(string(nextList), `"sendMetadata":true`) {
		t.Fatalf("next list = %s, want normalized flags", nextList)
	}
}

func TestRemoveProfilesByIDRemovesEveryMatch(t *testing.T) {
	profiles := []StoredProfile{
		{ID: "a", Model: "m"},
		{ID: "dup", Model: "m2"},
		{ID: "b", Model: "m"},
		{ID: "dup", Model: "m3"},
	}
	next := removeProfilesByID(profiles, "dup")
	if len(next) != 2 || next[0].ID != "a" || next[1].ID != "b" {
		t.Fatalf("removeProfilesByID = %+v", next)
	}
	if len(removeProfilesByID(profiles, "missing")) != len(profiles) {
		t.Fatal("a missing id must not change the list")
	}
	// Update only ever touches the first match.
	found, ok := findProfile(profiles, "dup")
	if !ok || found.Model != "m2" {
		t.Fatalf("findProfile = %+v ok=%v, want the first match", found, ok)
	}
}

func TestNewUUIDv4Shape(t *testing.T) {
	pattern := regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)
	seen := make(map[string]bool, 64)
	for index := 0; index < 64; index++ {
		id, err := newUUIDv4()
		if err != nil {
			t.Fatal(err)
		}
		if !pattern.MatchString(id) {
			t.Fatalf("id %q is not a v4 uuid", id)
		}
		if seen[id] {
			t.Fatalf("duplicate id %q", id)
		}
		seen[id] = true
	}
}

func TestNormalizeOpenAiApiBase(t *testing.T) {
	cases := map[string]string{
		"http://host:1/v1/chat/completions": "http://host:1",
		"http://host:1/chat/completions":    "http://host:1",
		"http://host:1/v1/embeddings":       "http://host:1",
		"http://host:1/embeddings/":         "http://host:1",
		"http://host:1/v1/models":           "http://host:1",
		"http://host:1/models":              "http://host:1",
		"http://host:1/v1/responses":        "http://host:1",
		"http://host:1/responses":           "http://host:1",
		"HTTP://host:1/V1/Chat/Completions": "HTTP://host:1",
		"http://host:1/v1/":                 "http://host:1",
		"http://host:1/v1":                  "http://host:1",
		"http://host:1/some/path":           "http://host:1/some/path",
		"  http://host:1/v1//  ":            "http://host:1",
		"":                                  "",
	}
	for input, want := range cases {
		if got := normalizeOpenAiApiBase(input); got != want {
			t.Fatalf("normalizeOpenAiApiBase(%q) = %q, want %q", input, got, want)
		}
	}
}

func TestGovernanceProtectionMessages(t *testing.T) {
	service := testService(testEnv())
	service.governanceFn = func(context.Context) (governanceProjection, error) {
		return governanceProjection{Enabled: json.RawMessage(`true`), TargetProfileID: json.RawMessage(`"target"`)}, nil
	}
	ctx := context.Background()

	err := service.assertProfileUpdateAllowed(ctx, "target", "http://a:1", "http://a:1", false)
	if got := messageOf(t, err); got != "Disable LiteLLM managed governance or choose a different target profile before disabling this gateway profile" {
		t.Fatalf("disable message = %q", got)
	}
	err = service.assertProfileUpdateAllowed(ctx, "target", "http://a:1", "http://b:2", true)
	if got := messageOf(t, err); got != "Disable LiteLLM managed governance or choose a different target profile before changing this gateway profile apiBase" {
		t.Fatalf("apiBase message = %q", got)
	}
	if err := service.assertProfileUpdateAllowed(ctx, "target", "http://a:1", "http://a:1/v1/chat/completions", true); err != nil {
		t.Fatalf("same base with an endpoint suffix must be allowed: %v", err)
	}
	if err := service.assertProfileUpdateAllowed(ctx, "other", "http://a:1", "http://b:2", false); err != nil {
		t.Fatalf("a non-target profile must not be protected: %v", err)
	}
	err = service.assertProfileDeletionAllowed(ctx, "target")
	if got := messageOf(t, err); got != "Disable LiteLLM managed governance or choose a different target profile before deleting this gateway profile" {
		t.Fatalf("delete message = %q", got)
	}
	if err := service.assertProfileDeletionAllowed(ctx, "other"); err != nil {
		t.Fatalf("a non-target delete must be allowed: %v", err)
	}

	// A non-boolean enabled value is false, so nothing is protected.
	service.governanceFn = func(context.Context) (governanceProjection, error) {
		return governanceProjection{Enabled: json.RawMessage(`"true"`), TargetProfileID: json.RawMessage(`"target"`)}, nil
	}
	if err := service.assertProfileDeletionAllowed(ctx, "target"); err != nil {
		t.Fatalf("a string enabled value must not enable protection: %v", err)
	}
}

func TestWithProfilesLockFailsClosed(t *testing.T) {
	service := testService(testEnv())
	called := false
	err := service.withProfilesLock(context.Background(), func(context.Context) error {
		called = true
		return nil
	})
	if !errors.Is(err, errNoDatabase) {
		t.Fatalf("error = %v, want errNoDatabase", err)
	}
	if called {
		t.Fatal("the write callback ran without a lock pool")
	}

	service.lockFn = func(context.Context, func(context.Context) error) error {
		return errLockUnavailable
	}
	called = false
	err = service.withProfilesLock(context.Background(), func(context.Context) error {
		called = true
		return nil
	})
	if !errors.Is(err, errLockUnavailable) {
		t.Fatalf("error = %v, want errLockUnavailable", err)
	}
	if called {
		t.Fatal("a failed lock acquisition must never run the write callback")
	}
	// The error maps to the exact 503 contract on both sides.
	var coded *httpError
	if errors.As(err, &coded) {
		t.Fatalf("lock errors are not httpError: %v", coded)
	}
}

func TestWithProfilesLockPropagatesCallbackError(t *testing.T) {
	service := testService(testEnv())
	sentinel := errors.New("write failed")
	service.lockFn = func(ctx context.Context, fn func(context.Context) error) error {
		return fn(ctx)
	}
	if err := service.withProfilesLock(context.Background(), func(context.Context) error {
		return sentinel
	}); !errors.Is(err, sentinel) {
		t.Fatalf("error = %v, want the callback error", err)
	}
}

func TestWithProfilesLockSurvivesRequestCancellation(t *testing.T) {
	service := testService(testEnv())
	ctx, cancel := context.WithCancel(context.Background())
	observed := error(nil)
	service.lockFn = func(lockCtx context.Context, fn func(context.Context) error) error {
		// The lock is held with a live context; the request is cancelled while
		// the callback runs. The callback still observes the cancellation and
		// the release path (covered against real MySQL by the smoke lock
		// evidence) must not be skipped.
		cancel()
		observed = lockCtx.Err()
		return fn(lockCtx)
	}
	callbackRan := false
	err := service.withProfilesLock(ctx, func(callbackCtx context.Context) error {
		callbackRan = true
		return callbackCtx.Err()
	})
	if !callbackRan {
		t.Fatal("the callback must still run while the lock is held")
	}
	if !errors.Is(observed, context.Canceled) {
		t.Fatalf("lock context error = %v, want context.Canceled", observed)
	}
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("error = %v, want context.Canceled", err)
	}
}

func TestProfileAuditMetadataFields(t *testing.T) {
	profile := StoredProfile{
		ID:                        "p1",
		Name:                      "gateway",
		APIBase:                   "http://a:1",
		Model:                     "m",
		AssistantModel:            nil,
		RerankModel:               nil,
		RerankFallbackModels:      []string{"r1", "r2"},
		AssistantWebSearchEnabled: nullNullable(),
		SendMetadata:              nullNullable(),
		ResponseFormatMode:        ResponseFormatJSONObject,
		APISurface:                APISurfaceResponses,
		Enabled:                   false,
		CreatedAt:                 "2026-01-01T00:00:00.000Z",
		UpdatedAt:                 "2026-01-01T00:00:00.000Z",
	}
	payload, err := json.Marshal(profileAuditMetadata(profile, true))
	if err != nil {
		t.Fatal(err)
	}
	want := `{"id":"p1","name":"gateway","apiBase":"http://a:1","model":"m",` +
		`"assistantWebSearchEnabled":null,"rerankFallbackModels":["r1","r2"],"enabled":false,` +
		`"hasApiKey":true,"sendMetadata":null,"responseFormatMode":"json_object","apiSurface":"responses"}`
	if string(payload) != want {
		t.Fatalf("metadata =\n%s\nwant\n%s", payload, want)
	}
	// The metadata never carries the apiKey, the ciphertext or the excluded
	// fields.
	for _, forbidden := range []string{"apiKey", "embeddingModel", "timeoutMs", "temperature", "topP", "maxOutputTokens", "maxRetries", "fallbackModels"} {
		if strings.Contains(string(payload), `"`+forbidden+`"`) {
			t.Fatalf("metadata must not contain %s: %s", forbidden, payload)
		}
	}
	// Optional models are omitted when absent but present when set.
	withModels := StoredProfile{ID: "p1", Name: "n", APIBase: "http://a:1", Model: "m", AssistantModel: stringPointer("a"), RerankModel: stringPointer("r"), RerankFallbackModels: []string{}}
	payload, err = json.Marshal(profileAuditMetadata(withModels, false))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(payload), `"assistantModel":"a"`) || !strings.Contains(string(payload), `"rerankModel":"r"`) {
		t.Fatalf("metadata = %s, want both optional models", payload)
	}

	deletePayload, err := json.Marshal(gatewayIDMetadata{ID: "p1"})
	if err != nil {
		t.Fatal(err)
	}
	if string(deletePayload) != `{"id":"p1"}` {
		t.Fatalf("delete metadata = %s", deletePayload)
	}
	active := ""
	activatePayload, err := json.Marshal(gatewayActiveIDMetadata{ActiveID: &active})
	if err != nil {
		t.Fatal(err)
	}
	if string(activatePayload) != `{"activeId":""}` {
		t.Fatalf("activate metadata = %s", activatePayload)
	}
	activateNull, err := json.Marshal(gatewayActiveIDMetadata{ActiveID: nil})
	if err != nil {
		t.Fatal(err)
	}
	if string(activateNull) != `{"activeId":null}` {
		t.Fatalf("activate metadata = %s", activateNull)
	}
	embedding, err := json.Marshal(gatewayEmbeddingActiveIDMetadata{EmbeddingActiveID: stringPointer("e")})
	if err != nil {
		t.Fatal(err)
	}
	if string(embedding) != `{"embeddingActiveId":"e"}` {
		t.Fatalf("embedding metadata = %s", embedding)
	}
	rerank, err := json.Marshal(gatewayRerankActiveIDMetadata{RerankActiveID: nil})
	if err != nil {
		t.Fatal(err)
	}
	if string(rerank) != `{"rerankActiveId":null}` {
		t.Fatalf("rerank metadata = %s", rerank)
	}
}

func TestAuditOutboxPayloadShape(t *testing.T) {
	actor := "user-1"
	payload, err := json.Marshal(auditOutboxPayload{
		OrgID:     "org-1",
		ActorID:   &actor,
		Resource:  "system_settings",
		Action:    string(AuditActionCreate),
		Metadata:  json.RawMessage(`{"id":"p1"}`),
		IPAddress: nil,
		CreatedAt: "2026-01-01T00:00:00.000Z",
	})
	if err != nil {
		t.Fatal(err)
	}
	want := `{"orgId":"org-1","actorId":"user-1","resource":"system_settings","action":"llm_gateway_create",` +
		`"metadata":{"id":"p1"},"ipAddress":null,"createdAt":"2026-01-01T00:00:00.000Z"}`
	if string(payload) != want {
		t.Fatalf("outbox payload =\n%s\nwant\n%s", payload, want)
	}
	machineOutbox, err := json.Marshal(auditOutboxPayload{OrgID: "org-1", ActorID: nullableActorID("machine:abc"), Action: string(AuditActionDelete)})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(machineOutbox), `"actorId":null`) {
		t.Fatalf("machine actor must be null: %s", machineOutbox)
	}
}

func TestEncodeMetadataFallsBackToEmptyObject(t *testing.T) {
	if got := string(encodeMetadata(json.Marshal(struct {
		ID string `json:"id"`
	}{ID: "p1"}))); got != `{"id":"p1"}` {
		t.Fatalf("encodeMetadata = %s", got)
	}
}

// stringPointer is a small helper for the test fixtures.
func stringPointer(value string) *string {
	return &value
}

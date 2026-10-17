package modelaccesssettings

import (
	"strings"
	"testing"
)

// TestNewConfigFromEnvDefaults pins the NestJS schema defaults.
func TestNewConfigFromEnvDefaults(t *testing.T) {
	cfg, err := NewConfigFromEnv(EnvInput{DatabaseURL: "mysql://root:secret@127.0.0.1:3306/app"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cfg.ModelServiceEnabled {
		t.Fatalf("MODEL_SERVICE_ENABLED defaults to false")
	}
	if cfg.ModelServiceTimeoutMs != 15_000 || cfg.ModelServiceMaxRetries != 2 {
		t.Fatalf("defaults = %+v", cfg)
	}
	if cfg.IsProduction {
		t.Fatalf("an unset NODE_ENV is not production")
	}
	if cfg.DatabaseURL == "" {
		t.Fatalf("the DSN must be carried for the lock session")
	}
}

// TestNewConfigFromEnvParsesValues pins the accepted vocabulary.
func TestNewConfigFromEnvParsesValues(t *testing.T) {
	cfg, err := NewConfigFromEnv(EnvInput{
		ModelServiceEnabledRaw:       "YES",
		ModelServiceBaseURLRaw:       " http://model-service:8090 ",
		ModelServiceInternalTokenRaw: " tok ",
		ModelServiceTimeoutMsRaw:     " 12000 ",
		ModelServiceMaxRetriesRaw:    "0",
		NodeEnvRaw:                   "production",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !cfg.ModelServiceEnabled || !cfg.IsProduction {
		t.Fatalf("parsed = %+v", cfg)
	}
	if cfg.ModelServiceTimeoutMs != 12_000 || cfg.ModelServiceMaxRetries != 0 {
		t.Fatalf("numbers = %+v", cfg)
	}
	// Raw values are preserved: trimming happens at the read site, exactly like
	// the NestJS service.
	if cfg.ModelServiceBaseURL != " http://model-service:8090 " {
		t.Fatalf("baseUrl must stay raw, got %q", cfg.ModelServiceBaseURL)
	}
	if cfg.ModelServiceInternalToken != " tok " {
		t.Fatalf("token must stay raw, got %q", cfg.ModelServiceInternalToken)
	}
}

// TestNewConfigFromEnvRejectsInvalidValues pins the startup failures.
func TestNewConfigFromEnvRejectsInvalidValues(t *testing.T) {
	cases := []struct {
		name    string
		input   EnvInput
		message string
	}{
		{name: "invalid boolean", input: EnvInput{ModelServiceEnabledRaw: "maybe"}, message: "MODEL_SERVICE_ENABLED"},
		{name: "numeric boolean", input: EnvInput{ModelServiceEnabledRaw: "2"}, message: "MODEL_SERVICE_ENABLED"},
		{name: "timeout not a number", input: EnvInput{ModelServiceTimeoutMsRaw: "abc"}, message: "MODEL_SERVICE_TIMEOUT_MS"},
		{name: "timeout float", input: EnvInput{ModelServiceTimeoutMsRaw: "10.5"}, message: "MODEL_SERVICE_TIMEOUT_MS"},
		{name: "timeout zero", input: EnvInput{ModelServiceTimeoutMsRaw: "0"}, message: "MODEL_SERVICE_TIMEOUT_MS"},
		{name: "retries negative", input: EnvInput{ModelServiceMaxRetriesRaw: "-1"}, message: "MODEL_SERVICE_MAX_RETRIES"},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			_, err := NewConfigFromEnv(testCase.input)
			if err == nil {
				t.Fatalf("expected an error")
			}
			if !strings.Contains(err.Error(), testCase.message) {
				t.Fatalf("error = %q, want it to mention %s", err.Error(), testCase.message)
			}
		})
	}
}

// TestNewConfigFromEnvBlankValuesAreUnset pins the NestJS empty-string rule.
func TestNewConfigFromEnvBlankValuesAreUnset(t *testing.T) {
	cfg, err := NewConfigFromEnv(EnvInput{
		ModelServiceEnabledRaw:        "   ",
		ModelServiceTimeoutMsRaw:      "",
		ModelServiceMaxRetriesRaw:     "  ",
		LiteLLMConfigInternalTokenRaw: "   ",
	})
	if err != nil {
		t.Fatalf("blank values must not be configuration errors: %v", err)
	}
	if cfg.ModelServiceEnabled || cfg.ModelServiceTimeoutMs != 15_000 || cfg.ModelServiceMaxRetries != 2 {
		t.Fatalf("blank values must fall back to the defaults: %+v", cfg)
	}
	if jsTrimSpace(cfg.LiteLLMConfigInternalToken) != "" {
		t.Fatalf("a blank internal token counts as not configured")
	}
}

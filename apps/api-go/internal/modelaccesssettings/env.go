package modelaccesssettings

import (
	"errors"
	"strings"
)

// Default model service environment values, mirroring the NestJS apiEnvSchema
// defaults exactly.
const (
	defaultModelServiceTimeoutMs  = 15_000
	defaultModelServiceMaxRetries = 2
)

// EnvInput carries the RAW environment values this batch consumes.
//
// The values are stored verbatim by the config package and interpreted here,
// because the NestJS env schema applies JavaScript semantics (envBoolean,
// Number coercion) that this package already implements for the stored rows. The
// interpretation only happens in go mode, so a legacy deployment keeps its exact
// previous startup behaviour.
type EnvInput struct {
	// DatabaseURL is DATABASE_URL. It is used by the dedicated lock session only.
	DatabaseURL string
	// ModelServiceEnabledRaw is MODEL_SERVICE_ENABLED.
	ModelServiceEnabledRaw string
	// ModelServiceBaseURLRaw is MODEL_SERVICE_BASE_URL.
	ModelServiceBaseURLRaw string
	// ModelServiceInternalTokenRaw is MODEL_SERVICE_INTERNAL_TOKEN.
	ModelServiceInternalTokenRaw string
	// ModelServiceTimeoutMsRaw is MODEL_SERVICE_TIMEOUT_MS.
	ModelServiceTimeoutMsRaw string
	// ModelServiceMaxRetriesRaw is MODEL_SERVICE_MAX_RETRIES.
	ModelServiceMaxRetriesRaw string
	// LiteLLMConfigInternalTokenRaw is LITELLM_CONFIG_INTERNAL_TOKEN.
	LiteLLMConfigInternalTokenRaw string
	// SettingsEncryptionKeyRaw is SYSTEM_SETTINGS_ENCRYPTION_KEY, untrimmed.
	SettingsEncryptionKeyRaw string
	// NodeEnvRaw is NODE_ENV. Production is an exact match.
	NodeEnvRaw string
}

// NewConfigFromEnv resolves EnvInput into a Config.
//
// It fails only on values the NestJS schema would refuse to start with
// (MODEL_SERVICE_ENABLED outside the boolean vocabulary and a non-integer or
// out-of-range timeout/retry count). A missing LITELLM_CONFIG_INTERNAL_TOKEN and a
// missing encryption key are NOT errors: both have runtime semantics (403 and the
// fail-closed production policy) and must never block startup.
func NewConfigFromEnv(input EnvInput) (Config, error) {
	var problems []string

	enabled := false
	if value, set, invalid := jsEnvBoolean(input.ModelServiceEnabledRaw); invalid {
		problems = append(problems, "MODEL_SERVICE_ENABLED must be one of true|false|1|0|yes|y|no|n|on|off")
	} else if set {
		enabled = value
	}

	timeoutMs := defaultModelServiceTimeoutMs
	if value, set, invalid := asPositiveIntEnv(input.ModelServiceTimeoutMsRaw); invalid {
		problems = append(problems, "MODEL_SERVICE_TIMEOUT_MS must be a positive integer")
	} else if set {
		timeoutMs = value
	}

	maxRetries := defaultModelServiceMaxRetries
	if value, set, invalid := asNonNegativeIntEnv(input.ModelServiceMaxRetriesRaw); invalid {
		problems = append(problems, "MODEL_SERVICE_MAX_RETRIES must be a non-negative integer")
	} else if set {
		maxRetries = value
	}

	if len(problems) > 0 {
		return Config{}, errors.New(strings.Join(problems, "; "))
	}

	return Config{
		DatabaseURL:                input.DatabaseURL,
		ModelServiceEnabled:        enabled,
		ModelServiceBaseURL:        input.ModelServiceBaseURLRaw,
		ModelServiceInternalToken:  input.ModelServiceInternalTokenRaw,
		ModelServiceTimeoutMs:      timeoutMs,
		ModelServiceMaxRetries:     maxRetries,
		LiteLLMConfigInternalToken: input.LiteLLMConfigInternalTokenRaw,
		SettingsEncryptionKeyRaw:   input.SettingsEncryptionKeyRaw,
		IsProduction:               input.NodeEnvRaw == productionNodeEnv,
	}, nil
}

// productionNodeEnv is the exact NODE_ENV value that selects the production
// encryption policy.
const productionNodeEnv = "production"

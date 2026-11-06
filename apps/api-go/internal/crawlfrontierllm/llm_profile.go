package crawlfrontierllm

import (
	"context"
	"database/sql"
	"errors"
	"math"
	"net/http"
	"strings"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/litellmcompat"
)

// llm_profile.go resolves the active LiteLLM gateway profile through the shared
// litellmcompat resolver. It previously carried its own copy of profile
// normalization, secret decryption, api-base normalization and managed-proxy
// governance; those now live in exactly one place (litellmcompat/settingscrypto)
// so the crawl frontier path cannot drift from the other LLM clients.

// LLMGatewayEnv is the LITELLM_* environment Nest merges under a stored
// profile.
type LLMGatewayEnv struct {
	APIBase       string
	APIKey        string
	EncryptionKey string
	TimeoutMs     int
	MaxRetries    int
}

// gatewayProfile is the effective completion/rerank profile.
type gatewayProfile struct {
	ID                        string
	APIBase                   string
	APIKey                    string
	Model                     string
	FallbackModels            []string
	RerankModel               string
	RerankFallbacks           []string
	Timeout                   time.Duration
	MaxRetries                int
	SendMetadata              bool
	ResponseFormatMode        string
	APISurface                string
	TopP                      float64
	GovernanceApplied         bool
	GovernanceAuthMode        string
	GovernanceTargetProfileID string
}

func (p gatewayProfile) authMode() string {
	if p.GovernanceApplied {
		return "managed_runtime_key"
	}
	if p.GovernanceAuthMode != "" {
		return p.GovernanceAuthMode
	}
	return "profile_key"
}

// resolveGatewayProfile selects the completion or rerank profile through the
// shared litellmcompat resolver.
func resolveGatewayProfile(ctx context.Context, db *sql.DB, env LLMGatewayEnv, kind string) (gatewayProfile, error) {
	cfg := litellmcompat.Config{
		EncryptionKey: env.EncryptionKey,
		APIBase:       defaultString(env.APIBase, "http://localhost:4001"),
		Timeout:       time.Duration(defaultPositive(env.TimeoutMs, 60_000)) * time.Millisecond,
		MaxRetries:    defaultPositive(env.MaxRetries, 3),
	}
	profileKind := litellmcompat.ProfileCompletion
	if kind == "rerank" {
		profileKind = litellmcompat.ProfileRerank
	}
	resolved, err := litellmcompat.NewClient(db, nil, cfg).ResolveProfile(ctx, profileKind)
	if err != nil {
		return gatewayProfile{}, translateCrawlProfileError(kind, err)
	}
	return gatewayProfileFromShared(resolved), nil
}

// translateCrawlProfileError keeps the crawl frontier contract: a missing
// profile is its historic "not configured" message and a governance
// misconfiguration keeps the HTTP 503 NestError envelope.
func translateCrawlProfileError(kind string, err error) error {
	var governance *litellmcompat.GovernanceError
	if errors.As(err, &governance) {
		return &NestError{Status: http.StatusServiceUnavailable, Message: governance.Message}
	}
	if kind == "rerank" {
		if errors.Is(err, litellmcompat.ErrRerankUnavailable) {
			return errors.New("rerank model is not configured")
		}
		return err
	}
	if errors.Is(err, litellmcompat.ErrCompletionUnavailable) {
		return errors.New("completion model is not configured")
	}
	return err
}

func gatewayProfileFromShared(profile litellmcompat.Profile) gatewayProfile {
	return gatewayProfile{
		ID:                        profile.ID,
		APIBase:                   profile.APIBase,
		APIKey:                    profile.APIKey,
		Model:                     profile.Model,
		FallbackModels:            profile.FallbackModels,
		RerankModel:               profile.RerankModel,
		RerankFallbacks:           profile.RerankFallbackModels,
		Timeout:                   profile.Timeout,
		MaxRetries:                profile.MaxRetries,
		SendMetadata:              profile.SendMetadata,
		ResponseFormatMode:        string(profile.ResponseFormatMode),
		APISurface:                string(profile.APISurface),
		TopP:                      profile.TopP,
		GovernanceApplied:         profile.GovernanceApplied,
		GovernanceAuthMode:        profile.AuthMode,
		GovernanceTargetProfileID: profile.GovernanceTargetProfileID,
	}
}

func defaultPositive(value, fallback int) int {
	if value <= 0 {
		return fallback
	}
	return value
}

func uniqueModels(models []string) []string {
	seen := map[string]struct{}{}
	out := make([]string, 0, len(models))
	for _, model := range models {
		model = strings.TrimSpace(model)
		if model == "" {
			continue
		}
		if _, ok := seen[model]; ok {
			continue
		}
		seen[model] = struct{}{}
		out = append(out, model)
	}
	return out
}

func finiteNumber(value any) (float64, bool) {
	number, ok := value.(float64)
	if !ok || math.IsNaN(number) || math.IsInf(number, 0) {
		return 0, false
	}
	return number, true
}

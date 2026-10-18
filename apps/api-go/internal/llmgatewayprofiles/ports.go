package llmgatewayprofiles

import (
	"context"
	"log"
	"net/http"

	"github.com/wei500L/newwei/apps/api-go/internal/authhttp"
)

// This file is the narrow typed surface the LLM gateway operations batch needs
// from the profile document. Every function delegates to the private helper
// that already backs the seven profile routes, so the two batches cannot drift
// on normalization, decryption or binding semantics.
//
// Nothing here writes the profile document. The read-only snapshot deliberately
// runs on the shared MySQL pool: the profiles write lock (GET_LOCK) belongs to
// the CRUD routes, and a diagnostics batch must not hold it.

// NormalizeAPIBase is the shared normalizeOpenAiApiBase helper. The operations
// batch needs it for two things: comparing the governed apiBase of a target
// profile, and building the proxy model info cache key, which hashes the
// normalized base so an endpoint-suffixed spelling shares one entry.
func NormalizeAPIBase(raw string) string { return normalizeOpenAiApiBase(raw) }

// ValidateAPIBaseURL reports whether value passes the
// @IsUrl({require_protocol: true, require_tld: false}) contract of every apiBase
// DTO field. Internal hostnames (litellm:4000) are accepted on purpose; the
// public-SSRF rules of the crawl metadata DTOs do not apply here.
func ValidateAPIBaseURL(value string) bool { return validatorIsURL(value) }

// Authorize runs the shared settings.manage chain (human JWT with Redis
// revocation and MySQL permission re-derivation, or an mtk_ machine token) and
// returns the actor identity.
//
// The twelve operations routes need exactly the same permission path as the
// seven profile routes, so they share this authenticator instead of rebuilding a
// second machine-token lookup. On failure the contract error is already written
// and nil is returned, so the caller must stop.
func (a *Authenticator) Authorize(w http.ResponseWriter, r *http.Request) *authhttp.Identity {
	return a.authorize(w, r)
}

// ResolvedProfileConfig is one stored profile with its apiKey already resolved
// through the shared decryption policy. The apiKey value never leaves the
// process: it is only used as an Authorization header for one probe request.
type ResolvedProfileConfig struct {
	ID                   string
	Name                 string
	Enabled              bool
	APIBase              string
	APIKey               string
	HasAPIKey            bool
	Model                string
	EmbeddingModel       *string
	RerankModel          *string
	FallbackModels       []string
	RerankFallbackModels []string
	TimeoutMs            float64
	Temperature          float64
	TopP                 float64
	MaxOutputTokens      float64
	// SendMetadata is nil when the stored document holds an explicit null, so
	// the caller can reproduce the `input ?? cfg.sendMetadata ?? true` chain.
	SendMetadata       *bool
	ResponseFormatMode ResponseFormatMode
	APISurface         APISurface
}

// RuntimeProfileConfig returns one profile by id, regardless of its enabled
// flag: a saved but disabled profile stays diagnosable, and only the governance
// target selection requires enabled=true.
func (s *Service) RuntimeProfileConfig(ctx context.Context, id string) (ResolvedProfileConfig, bool, error) {
	if id == "" {
		return ResolvedProfileConfig{}, false, nil
	}
	settings, err := s.loadSettingsCached(ctx)
	if err != nil {
		return ResolvedProfileConfig{}, false, err
	}
	profile, ok := findProfile(settings.Profiles, id)
	if !ok {
		return ResolvedProfileConfig{}, false, nil
	}
	apiKey, hasAPIKey := s.resolveSecret(profile.APIKey)
	var sendMetadata *bool
	if !profile.SendMetadata.Null {
		value := profile.SendMetadata.Value
		sendMetadata = &value
	}
	return ResolvedProfileConfig{
		ID:                   profile.ID,
		Name:                 profile.Name,
		Enabled:              profile.Enabled,
		APIBase:              profile.APIBase,
		APIKey:               apiKey,
		HasAPIKey:            hasAPIKey,
		Model:                profile.Model,
		EmbeddingModel:       profile.EmbeddingModel,
		RerankModel:          profile.RerankModel,
		FallbackModels:       nonNilStrings(profile.FallbackModels),
		RerankFallbackModels: nonNilStrings(profile.RerankFallbackModels),
		TimeoutMs:            profile.TimeoutMs,
		Temperature:          profile.Temperature,
		TopP:                 profile.TopP,
		MaxOutputTokens:      profile.MaxOutputTokens,
		SendMetadata:         sendMetadata,
		ResponseFormatMode:   profile.ResponseFormatMode,
		APISurface:           profile.APISurface,
	}, true, nil
}

// RuntimeBindings is the runtime profile binding snapshot. A nil field means the
// kind currently resolves to no profile, which is how governance preflight tells
// "this target serves that traffic" from "nothing serves it at all".
type RuntimeBindings struct {
	CompletionProfileID *string
	EmbeddingProfileID  *string
	RerankProfileID     *string
}

// RuntimeBindings mirrors the NestJS getRuntimeBindingSnapshot. The bindings are
// resolved from the same selection rules the runtime config getters use, so an
// activeId that points at a disabled profile does not count as bound.
func (s *Service) RuntimeBindings(ctx context.Context) (RuntimeBindings, error) {
	settings, err := s.loadSettingsCached(ctx)
	if err != nil {
		return RuntimeBindings{}, err
	}
	return RuntimeBindings{
		CompletionProfileID: profileIDPointer(resolveRuntimeProfile(settings, runtimeKindCompletion)),
		EmbeddingProfileID:  profileIDPointer(resolveRuntimeProfile(settings, runtimeKindEmbedding)),
		RerankProfileID:     profileIDPointer(resolveRuntimeProfile(settings, runtimeKindRerank)),
	}, nil
}

// runtimeKind selects one of the three runtime binding rules.
type runtimeKind int

const (
	runtimeKindCompletion runtimeKind = iota
	runtimeKindEmbedding
	runtimeKindRerank
)

// resolveRuntimeProfile mirrors the NestJS resolveRuntimeProfile.
func resolveRuntimeProfile(settings StoredSettings, kind runtimeKind) *StoredProfile {
	switch kind {
	case runtimeKindCompletion:
		if settings.ActiveID != nil {
			if active, ok := findProfile(settings.Profiles, *settings.ActiveID); ok && active.Enabled {
				return &active
			}
		}
		return resolveDefaultProfile(settings, kind)
	case runtimeKindEmbedding:
		var resolvedID *string
		if settings.EmbeddingActiveID != nil {
			resolvedID = settings.EmbeddingActiveID
		} else if settings.EmbeddingMode != EmbeddingModeUseDefault {
			resolvedID = settings.ActiveID
		}
		if resolvedID != nil {
			if explicit, ok := findProfile(settings.Profiles, *resolvedID); ok && explicit.Enabled && explicit.EmbeddingModel != nil {
				return &explicit
			}
		}
		if settings.EmbeddingMode == EmbeddingModeUseDefault || resolvedID == nil {
			return resolveDefaultProfile(settings, kind)
		}
		return nil
	}
	var resolvedID *string
	if settings.RerankActiveID != nil {
		resolvedID = settings.RerankActiveID
	} else if settings.RerankMode != RerankModeUseDefault {
		resolvedID = settings.ActiveID
	}
	if resolvedID != nil {
		if explicit, ok := findProfile(settings.Profiles, *resolvedID); ok && explicit.Enabled && explicit.RerankModel != nil {
			return &explicit
		}
	}
	if settings.RerankMode == RerankModeUseDefault || resolvedID == nil {
		return resolveDefaultProfile(settings, kind)
	}
	return nil
}

// resolveDefaultProfile mirrors the NestJS resolveDefaultProfile: the first
// ENABLED profile, and for embedding/rerank the first one that also configures
// the matching model field.
func resolveDefaultProfile(settings StoredSettings, kind runtimeKind) *StoredProfile {
	for index := range settings.Profiles {
		profile := settings.Profiles[index]
		if !profile.Enabled {
			continue
		}
		switch kind {
		case runtimeKindCompletion:
			return &profile
		case runtimeKindEmbedding:
			if profile.EmbeddingModel != nil {
				return &profile
			}
		case runtimeKindRerank:
			if profile.RerankModel != nil {
				return &profile
			}
		}
	}
	return nil
}

// profileIDPointer projects a resolved profile onto its id.
func profileIDPointer(profile *StoredProfile) *string {
	if profile == nil {
		return nil
	}
	id := profile.ID
	return &id
}

// EncodeSecretForStorage applies the shared write-time secret policy (encrypt by
// default, plaintext only in the documented non-production fallback, fail closed
// when encryption is enabled but unusable).
func (s *Service) EncodeSecretForStorage(ctx context.Context, plain string) (*SecretValue, error) {
	return s.encodeSecretForStorage(ctx, plain)
}

// DecryptSecretEnvelope opens one system-settings:v1 envelope with the resolved
// SYSTEM_SETTINGS_ENCRYPTION_KEY. ok is false when the key is missing, invalid
// or the ciphertext does not authenticate; the caller maps that onto the
// "unreadable" state instead of treating it as "missing".
func (s *Service) DecryptSecretEnvelope(envelope EncryptedStringValueV1) (string, bool) {
	status := s.resolveKeyStatus()
	if !status.valid {
		log.Printf("llmgatewayprofiles: missing SYSTEM_SETTINGS_ENCRYPTION_KEY for a managed runtime key")
		return "", false
	}
	plain, err := decryptStringValueV1(envelope, status.key)
	if err != nil {
		log.Printf("llmgatewayprofiles: failed to decrypt a managed runtime key")
		return "", false
	}
	return plain, true
}

package llmembed

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/litellmcompat"
)

// llmembed delegates gateway-profile resolution to the shared litellmcompat
// resolver. The former per-package copies of normalizeProfile/resolveProfileKey/
// decryptSecret/normalizeAPIBase/applyGovernance are retired so the embedding
// and rerank callers resolve exactly the same profile as the completion paths.

type storedProfile struct {
	ID              string
	Name            string
	APIBase         string
	APIKey          string
	Model           string
	EmbeddingModel  string
	RerankModel     string
	RerankFallbacks []string
	Timeout         time.Duration
	MaxRetries      int
	SendMetadata    bool
	Enabled         bool
}

type runtimeProfile struct {
	storedProfile
	// GovernanceApplied reports whether the managed runtime key replaced the
	// profile key for this call. It is observation-only: no request behavior
	// depends on it.
	GovernanceApplied bool
	// GovernanceTargetProfileID is the governance target profile id when the
	// key was swapped.
	GovernanceTargetProfileID string
	// AuthMode is the effective credential mode, "profile_key" or
	// "managed_runtime_key".
	AuthMode string
}

// sharedResolve resolves one profile through the shared client. The raw error is
// returned so the runtime-model probes can keep distinguishing "no profile" from
// a configuration read failure.
func (c *Client) sharedResolve(ctx context.Context, kind litellmcompat.ProfileKind) (litellmcompat.Profile, error) {
	env := gatewayEnv()
	cfg := litellmcompat.Config{
		EncryptionKey: env.EncryptionKey,
		APIBase:       env.APIBase,
		Timeout:       time.Duration(env.TimeoutMs) * time.Millisecond,
		MaxRetries:    env.MaxRetries,
	}
	return litellmcompat.NewClient(c.db, nil, cfg).ResolveProfile(ctx, kind)
}

func (c *Client) resolveEmbedding(ctx context.Context) (runtimeProfile, error) {
	profile, err := c.sharedResolve(ctx, litellmcompat.ProfileEmbedding)
	if err != nil {
		var governance *litellmcompat.GovernanceError
		if errors.As(err, &governance) {
			return runtimeProfile{}, errUpstream
		}
		return runtimeProfile{}, errEmbeddingUnavailable
	}
	return runtimeProfileFromShared(profile), nil
}

func (c *Client) resolveRerank(ctx context.Context) (runtimeProfile, error) {
	profile, err := c.sharedResolve(ctx, litellmcompat.ProfileRerank)
	if err != nil {
		var governance *litellmcompat.GovernanceError
		if errors.As(err, &governance) {
			return runtimeProfile{}, errUpstream
		}
		return runtimeProfile{}, errRerankUnavailable
	}
	return runtimeProfileFromShared(profile), nil
}

func runtimeProfileFromShared(profile litellmcompat.Profile) runtimeProfile {
	authMode := profile.AuthMode
	if authMode == "" {
		authMode = "profile_key"
	}
	return runtimeProfile{
		storedProfile: storedProfile{
			ID:              profile.ID,
			Name:            profile.Name,
			APIBase:         profile.APIBase,
			APIKey:          profile.APIKey,
			Model:           profile.Model,
			EmbeddingModel:  profile.EmbeddingModel,
			RerankModel:     profile.RerankModel,
			RerankFallbacks: profile.RerankFallbackModels,
			Timeout:         profile.Timeout,
			MaxRetries:      profile.MaxRetries,
			SendMetadata:    profile.SendMetadata,
			Enabled:         profile.Enabled,
		},
		GovernanceApplied:         profile.GovernanceApplied,
		GovernanceTargetProfileID: profile.GovernanceTargetProfileID,
		AuthMode:                  authMode,
	}
}

func jsonString(value any) string {
	text, _ := value.(string)
	return strings.TrimSpace(text)
}

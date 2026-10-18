package llmgatewayprofiles

import (
	"context"
	"encoding/json"
)

// SetActiveProfile mirrors the NestJS setActiveProfile.
//
// activeID is the raw body value after `body.activeId ?? null`, so an empty
// string is written as-is and only normalized (back to null) by the response
// projection. The embedding and rerank selections and both modes are untouched.
func (s *Service) SetActiveProfile(ctx context.Context, orgID, actorID string, activeID *string) (SettingsPublic, error) {
	if err := s.assertPlatformAdmin(ctx, actorID); err != nil {
		return SettingsPublic{}, err
	}

	var result SettingsPublic
	err := s.withProfilesLock(ctx, func(lockCtx context.Context) error {
		settings, err := s.loadSettingsAuthoritative(lockCtx)
		if err != nil {
			return err
		}
		if truthyString(activeID) {
			found, ok := findProfile(settings.Profiles, *activeID)
			if !ok {
				return notFound("LLM gateway profile not found")
			}
			if !found.Enabled {
				return badRequest("Cannot activate a disabled LLM gateway profile")
			}
		}
		settings.ActiveID = activeID

		metadata := encodeMetadata(json.Marshal(gatewayActiveIDMetadata{ActiveID: activeID}))
		if err := s.saveSettings(lockCtx, orgID, actorID, settings, AuditActionActivate, metadata); err != nil {
			return err
		}
		// The response is projected from this authoritative result instead of
		// re-reading a possibly stale cache entry.
		result = PublicSettingsOf(s.persistedView(settings), s.hasAPIKey)
		return nil
	})
	if err != nil {
		return SettingsPublic{}, err
	}
	return result, nil
}

// SetEmbeddingActiveProfile mirrors the NestJS setEmbeddingActiveProfile. The
// disabled check runs before the embeddingModel requirement; the mode is only
// applied when the selection is falsy, and the completion and rerank selections
// are untouched.
func (s *Service) SetEmbeddingActiveProfile(ctx context.Context, orgID, actorID string, activeID *string, mode *EmbeddingMode) (SettingsPublic, error) {
	if err := s.assertPlatformAdmin(ctx, actorID); err != nil {
		return SettingsPublic{}, err
	}

	var result SettingsPublic
	err := s.withProfilesLock(ctx, func(lockCtx context.Context) error {
		settings, err := s.loadSettingsAuthoritative(lockCtx)
		if err != nil {
			return err
		}
		if truthyString(activeID) {
			found, ok := findProfile(settings.Profiles, *activeID)
			if !ok {
				return notFound("LLM gateway profile not found")
			}
			if !found.Enabled {
				return badRequest("Cannot activate a disabled LLM gateway profile")
			}
			if found.EmbeddingModel == nil {
				return badRequest("Embeddings gateway profile must configure embeddingModel")
			}
		}
		settings.EmbeddingActiveID = activeID
		if !truthyString(activeID) {
			if mode != nil {
				settings.EmbeddingMode = *mode
			} else {
				settings.EmbeddingMode = EmbeddingModeFollowCompletion
			}
		}

		metadata := encodeMetadata(json.Marshal(gatewayEmbeddingActiveIDMetadata{EmbeddingActiveID: activeID}))
		if err := s.saveSettings(lockCtx, orgID, actorID, settings, AuditActionEmbeddingActivate, metadata); err != nil {
			return err
		}
		result = PublicSettingsOf(s.persistedView(settings), s.hasAPIKey)
		return nil
	})
	if err != nil {
		return SettingsPublic{}, err
	}
	return result, nil
}

// SetRerankActiveProfile mirrors the NestJS setRerankActiveProfile.
func (s *Service) SetRerankActiveProfile(ctx context.Context, orgID, actorID string, activeID *string, mode *RerankMode) (SettingsPublic, error) {
	if err := s.assertPlatformAdmin(ctx, actorID); err != nil {
		return SettingsPublic{}, err
	}

	var result SettingsPublic
	err := s.withProfilesLock(ctx, func(lockCtx context.Context) error {
		settings, err := s.loadSettingsAuthoritative(lockCtx)
		if err != nil {
			return err
		}
		if truthyString(activeID) {
			found, ok := findProfile(settings.Profiles, *activeID)
			if !ok {
				return notFound("LLM gateway profile not found")
			}
			if !found.Enabled {
				return badRequest("Cannot activate a disabled LLM gateway profile")
			}
			if found.RerankModel == nil {
				return badRequest("Rerank gateway profile must configure rerankModel")
			}
		}
		settings.RerankActiveID = activeID
		if !truthyString(activeID) {
			if mode != nil {
				settings.RerankMode = *mode
			} else {
				settings.RerankMode = RerankModeFollowCompletion
			}
		}

		metadata := encodeMetadata(json.Marshal(gatewayRerankActiveIDMetadata{RerankActiveID: activeID}))
		if err := s.saveSettings(lockCtx, orgID, actorID, settings, AuditActionRerankActivate, metadata); err != nil {
			return err
		}
		result = PublicSettingsOf(s.persistedView(settings), s.hasAPIKey)
		return nil
	})
	if err != nil {
		return SettingsPublic{}, err
	}
	return result, nil
}

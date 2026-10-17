package llmgatewayprofiles

import (
	"context"
	"encoding/json"
	"strings"
)

// buildProfileFromInput mirrors the NestJS buildProfileFromInput.
//
// base is nil for create and the existing normalized profile for update. The
// NestJS helper receives the environment configuration as its fallback on create
// and the existing profile on update; callers pass the matching profileDefaults.
//
// Several historical behaviours are load-bearing and intentionally preserved:
//   - name/apiBase/model use nullish coalescing, so an absent or blank value
//     inherits instead of clearing;
//   - apiKey absent keeps the previously stored value byte-for-byte, while null,
//     a blank string or a standalone "Bearer" clears it;
//   - optional models are cleared by an explicit null;
//   - a null fallback model list keeps the existing array instead of clearing it;
//   - explicit null for timeoutMs/maxOutputTokens/maxRetries falls back to the
//     per-operation default because Number(null) === 0 is not a positive int;
//   - explicit null for temperature/topP becomes 0 because Number(null) === 0
//     is clamped, not treated as absent;
//   - assistantWebSearchEnabled/sendMetadata may hold an explicit null
//     immediately after the write, unlike the follow-up GET;
//   - enabled uses ?? so null and absent both inherit.
func (s *Service) buildProfileFromInput(ctx context.Context, base *StoredProfile, identity profileIdentity, defaults profileDefaults, input profileInput) (StoredProfile, error) {
	name := normalizeStringValue(input.Name)
	if name == nil && base != nil {
		value := base.Name
		name = &value
	}
	if name == nil {
		return StoredProfile{}, badRequest("name is required")
	}

	apiBase := normalizeStringValue(input.APIBase)
	if apiBase == nil && base != nil {
		value := base.APIBase
		apiBase = &value
	}
	if apiBase == nil {
		value := defaults.APIBase
		apiBase = &value
	}

	model := normalizeStringValue(input.Model)
	if model == nil && base != nil {
		value := base.Model
		model = &value
	}
	if model == nil {
		return StoredProfile{}, badRequest("apiBase and model are required")
	}

	apiKey, err := s.normalizeAPIKeyInput(ctx, input, base)
	if err != nil {
		return StoredProfile{}, err
	}

	embeddingModel := basePointedString(base, func(profile StoredProfile) *string { return profile.EmbeddingModel })
	if input.EmbeddingModelSet {
		embeddingModel = normalizeOptionalStringValue(input.EmbeddingModel)
	}

	rerankModel := basePointedString(base, func(profile StoredProfile) *string { return profile.RerankModel })
	if input.RerankModelSet {
		rerankModel = normalizeOptionalStringValue(input.RerankModel)
	}

	rerankFallbackModels := baseStringList(base, func(profile StoredProfile) []string { return profile.RerankFallbackModels })
	if input.RerankFallbackModelsSet && input.RerankFallbackModels != nil {
		rerankFallbackModels = normalizeStringValues(input.RerankFallbackModels, rerankFallbackModels)
	}

	assistantModel := basePointedString(base, func(profile StoredProfile) *string { return profile.AssistantModel })
	if input.AssistantModelSet {
		assistantModel = normalizeOptionalStringValue(input.AssistantModel)
	} else if base == nil {
		assistantModel = defaults.AssistantModel
	}

	timeoutMs := defaults.TimeoutMs
	if input.TimeoutMsSet {
		timeoutMs = asPositiveInt(input.TimeoutMs, defaults.TimeoutMs)
	} else if base != nil {
		timeoutMs = base.TimeoutMs
	}

	temperature := defaults.Temperature
	if input.TemperatureSet {
		temperature = clampNumber(input.Temperature, defaults.Temperature, 0, maxTemperature)
	} else if base != nil {
		temperature = base.Temperature
	}

	topP := defaults.TopP
	if input.TopPSet {
		topP = clampNumber(input.TopP, defaults.TopP, 0, 1)
	} else if base != nil {
		topP = base.TopP
	}

	maxOutputTokens := defaults.MaxOutputTokens
	if input.MaxOutputTokensSet {
		maxOutputTokens = asPositiveInt(input.MaxOutputTokens, defaults.MaxOutputTokens)
	} else if base != nil {
		maxOutputTokens = base.MaxOutputTokens
	}

	maxRetries := defaults.MaxRetries
	if input.MaxRetriesSet {
		maxRetries = asPositiveInt(input.MaxRetries, defaults.MaxRetries)
	} else if base != nil {
		maxRetries = base.MaxRetries
	}

	fallbackModels := baseStringList(base, func(profile StoredProfile) []string { return profile.FallbackModels })
	if input.FallbackModelsSet && input.FallbackModels != nil {
		fallbackModels = normalizeStringValues(input.FallbackModels, fallbackModels)
	}

	assistantWebSearchEnabled := boolNullable(defaults.AssistantWebSearchEnabled)
	if input.AssistantWebSearchEnabledSet {
		assistantWebSearchEnabled = nullableBoolFromPointer(input.AssistantWebSearchEnabled)
	} else if base != nil {
		assistantWebSearchEnabled = base.AssistantWebSearchEnabled
	}

	sendMetadata := boolNullable(defaults.SendMetadata)
	if input.SendMetadataSet {
		sendMetadata = nullableBoolFromPointer(input.SendMetadata)
	} else if base != nil {
		sendMetadata = base.SendMetadata
	}

	responseFormatMode := DefaultProfileResponseFormatMode
	if input.ResponseFormatModeSet {
		responseFormatMode = normalizeResponseFormatModeValue(input.ResponseFormatMode, DefaultProfileResponseFormatMode)
	} else if base != nil {
		responseFormatMode = base.ResponseFormatMode
	} else {
		responseFormatMode = normalizeResponseFormatModeValue(defaults.ResponseFormatMode, DefaultProfileResponseFormatMode)
	}

	apiSurface := DefaultProfileAPISurface
	if input.APISurfaceSet {
		apiSurface = normalizeAPISurfaceValue(input.APISurface, DefaultProfileAPISurface)
	} else if base != nil {
		apiSurface = base.APISurface
	} else {
		apiSurface = normalizeAPISurfaceValue(defaults.APISurface, DefaultProfileAPISurface)
	}

	enabled := true
	if input.Enabled != nil {
		enabled = *input.Enabled
	} else if base != nil {
		enabled = base.Enabled
	}

	return StoredProfile{
		ID:                        identity.ID,
		Name:                      *name,
		APIBase:                   *apiBase,
		APIKey:                    apiKey,
		Model:                     *model,
		EmbeddingModel:            embeddingModel,
		RerankModel:               rerankModel,
		RerankFallbackModels:      nonNilStrings(rerankFallbackModels),
		AssistantModel:            assistantModel,
		AssistantWebSearchEnabled: assistantWebSearchEnabled,
		TimeoutMs:                 timeoutMs,
		Temperature:               temperature,
		TopP:                      topP,
		MaxOutputTokens:           maxOutputTokens,
		MaxRetries:                maxRetries,
		FallbackModels:            nonNilStrings(fallbackModels),
		SendMetadata:              sendMetadata,
		ResponseFormatMode:        responseFormatMode,
		APISurface:                apiSurface,
		Enabled:                   enabled,
		CreatedAt:                 identity.CreatedAt,
		UpdatedAt:                 identity.UpdatedAt,
	}, nil
}

// normalizeStringValue trims a validated DTO string and treats blank as absent.
func normalizeStringValue(value *string) *string {
	if value == nil {
		return nil
	}
	trimmed := strings.TrimSpace(*value)
	if trimmed == "" {
		return nil
	}
	return &trimmed
}

// normalizeOptionalStringValue mirrors the service normalizeOptionalString: a
// null or blank optional string becomes absent.
func normalizeOptionalStringValue(value *string) *string {
	return normalizeStringValue(value)
}

// normalizeResponseFormatModeValue mirrors normalizeResponseFormatMode.
func normalizeResponseFormatModeValue(value ResponseFormatMode, fallback ResponseFormatMode) ResponseFormatMode {
	switch value {
	case ResponseFormatJSONSchema, ResponseFormatJSONObject, ResponseFormatNone:
		return value
	}
	return fallback
}

// normalizeAPISurfaceValue mirrors normalizeApiSurface.
func normalizeAPISurfaceValue(value APISurface, fallback APISurface) APISurface {
	switch value {
	case APISurfaceChatCompletions, APISurfaceResponses:
		return value
	}
	return fallback
}

// basePointedString reads one optional pointer field from the base profile.
func basePointedString(base *StoredProfile, pick func(StoredProfile) *string) *string {
	if base == nil {
		return nil
	}
	return pick(*base)
}

// baseStringList reads one string list field from the base profile.
func baseStringList(base *StoredProfile, pick func(StoredProfile) []string) []string {
	if base == nil {
		return []string{}
	}
	return nonNilStrings(pick(*base))
}

// nullableBoolFromPointer turns an optional DTO boolean into the tri-state model
// (nil means the request sent an explicit null).
func nullableBoolFromPointer(value *bool) NullableBool {
	if value == nil {
		return nullNullable()
	}
	return boolNullable(*value)
}

// removeProfilesByID removes EVERY profile with the given id, preserving the
// order of the remaining entries. The NestJS delete uses filter(), so duplicate
// ids are all removed while update only replaces the first match.
func removeProfilesByID(profiles []StoredProfile, id string) []StoredProfile {
	next := make([]StoredProfile, 0, len(profiles))
	for _, profile := range profiles {
		if profile.ID != id {
			next = append(next, profile)
		}
	}
	return next
}

// normalizeStringValues is normalizeStringList for an already-decoded string
// slice: trim, drop empties, stable de-duplicate.
func normalizeStringValues(values []string, fallback []string) []string {
	out := make([]string, 0, len(values))
	seen := make(map[string]bool, len(values))
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value == "" || seen[value] {
			continue
		}
		seen[value] = true
		out = append(out, value)
	}
	return out
}

// CreateProfile mirrors the NestJS createProfile. It is the only operation that
// mints a profile id, and the id, createdAt and updatedAt all share one
// millisecond timestamp.
func (s *Service) CreateProfile(ctx context.Context, orgID, actorID string, input profileInput) (PublicProfile, error) {
	// GP1: the gate is the first statement of the write path, before the
	// authoritative read, the lock, the encoding, the write, the audit and the
	// cache eviction.
	if err := s.assertPlatformAdmin(ctx, actorID); err != nil {
		return PublicProfile{}, err
	}

	var created PublicProfile
	err := s.withProfilesLock(ctx, func(lockCtx context.Context) error {
		settings, err := s.loadSettingsAuthoritative(lockCtx)
		if err != nil {
			return err
		}
		id, err := newUUIDv4()
		if err != nil {
			return err
		}
		now := nowISO()
		identity := profileIdentity{ID: id, CreatedAt: now, UpdatedAt: now}
		profile, err := s.buildProfileFromInput(lockCtx, nil, identity, profileDefaultsFor(s.cfg.Env), input)
		if err != nil {
			return err
		}

		settings.Profiles = append(settings.Profiles, profile)
		// The write order is preserved even when the new profile is disabled:
		// the follow-up normalization drops an unusable activeId.
		if settings.ActiveID == nil {
			activeID := profile.ID
			settings.ActiveID = &activeID
		}

		metadata := encodeMetadata(json.Marshal(profileAuditMetadata(profile, s.hasAPIKey(profile))))
		if err := s.saveSettings(lockCtx, orgID, actorID, settings, AuditActionCreate, metadata); err != nil {
			return err
		}
		created = PublicProfileOf(profile, s.hasAPIKey(profile))
		return nil
	})
	if err != nil {
		return PublicProfile{}, err
	}
	return created, nil
}

// UpdateProfile mirrors the NestJS updateProfile.
func (s *Service) UpdateProfile(ctx context.Context, orgID, actorID, id string, input profileInput) (PublicProfile, error) {
	if err := s.assertPlatformAdmin(ctx, actorID); err != nil {
		return PublicProfile{}, err
	}

	var updated PublicProfile
	err := s.withProfilesLock(ctx, func(lockCtx context.Context) error {
		settings, err := s.loadSettingsAuthoritative(lockCtx)
		if err != nil {
			return err
		}
		index := -1
		for position := range settings.Profiles {
			if settings.Profiles[position].ID == id {
				index = position
				break
			}
		}
		if index == -1 {
			return notFound("LLM gateway profile not found")
		}
		existing := settings.Profiles[index]
		identity := profileIdentity{ID: id, CreatedAt: existing.CreatedAt, UpdatedAt: nowISO()}
		next, err := s.buildProfileFromInput(lockCtx, &existing, identity, updateDefaultsFor(existing), input)
		if err != nil {
			return err
		}
		if err := s.assertProfileUpdateAllowed(lockCtx, id, existing.APIBase, next.APIBase, next.Enabled); err != nil {
			return err
		}

		settings.Profiles[index] = next
		if settings.ActiveID != nil && *settings.ActiveID == id && !next.Enabled {
			settings.ActiveID = nil
		}
		if settings.EmbeddingActiveID != nil && *settings.EmbeddingActiveID == id && (!next.Enabled || next.EmbeddingModel == nil) {
			settings.EmbeddingActiveID = nil
		}
		if settings.RerankActiveID != nil && *settings.RerankActiveID == id && (!next.Enabled || next.RerankModel == nil) {
			settings.RerankActiveID = nil
		}

		metadata := encodeMetadata(json.Marshal(profileAuditMetadata(next, s.hasAPIKey(next))))
		if err := s.saveSettings(lockCtx, orgID, actorID, settings, AuditActionUpdate, metadata); err != nil {
			return err
		}
		updated = PublicProfileOf(next, s.hasAPIKey(next))
		return nil
	})
	if err != nil {
		return PublicProfile{}, err
	}
	return updated, nil
}

// DeleteProfile mirrors the NestJS deleteProfile. The governance protection runs
// before the existence check, so a governed target that is already missing from
// the document still fails with the governance 400 instead of a 404.
func (s *Service) DeleteProfile(ctx context.Context, orgID, actorID, id string) error {
	if err := s.assertPlatformAdmin(ctx, actorID); err != nil {
		return err
	}

	return s.withProfilesLock(ctx, func(lockCtx context.Context) error {
		settings, err := s.loadSettingsAuthoritative(lockCtx)
		if err != nil {
			return err
		}
		if err := s.assertProfileDeletionAllowed(lockCtx, id); err != nil {
			return err
		}

		next := removeProfilesByID(settings.Profiles, id)
		if len(next) == len(settings.Profiles) {
			return notFound("LLM gateway profile not found")
		}
		settings.Profiles = next
		if settings.ActiveID != nil && *settings.ActiveID == id {
			settings.ActiveID = nil
		}
		if settings.EmbeddingActiveID != nil && *settings.EmbeddingActiveID == id {
			settings.EmbeddingActiveID = nil
		}
		if settings.RerankActiveID != nil && *settings.RerankActiveID == id {
			settings.RerankActiveID = nil
		}
		// The two modes are preserved and the empty document is still persisted
		// when the last profile is removed.
		metadata := encodeMetadata(json.Marshal(gatewayIDMetadata{ID: id}))
		return s.saveSettings(lockCtx, orgID, actorID, settings, AuditActionDelete, metadata)
	})
}

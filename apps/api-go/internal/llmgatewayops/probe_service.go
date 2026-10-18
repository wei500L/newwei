package llmgatewayops

import (
	"context"
	"strings"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/llmgatewayprofiles"
)

// TestProfile serves POST /:id/test.
//
// The three probes run in a fixed order (completion, embedding, rerank) and each
// keeps its own result or its own error. A probe failure never aborts the
// request: only the profile lookup, the apiBase, the DTO and the managed-key
// resolution can fail the whole call.
func (s *Service) TestProfile(ctx context.Context, profileID string, input testInput, actor probeActor) (testResult, error) {
	profile, err := s.requireProfileConfig(ctx, profileID)
	if err != nil {
		return testResult{}, err
	}
	base, err := requireProfileBase(profile.APIBase)
	if err != nil {
		return testResult{}, err
	}
	authMode := authModeProfileKey
	if input.AuthMode != nil {
		authMode = *input.AuthMode
	}
	apiKey, err := s.resolveTestingAPIKey(ctx, profileID, base, profile.APIKey, authMode)
	if err != nil {
		return testResult{}, err
	}
	client := newUpstreamClient(s.http, base, apiKey, profileTimeout(profile))
	log := probeLogContext{
		OrgID:     actorOrgID(actor),
		UserID:    actor.UserID,
		ProfileID: profileID,
		AuthMode:  authMode,
	}

	shouldTestCompletion := true
	if input.IncludeCompletion != nil {
		shouldTestCompletion = *input.IncludeCompletion
	}
	apiSurface := firstNonEmpty(optionalTextValue(input.APISurface), string(profile.APISurface), surfaceChat)
	responseFormat := firstNonEmpty(optionalTextValue(input.ResponseFormatMode), string(profile.ResponseFormatMode), defaultResponseFormatMode)
	includeMetadataProbe := defaultSendMetadata
	if profile.SendMetadata != nil {
		includeMetadataProbe = *profile.SendMetadata
	}
	if input.IncludeMetadataProbe != nil {
		includeMetadataProbe = *input.IncludeMetadataProbe
	}
	prompt := defaultPrompt
	if value := normalizeOptionalText(input.Prompt); value != nil {
		prompt = *value
	}
	modelOverride := optionalTextValue(input.Model)

	settings := probeSettings{
		ProfileID:       profileID,
		AuthMode:        authMode,
		APIKey:          apiKey,
		Model:           profile.Model,
		EmbeddingModel:  stringValueOrEmpty(profile.EmbeddingModel),
		RerankModel:     stringValueOrEmpty(profile.RerankModel),
		FallbackModels:  profile.FallbackModels,
		RerankFallbacks: profile.RerankFallbackModels,
		Timeout:         profileTimeout(profile),
		Temperature:     profile.Temperature,
		TopP:            profile.TopP,
		MaxOutputTokens: profile.MaxOutputTokens,
	}

	result := testResult{APIBase: base, AuthModeUsed: authMode}
	if shouldTestCompletion {
		result.APISurfaceUsed = apiSurface
	}
	if shouldTestCompletion {
		completion, completionError := s.runCompletion(ctx, client, settings, prompt, modelOverride, completionOptions{
			APISurface:           apiSurface,
			ResponseFormatMode:   responseFormat,
			IncludeMetadataProbe: includeMetadataProbe,
			Log:                  log,
		})
		result.Completion = completion
		result.CompletionError = completionError
		if completionError != nil && completionError.Compatibility != nil {
			result.Compatibility = completionError.Compatibility
		}
	}

	embeddingModelOverride := optionalTextValue(input.EmbeddingModel)
	shouldTestEmbeddings := embeddingModelOverride != "" || settings.EmbeddingModel != ""
	if input.IncludeEmbeddings != nil {
		shouldTestEmbeddings = *input.IncludeEmbeddings
	}
	if shouldTestEmbeddings {
		embeddingInput := defaultEmbeddingInput
		if value := normalizeOptionalText(input.EmbeddingInput); value != nil {
			embeddingInput = *value
		}
		embedding, embeddingErr := s.runEmbedding(ctx, client, embeddingConfig{
			Model:          settings.Model,
			EmbeddingModel: settings.EmbeddingModel,
		}, embeddingInput, embeddingModelOverride, log)
		if embeddingErr != nil {
			rendered := toGatewayErrorInfo(embeddingErr, errorContext{
				apiKeyConfigured: boolPointer(apiKey != ""),
				apiSurface:       surfaceEmbeddings,
			}).toTestError()
			result.EmbeddingError = &rendered
		} else {
			result.Embedding = embedding
		}
	}

	shouldTestRerank := false
	if input.IncludeRerank != nil {
		shouldTestRerank = *input.IncludeRerank
	}
	if shouldTestRerank {
		rerank, rerankErr := s.runRerank(ctx, client, rerankConfig{
			Rerank:    settings.RerankModel,
			Fallbacks: settings.RerankFallbacks,
		}, rerankOptions{
			Query:                rerankQueryOrDefault(input.RerankQuery),
			Documents:            input.RerankDocuments,
			ModelOverride:        optionalTextValue(input.RerankModel),
			IncludeMetadataProbe: includeMetadataProbe,
			Log:                  log,
		})
		if rerankErr != nil {
			rendered := toGatewayErrorInfo(rerankErr, errorContext{
				apiKeyConfigured: boolPointer(apiKey != ""),
				apiSurface:       surfaceRerank,
			}).toTestError()
			result.RerankError = &rendered
		} else {
			result.Rerank = rerank
		}
	}

	if result.Completion == nil && result.CompletionError == nil &&
		result.Embedding == nil && result.EmbeddingError == nil &&
		result.Rerank == nil && result.RerankError == nil {
		return testResult{}, codedBadRequest(errorCodeNothingToTest, "Nothing to test")
	}
	return result, nil
}

// TestConfig serves POST /test-config. It is the same probe pipeline driven by an
// ad-hoc apiBase instead of a saved profile, with two deliberate differences
// from TestProfile: the model is required when completion is tested, and the
// prompt/embeddingInput fields have no length cap.
func (s *Service) TestConfig(ctx context.Context, input testConfigInput, actor probeActor) (testResult, error) {
	var stored *llmgatewayprofiles.ResolvedProfileConfig
	if input.ProfileID != nil && *input.ProfileID != "" {
		profile, err := s.requireProfileConfig(ctx, *input.ProfileID)
		if err != nil {
			return testResult{}, err
		}
		stored = &profile
	}
	base, err := requireProfileBase(input.APIBase)
	if err != nil {
		return testResult{}, err
	}

	shouldTestCompletion := true
	if input.IncludeCompletion != nil {
		shouldTestCompletion = *input.IncludeCompletion
	}
	apiSurface := firstNonEmpty(optionalTextValue(input.APISurface), storedSurface(stored), surfaceChat)
	responseFormat := firstNonEmpty(optionalTextValue(input.ResponseFormatMode), storedResponseFormat(stored), defaultResponseFormatMode)
	includeMetadataProbe := defaultSendMetadata
	if stored != nil && stored.SendMetadata != nil {
		includeMetadataProbe = *stored.SendMetadata
	}
	if input.IncludeMetadataProbe != nil {
		includeMetadataProbe = *input.IncludeMetadataProbe
	}

	// input.model is kept as `string | undefined` instead of being collapsed to
	// an empty string: the NestJS `??` chain treats a present "" as a value, so
	// an explicit blank model must select "" rather than fall through to the
	// stored profile model.
	inputModel := (*string)(nil)
	if input.Model != nil {
		trimmed := strings.TrimSpace(*input.Model)
		inputModel = &trimmed
	}
	storedModel := ""
	if stored != nil {
		storedModel = strings.TrimSpace(stored.Model)
	}
	if shouldTestCompletion && (inputModel == nil || *inputModel == "") && storedModel == "" {
		return testResult{}, codedBadRequest(errorCodeModelRequired, "model is not configured")
	}

	apiKeyFallback := ""
	if stored != nil {
		apiKeyFallback = stored.APIKey
	}
	if input.APIKeySet {
		apiKeyFallback = input.APIKey
	}
	authMode := authModeProfileKey
	if input.AuthMode != nil {
		authMode = *input.AuthMode
	}
	profileID := ""
	if input.ProfileID != nil {
		profileID = *input.ProfileID
	}
	apiKey, err := s.resolveTestingAPIKey(ctx, profileID, base, apiKeyFallback, authMode)
	if err != nil {
		return testResult{}, err
	}

	timeoutMS := defaultProfileTimeoutMS
	if input.TimeoutMS != nil {
		timeoutMS = *input.TimeoutMS
	} else if stored != nil && stored.TimeoutMs > 0 {
		timeoutMS = int(stored.TimeoutMs)
	}
	temperature := defaultTemperature
	topP := defaultTopP
	maxOutputTokens := float64(defaultMaxOutputTokens)
	if stored != nil {
		temperature = stored.Temperature
		topP = stored.TopP
		maxOutputTokens = stored.MaxOutputTokens
	}
	if input.Temperature != nil {
		temperature = *input.Temperature
	}
	if input.TopP != nil {
		topP = *input.TopP
	}
	if input.MaxOutputTokens != nil {
		maxOutputTokens = float64(*input.MaxOutputTokens)
	}

	fallbackModels := resolveStringList(input.FallbackModels, storedFallbacks(stored))
	embeddingModel := optionalTextValue(input.EmbeddingModel)
	if embeddingModel == "" && stored != nil {
		embeddingModel = strings.TrimSpace(stringValueOrEmpty(stored.EmbeddingModel))
	}
	shouldTestEmbeddings := embeddingModel != ""
	if input.IncludeEmbeddings != nil {
		shouldTestEmbeddings = *input.IncludeEmbeddings
	}
	rerankModel := optionalTextValue(input.RerankModel)
	if rerankModel == "" && stored != nil {
		rerankModel = strings.TrimSpace(stringValueOrEmpty(stored.RerankModel))
	}
	rerankFallbacks := resolveStringList(input.RerankFallbackModels, storedRerankFallbacks(stored))
	shouldTestRerank := false
	if input.IncludeRerank != nil {
		shouldTestRerank = *input.IncludeRerank
	}
	if !shouldTestCompletion && !shouldTestEmbeddings && !shouldTestRerank {
		return testResult{}, codedBadRequest(errorCodeNothingToTest, "Nothing to test")
	}

	modelForProbes := "unknown"
	switch {
	case inputModel != nil:
		modelForProbes = *inputModel
	case storedModel != "":
		modelForProbes = storedModel
	case embeddingModel != "":
		modelForProbes = embeddingModel
	}
	settings := probeSettings{
		ProfileID:       profileID,
		AuthMode:        authMode,
		APIKey:          apiKey,
		Model:           modelForProbes,
		EmbeddingModel:  embeddingModel,
		RerankModel:     rerankModel,
		FallbackModels:  fallbackModels,
		RerankFallbacks: rerankFallbacks,
		Timeout:         durationFromMillis(timeoutMS),
		Temperature:     temperature,
		TopP:            topP,
		MaxOutputTokens: maxOutputTokens,
	}
	client := newUpstreamClient(s.http, base, apiKey, settings.Timeout)
	log := probeLogContext{
		OrgID:     actorOrgID(actor),
		UserID:    actor.UserID,
		ProfileID: profileID,
		AuthMode:  authMode,
	}
	prompt := defaultPrompt
	if value := normalizeOptionalText(input.Prompt); value != nil {
		prompt = *value
	}

	result := testResult{APIBase: base, AuthModeUsed: authMode}
	if shouldTestCompletion {
		result.APISurfaceUsed = apiSurface
		completion, completionError := s.runCompletion(ctx, client, settings, prompt, "", completionOptions{
			APISurface:           apiSurface,
			ResponseFormatMode:   responseFormat,
			IncludeMetadataProbe: includeMetadataProbe,
			Log:                  log,
		})
		result.Completion = completion
		result.CompletionError = completionError
		if completionError != nil && completionError.Compatibility != nil {
			result.Compatibility = completionError.Compatibility
		}
	}
	if shouldTestEmbeddings {
		embeddingInput := defaultEmbeddingInput
		if value := normalizeOptionalText(input.EmbeddingInput); value != nil {
			embeddingInput = *value
		}
		embedding, embeddingErr := s.runEmbedding(ctx, client, embeddingConfig{
			Model:          settings.Model,
			EmbeddingModel: settings.EmbeddingModel,
		}, embeddingInput, "", log)
		if embeddingErr != nil {
			rendered := toGatewayErrorInfo(embeddingErr, errorContext{
				apiKeyConfigured: boolPointer(apiKey != ""),
				apiSurface:       surfaceEmbeddings,
			}).toTestError()
			result.EmbeddingError = &rendered
		} else {
			result.Embedding = embedding
		}
	}
	if shouldTestRerank {
		rerank, rerankErr := s.runRerank(ctx, client, rerankConfig{
			Rerank:    settings.RerankModel,
			Fallbacks: settings.RerankFallbacks,
		}, rerankOptions{
			Query:                rerankQueryOrDefault(input.RerankQuery),
			Documents:            input.RerankDocuments,
			ModelOverride:        optionalTextValue(input.RerankModel),
			IncludeMetadataProbe: includeMetadataProbe,
			Log:                  log,
		})
		if rerankErr != nil {
			rendered := toGatewayErrorInfo(rerankErr, errorContext{
				apiKeyConfigured: boolPointer(apiKey != ""),
				apiSurface:       surfaceRerank,
			}).toTestError()
			result.RerankError = &rendered
		} else {
			result.Rerank = rerank
		}
	}
	return result, nil
}

// rerankQueryOrDefault mirrors testProfile/testConfig: a missing or blank query
// falls back to the source constant instead of failing the rerank probe. The
// default only applies to an absent/blank input, never to a supplied query.
func rerankQueryOrDefault(value *string) string {
	if trimmed := optionalTextValue(value); trimmed != "" {
		return trimmed
	}
	return defaultRerankQuery
}

// actorOrgID normalizes the actor orgId the way the log writer expects.
func actorOrgID(actor probeActor) string {
	if strings.TrimSpace(actor.OrgID) == "" {
		return unknownOrgID
	}
	return actor.OrgID
}

// optionalTextValue trims an optional DTO string.
func optionalTextValue(value *string) string {
	if value == nil {
		return ""
	}
	return strings.TrimSpace(*value)
}

// stringValueOrEmpty dereferences an optional string.
func stringValueOrEmpty(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

// storedSurface reads the stored profile surface.
func storedSurface(profile *llmgatewayprofiles.ResolvedProfileConfig) string {
	if profile == nil {
		return ""
	}
	return string(profile.APISurface)
}

// storedResponseFormat reads the stored response_format mode.
func storedResponseFormat(profile *llmgatewayprofiles.ResolvedProfileConfig) string {
	if profile == nil {
		return ""
	}
	return string(profile.ResponseFormatMode)
}

// storedFallbacks reads the stored completion fallbacks.
func storedFallbacks(profile *llmgatewayprofiles.ResolvedProfileConfig) []string {
	if profile == nil {
		return nil
	}
	return profile.FallbackModels
}

// storedRerankFallbacks reads the stored rerank fallbacks.
func storedRerankFallbacks(profile *llmgatewayprofiles.ResolvedProfileConfig) []string {
	if profile == nil {
		return nil
	}
	return profile.RerankFallbackModels
}

// resolveStringList mirrors `input ?? stored ?? []` followed by
// normalizeStringList: a present array (even an empty one) replaces the stored
// value, an absent one inherits it.
func resolveStringList(input []string, stored []string) []string {
	source := input
	if source == nil {
		source = stored
	}
	out := make([]string, 0, len(source))
	seen := make(map[string]bool, len(source))
	for _, value := range source {
		trimmed := strings.TrimSpace(value)
		if trimmed == "" || seen[trimmed] {
			continue
		}
		seen[trimmed] = true
		out = append(out, trimmed)
	}
	return out
}

// durationFromMillis converts an integer millisecond budget.
func durationFromMillis(millis int) time.Duration {
	return time.Duration(millis) * time.Millisecond
}

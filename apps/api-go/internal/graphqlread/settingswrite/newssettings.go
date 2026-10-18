package settingswrite

import (
	"context"
	"encoding/json"
	"sort"

	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/contract"
	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/settingscrawl"
)

// This file holds the news pipeline settings writes: classification (with its
// business validation), classification quality, dedupe, extraction and the
// global prompt configuration.

func (s *service) updateNewsClassificationSettingsResolver(ctx contract.Context) (settingscrawl.NewsClassificationSettingsModel, error) {
	input, err := parseUpdateNewsClassificationSettingsInput(ctx.Args)
	if err == nil {
		var model settingscrawl.NewsClassificationSettingsModel
		if model, err = s.updateNewsClassificationSettings(callContext(ctx), ctx.Identity, input); err == nil {
			return model, nil
		}
	}
	return settingscrawl.NewsClassificationSettingsModel{}, graphqlFailure(err)
}

func (s *service) updateClassificationQualitySettingsResolver(ctx contract.Context) (settingscrawl.ClassificationQualitySettingsModel, error) {
	input, err := parseUpdateClassificationQualitySettingsInput(ctx.Args)
	if err == nil {
		var model settingscrawl.ClassificationQualitySettingsModel
		if model, err = s.updateClassificationQualitySettings(callContext(ctx), ctx.Identity, input); err == nil {
			return model, nil
		}
	}
	return settingscrawl.ClassificationQualitySettingsModel{}, graphqlFailure(err)
}

func (s *service) updateNewsDedupeSettingsResolver(ctx contract.Context) (settingscrawl.NewsDedupeSettingsModel, error) {
	input, err := parseUpdateNewsDedupeSettingsInput(ctx.Args)
	if err == nil {
		var model settingscrawl.NewsDedupeSettingsModel
		if model, err = s.updateNewsDedupeSettings(callContext(ctx), ctx.Identity, input); err == nil {
			return model, nil
		}
	}
	return settingscrawl.NewsDedupeSettingsModel{}, graphqlFailure(err)
}

func (s *service) updateNewsExtractionSettingsResolver(ctx contract.Context) (settingscrawl.NewsExtractionSettingsModel, error) {
	input, err := parseUpdateNewsExtractionSettingsInput(ctx.Args)
	if err == nil {
		var model settingscrawl.NewsExtractionSettingsModel
		if model, err = s.updateNewsExtractionSettings(callContext(ctx), ctx.Identity, input); err == nil {
			return model, nil
		}
	}
	return settingscrawl.NewsExtractionSettingsModel{}, graphqlFailure(err)
}

func (s *service) updateNewsPromptConfigResolver(ctx contract.Context) (settingscrawl.NewsPromptConfigModel, error) {
	input, err := parseUpdateNewsPromptConfigInput(ctx.Args)
	if err == nil {
		var model settingscrawl.NewsPromptConfigModel
		if model, err = s.updateNewsPromptConfig(callContext(ctx), ctx.Identity, input); err == nil {
			return model, nil
		}
	}
	return settingscrawl.NewsPromptConfigModel{}, graphqlFailure(err)
}

// ---- classification ----

// newsClassificationAuditMetadata is the AuditLog.metadata of
// updateNewsClassificationSettings: the service writes a subset of the
// normalized settings, not the whole document.
type newsClassificationAuditMetadata struct {
	Enabled         bool    `json:"enabled"`
	StrictFail      bool    `json:"strictFail"`
	EnableLlm       bool    `json:"enableLlm"`
	EnableEmbedding bool    `json:"enableEmbedding"`
	EnableRerank    bool    `json:"enableRerank"`
	TaxonomyVersion string  `json:"taxonomyVersion"`
	TaxonomySize    int     `json:"taxonomySize"`
	MinConfidence   float64 `json:"minConfidence"`
	EmbeddingTopK   int     `json:"embeddingTopK"`
	RerankTopN      int     `json:"rerankTopN"`
}

// updateNewsClassificationSettings mirrors
// NewsClassificationSettingsService.updateSettings: the service validates the
// update before normalizing, and the resolver passes the submitted properties
// through untouched.
func (s *service) updateNewsClassificationSettings(ctx context.Context, identity contract.Identity, input updateNewsClassificationSettingsInput) (settingscrawl.NewsClassificationSettingsModel, error) {
	if err := s.assertAdmin(ctx, identity); err != nil {
		return settingscrawl.NewsClassificationSettingsModel{}, err
	}
	defaults := settingscrawl.DefaultNewsClassificationSettings()
	current, err := s.loadNewsClassification(ctx, identity.OrgID, defaults)
	if err != nil {
		return settingscrawl.NewsClassificationSettingsModel{}, err
	}
	// One pass over the submitted taxonomy both validates it and produces the
	// already-normalized nodes, so path, keyword and synonym normalization
	// never runs twice.
	taxonomy, err := classifyUpdateTaxonomy(input, current)
	if err != nil {
		return settingscrawl.NewsClassificationSettingsModel{}, err
	}

	candidate := newsClassificationCandidate{
		Enabled:         input.Enabled,
		StrictFail:      input.StrictFail,
		EnableLlm:       input.EnableLlm,
		EnableEmbedding: input.EnableEmbedding,
		EnableRerank:    input.EnableRerank,
		MinConfidence:   input.MinConfidence,
		EmbeddingTopK:   input.EmbeddingTopK,
		RerankTopN:      input.RerankTopN,
		CacheTTLSeconds: input.CacheTTLSeconds,
		TaxonomyVersion: input.TaxonomyVersion,
	}
	if input.LlmModelPresent {
		candidate.LlmModel = optionalStringJSON(input.LlmModel)
	}
	// The submitted taxonomy is deliberately left out of the candidate: the
	// validated nodes ARE the final normalized taxonomy, so they are applied to
	// the normalized result below and their path, keyword and synonym
	// normalization runs exactly once.
	raw, err := json.Marshal(candidate)
	if err != nil {
		return settingscrawl.NewsClassificationSettingsModel{}, err
	}
	normalized := settingscrawl.NormalizeNewsClassificationSettings(raw, current)
	if input.TaxonomyPresent {
		normalized.Taxonomy = taxonomy
	}
	payload := mustJSON(newNewsClassificationSettingsDocument(normalized))
	if err := s.upsertOrganizationSetting(ctx, identity, settingKeyNewsClassificationSettingsPrefix,
		"News classification settings (org="+identity.OrgID+")", payload); err != nil {
		return settingscrawl.NewsClassificationSettingsModel{}, err
	}
	s.auditSettingsChange(ctx, identity, "news_classification_settings_update", mustJSON(newsClassificationAuditMetadata{
		Enabled:         normalized.Enabled,
		StrictFail:      normalized.StrictFail,
		EnableLlm:       normalized.EnableLlm,
		EnableEmbedding: normalized.EnableEmbedding,
		EnableRerank:    normalized.EnableRerank,
		TaxonomyVersion: normalized.TaxonomyVersion,
		TaxonomySize:    len(normalized.Taxonomy),
		MinConfidence:   normalized.MinConfidence,
		EmbeddingTopK:   normalized.EmbeddingTopK,
		RerankTopN:      normalized.RerankTopN,
	}))
	s.cacheSettingsDocument(ctx, cacheKeyNewsClassificationPrefix+identity.OrgID, payload, organizationSettingsCacheTTLSeconds)
	return normalized, nil
}

// optionalStringJSON renders an explicit-null aware optional string.
func optionalStringJSON(value *string) json.RawMessage {
	if value == nil {
		return json.RawMessage("null")
	}
	encoded, err := json.Marshal(*value)
	if err != nil {
		return json.RawMessage("null")
	}
	return encoded
}

// loadNewsClassification returns the normalized stored classification setting,
// or the defaults when the row is absent.
func (s *service) loadNewsClassification(ctx context.Context, orgID string, defaults settingscrawl.NewsClassificationSettingsModel) (settingscrawl.NewsClassificationSettingsModel, error) {
	raw, found, err := s.selectSetting(ctx, settingKeyNewsClassificationSettingsPrefix+orgID)
	if err != nil {
		return defaults, err
	}
	if !found {
		return defaults, nil
	}
	return settingscrawl.NormalizeNewsClassificationSettings(raw, defaults), nil
}

// classifyUpdateTaxonomy is validateUpdateInput plus normalizeTaxonomy in one
// pass. It keeps the NestJS validation order, messages and duplicate-path check,
// and returns the nodes already normalized (path, displayName, description,
// legacyCategory, keywords, synonyms), deduplicated and sorted once. A nil
// slice with a nil error means the caller did not submit a taxonomy.
func classifyUpdateTaxonomy(input updateNewsClassificationSettingsInput, current settingscrawl.NewsClassificationSettingsModel) ([]settingscrawl.NewsClassificationTaxonomyNodeModel, error) {
	enabled := boolOr(input.Enabled, current.Enabled)
	enableLlm := boolOr(input.EnableLlm, current.EnableLlm)
	enableEmbedding := boolOr(input.EnableEmbedding, current.EnableEmbedding)
	enableRerank := boolOr(input.EnableRerank, current.EnableRerank)
	if enabled && !enableLlm && !enableEmbedding && !enableRerank {
		return nil, badRequest("At least one classification layer must be enabled when classification is enabled")
	}
	if !input.TaxonomyPresent {
		return nil, nil
	}

	allowed := settingscrawl.AllowedLegacyCategories()
	seenPaths := make(map[string]bool, len(input.Taxonomy))
	nodes := make([]settingscrawl.NewsClassificationTaxonomyNodeModel, 0, len(input.Taxonomy))
	for index, node := range input.Taxonomy {
		position := index + 1
		path, err := assertTaxonomyString(node.Path, 160, "path", position)
		if err != nil {
			return nil, err
		}
		normalizedPath, ok := settingscrawl.NormalizeTaxonomyPath(path)
		if !ok {
			return nil, badRequest(taxonomyMessage(position, "path is invalid"))
		}
		if normalizedPath != path {
			return nil, badRequest(taxonomyMessage(position, "path must be lowercase slash-separated slug format"))
		}
		if seenPaths[normalizedPath] {
			return nil, badRequest(taxonomyMessage(position, "path duplicates an earlier node"))
		}
		seenPaths[normalizedPath] = true

		displayName, err := assertTaxonomyString(node.DisplayName, 500, "displayName", position)
		if err != nil {
			return nil, err
		}
		description, err := assertTaxonomyString(node.Description, 500, "description", position)
		if err != nil {
			return nil, err
		}
		legacyCategory, err := assertTaxonomyString(node.LegacyCategory, 32, "legacyCategory", position)
		if err != nil {
			return nil, err
		}
		if !containsString(allowed, legacyCategory) {
			return nil, badRequest(taxonomyMessage(position, "legacyCategory must be one of politics|tech|finance|gov|ai|intel"))
		}
		if err := assertTaxonomyStringList(node.Keywords, "keywords", position); err != nil {
			return nil, err
		}
		if err := assertTaxonomyStringList(node.Synonyms, "synonyms", position); err != nil {
			return nil, err
		}

		nodes = append(nodes, settingscrawl.NewsClassificationTaxonomyNodeModel{
			Path:           normalizedPath,
			DisplayName:    displayName,
			Description:    description,
			LegacyCategory: legacyCategory,
			Keywords:       settingscrawl.NormalizeTaxonomyStringList(node.Keywords),
			Synonyms:       settingscrawl.NormalizeTaxonomyStringList(node.Synonyms),
		})
	}
	if len(nodes) == 0 {
		return nil, nil
	}
	// The final ordering is computed exactly once. The Go read path sorts by
	// byte order; the service uses localeCompare, which agrees for the lowercase
	// ASCII slug paths this validation allows.
	sort.Slice(nodes, func(i, j int) bool { return nodes[i].Path < nodes[j].Path })
	return nodes, nil
}

// taxonomyMessage renders one service validation message.
func taxonomyMessage(position int, detail string) string {
	return "taxonomy node #" + jsonInt(position) + " " + detail
}

// assertTaxonomyString mirrors assertRequiredString.
func assertTaxonomyString(value string, maxLength int, field string, position int) (string, error) {
	trimmed := jsTrim(value)
	if trimmed == "" {
		return "", badRequest(taxonomyMessage(position, field+" is required"))
	}
	if jsMaxLengthLen(trimmed) > maxLength {
		return "", badRequest(taxonomyMessage(position, field+" exceeds "+jsonInt(maxLength)+" characters"))
	}
	return trimmed, nil
}

// assertTaxonomyStringList mirrors assertStringList.
func assertTaxonomyStringList(values []string, field string, position int) error {
	if len(values) > 50 {
		return badRequest(taxonomyMessage(position, field+" must contain at most 50 entries"))
	}
	for _, entry := range values {
		trimmed := jsTrim(entry)
		if trimmed == "" {
			return badRequest(taxonomyMessage(position, field+" must not contain empty strings"))
		}
		if jsMaxLengthLen(trimmed) > 80 {
			return badRequest(taxonomyMessage(position, field+" entries exceed 80 characters"))
		}
	}
	return nil
}

func containsString(values []string, candidate string) bool {
	for _, value := range values {
		if value == candidate {
			return true
		}
	}
	return false
}

// ---- classification quality ----

// updateClassificationQualitySettings mirrors
// NewsClassificationQualitySettingsService.updateSettings: the service merges
// the submitted properties over the stored setting.
func (s *service) updateClassificationQualitySettings(ctx context.Context, identity contract.Identity, input updateClassificationQualitySettingsInput) (settingscrawl.ClassificationQualitySettingsModel, error) {
	if err := s.assertAdmin(ctx, identity); err != nil {
		return settingscrawl.ClassificationQualitySettingsModel{}, err
	}
	defaults := settingscrawl.DefaultClassificationQualitySettings()
	current, err := s.loadClassificationQuality(ctx, identity.OrgID, defaults)
	if err != nil {
		return settingscrawl.ClassificationQualitySettingsModel{}, err
	}
	candidate, err := json.Marshal(classificationQualityCandidate{
		LowConfidenceThreshold:    input.LowConfidenceThreshold,
		LlmP95LatencyWarnMs:       input.LlmP95LatencyWarnMs,
		EmbeddingP95LatencyWarnMs: input.EmbeddingP95LatencyWarnMs,
		RerankP95LatencyWarnMs:    input.RerankP95LatencyWarnMs,
		GateRejectRateWarn:        input.GateRejectRateWarn,
		GatePenalizedRateWarn:     input.GatePenalizedRateWarn,
		ReportMinPairCount:        input.ReportMinPairCount,
		ReportMinPairErrorRate:    input.ReportMinPairErrorRate,
		CacheTTLSeconds:           input.CacheTTLSeconds,
	})
	if err != nil {
		return settingscrawl.ClassificationQualitySettingsModel{}, err
	}
	normalized := settingscrawl.NormalizeClassificationQualitySettings(candidate, current)
	payload := mustJSON(newClassificationQualitySettingsDocument(normalized))
	if err := s.upsertOrganizationSetting(ctx, identity, settingKeyClassificationQualityPrefix,
		"Classification quality settings (org="+identity.OrgID+")", payload); err != nil {
		return settingscrawl.ClassificationQualitySettingsModel{}, err
	}
	s.auditSettingsChange(ctx, identity, "classification_quality_settings_update", payload)
	s.cacheSettingsDocument(ctx, cacheKeyClassificationQuality+identity.OrgID, payload, organizationSettingsCacheTTLSeconds)
	return normalized, nil
}

// loadClassificationQuality returns the normalized stored classification
// quality setting, or the defaults when the row is absent.
func (s *service) loadClassificationQuality(ctx context.Context, orgID string, defaults settingscrawl.ClassificationQualitySettingsModel) (settingscrawl.ClassificationQualitySettingsModel, error) {
	raw, found, err := s.selectSetting(ctx, settingKeyClassificationQualityPrefix+orgID)
	if err != nil {
		return defaults, err
	}
	if !found {
		return defaults, nil
	}
	return settingscrawl.NormalizeClassificationQualitySettings(raw, defaults), nil
}

// ---- dedupe ----

// newsDedupeAuditMetadata is the AuditLog.metadata of updateNewsDedupeSettings.
type newsDedupeAuditMetadata struct {
	DefaultThreshold               float64 `json:"defaultThreshold"`
	ScopedThresholds               int     `json:"scopedThresholds"`
	UseEmbeddings                  bool    `json:"useEmbeddings"`
	LlmJudgeInstructionsConfigured bool    `json:"llmJudgeInstructionsConfigured"`
	LlmJudgeModelConfigured        bool    `json:"llmJudgeModelConfigured"`
	LlmJudgeConcurrency            int     `json:"llmJudgeConcurrency"`
	LlmJudgeMaxComparisons         int     `json:"llmJudgeMaxComparisons"`
	LlmJudgeCandidateChars         int     `json:"llmJudgeCandidateChars"`
	LlmJudgePromptVersion          string  `json:"llmJudgePromptVersion"`
}

// updateNewsDedupeSettings mirrors NewsDedupeSettingsService.updateSettings
// together with the resolver's `=== undefined` merge for the judge properties.
func (s *service) updateNewsDedupeSettings(ctx context.Context, identity contract.Identity, input updateNewsDedupeSettingsInput) (settingscrawl.NewsDedupeSettingsModel, error) {
	if err := s.assertAdmin(ctx, identity); err != nil {
		return settingscrawl.NewsDedupeSettingsModel{}, err
	}
	defaults := settingscrawl.DefaultNewsDedupeSettings()
	current, err := s.loadNewsDedupe(ctx, identity.OrgID, defaults)
	if err != nil {
		return settingscrawl.NewsDedupeSettingsModel{}, err
	}
	scoped := make([]newsDedupeScopedThresholdDocument, 0, len(input.ScopedThresholds))
	for _, entry := range input.ScopedThresholds {
		scoped = append(scoped, newsDedupeScopedThresholdDocument{
			SourceID:     entry.SourceID,
			Language:     entry.Language,
			CategoryPath: entry.CategoryPath,
			Threshold:    entry.Threshold,
		})
	}
	candidate, err := json.Marshal(newsDedupeCandidate{
		DefaultThreshold:             input.DefaultThreshold,
		ScopedThresholds:             scoped,
		UseEmbeddings:                input.UseEmbeddings,
		LlmJudgeInstructions:         input.LlmJudgeInstructions.or(current.LlmJudgeInstructions),
		LlmJudgeModel:                input.LlmJudgeModel.or(current.LlmJudgeModel),
		LlmJudgeConcurrency:          input.LlmJudgeConcurrency.or(&current.LlmJudgeConcurrency),
		LlmJudgeMaxComparisons:       input.LlmJudgeMaxComparisons.or(&current.LlmJudgeMaxComparisons),
		LlmJudgeCandidateChars:       input.LlmJudgeCandidateChars.or(&current.LlmJudgeCandidateChars),
		LlmJudgePromptVersion:        input.LlmJudgePromptVersion.or(&current.LlmJudgePromptVersion),
		LlmJudgeSystemPromptTemplate: input.LlmJudgeSystemPromptTemplate.or(&current.LlmJudgeSystemPromptTemplate),
		LlmJudgeUserPromptTemplate:   input.LlmJudgeUserPromptTemplate.or(&current.LlmJudgeUserPromptTemplate),
	})
	if err != nil {
		return settingscrawl.NewsDedupeSettingsModel{}, err
	}
	normalized := settingscrawl.NormalizeNewsDedupeSettings(candidate, defaults)
	payload := mustJSON(newNewsDedupeSettingsDocument(normalized))
	if err := s.upsertOrganizationSetting(ctx, identity, settingKeyNewsDedupeSettingsPrefix,
		"News dedupe settings (org="+identity.OrgID+")", payload); err != nil {
		return settingscrawl.NewsDedupeSettingsModel{}, err
	}
	s.auditSettingsChange(ctx, identity, "news_dedupe_settings_update", mustJSON(newsDedupeAuditMetadata{
		DefaultThreshold:               normalized.DefaultThreshold,
		ScopedThresholds:               len(normalized.ScopedThresholds),
		UseEmbeddings:                  normalized.UseEmbeddings,
		LlmJudgeInstructionsConfigured: normalized.LlmJudgeInstructions != nil,
		LlmJudgeModelConfigured:        normalized.LlmJudgeModel != nil,
		LlmJudgeConcurrency:            normalized.LlmJudgeConcurrency,
		LlmJudgeMaxComparisons:         normalized.LlmJudgeMaxComparisons,
		LlmJudgeCandidateChars:         normalized.LlmJudgeCandidateChars,
		LlmJudgePromptVersion:          normalized.LlmJudgePromptVersion,
	}))
	s.cacheSettingsDocument(ctx, cacheKeyNewsDedupePrefix+identity.OrgID, payload, organizationSettingsCacheTTLSeconds)
	return normalized, nil
}

// loadNewsDedupe returns the normalized stored dedupe setting, or the defaults
// when the row is absent.
func (s *service) loadNewsDedupe(ctx context.Context, orgID string, defaults settingscrawl.NewsDedupeSettingsModel) (settingscrawl.NewsDedupeSettingsModel, error) {
	raw, found, err := s.selectSetting(ctx, settingKeyNewsDedupeSettingsPrefix+orgID)
	if err != nil {
		return defaults, err
	}
	if !found {
		return defaults, nil
	}
	return settingscrawl.NormalizeNewsDedupeSettings(raw, defaults), nil
}

// ---- extraction ----

// updateNewsExtractionSettings mirrors
// NewsExtractionSettingsService.updateSettings: the service keeps its own
// default normalization and never merges the stored setting.
func (s *service) updateNewsExtractionSettings(ctx context.Context, identity contract.Identity, input updateNewsExtractionSettingsInput) (settingscrawl.NewsExtractionSettingsModel, error) {
	if err := s.assertAdmin(ctx, identity); err != nil {
		return settingscrawl.NewsExtractionSettingsModel{}, err
	}
	candidate := newsExtractionCandidate{PipelineMode: input.PipelineMode}
	if input.PreflightGate != nil {
		candidate.PreflightGate = &newsExtractionCandidatePreflightGate{
			Enabled:            input.PreflightGate.Enabled,
			MinWordCount:       input.PreflightGate.MinWordCount,
			MinQualityScore:    input.PreflightGate.MinQualityScore,
			RejectBotChallenge: input.PreflightGate.RejectBotChallenge,
			RejectListLike:     input.PreflightGate.RejectListLike,
		}
	}
	if input.PostCleanGate != nil {
		candidate.PostCleanGate = &newsExtractionCandidatePostCleanGate{
			Enabled:         input.PostCleanGate.Enabled,
			MinQualityScore: input.PostCleanGate.MinQualityScore,
			MinCleanedChars: input.PostCleanGate.MinCleanedChars,
			RequireSummary:  input.PostCleanGate.RequireSummary,
		}
	}
	if input.Capabilities != nil {
		candidate.Capabilities = &newsExtractionCandidateCapabilities{
			Entities:  input.Capabilities.Entities,
			Sentiment: input.Capabilities.Sentiment,
			Kg:        input.Capabilities.Kg,
		}
	}
	if input.Providers != nil {
		candidate.Providers = &newsExtractionCandidateProviders{
			Clean:     input.Providers.Clean,
			Entities:  input.Providers.Entities,
			Sentiment: input.Providers.Sentiment,
			Kg:        input.Providers.Kg,
		}
	}
	raw, err := json.Marshal(candidate)
	if err != nil {
		return settingscrawl.NewsExtractionSettingsModel{}, err
	}
	normalized := settingscrawl.NormalizeNewsExtractionSettings(raw, settingscrawl.DefaultNewsExtractionSettings())
	payload := mustJSON(newNewsExtractionSettingsDocument(normalized))
	if err := s.upsertOrganizationSetting(ctx, identity, settingKeyNewsExtractionSettingsPrefix,
		"News extraction settings (org="+identity.OrgID+")", payload); err != nil {
		return settingscrawl.NewsExtractionSettingsModel{}, err
	}
	s.auditSettingsChange(ctx, identity, "news_extraction_settings_update", payload)
	s.cacheSettingsDocument(ctx, cacheKeyNewsExtractionPrefix+identity.OrgID, payload, organizationSettingsCacheTTLSeconds)
	return normalized, nil
}

// ---- prompt config ----

// newsPromptAuditMetadata is the AuditLog.metadata of updateNewsPromptConfig.
type newsPromptAuditMetadata struct {
	Version string `json:"version"`
}

// updateNewsPromptConfig mirrors NewsPromptConfigService.updateConfig: the full
// configuration is normalized against DEFAULT_NEWS_PROMPT_CONFIG and the
// denoise template is reset to its built-in default, because the GraphQL input
// has no such property. There is no Redis cache for this domain.
func (s *service) updateNewsPromptConfig(ctx context.Context, identity contract.Identity, input updateNewsPromptConfigInput) (settingscrawl.NewsPromptConfigModel, error) {
	if err := s.assertAdmin(ctx, identity); err != nil {
		return settingscrawl.NewsPromptConfigModel{}, err
	}
	candidate, err := json.Marshal(newsPromptCandidate{
		Version:                       input.Version,
		SystemPromptTemplate:          input.SystemPromptTemplate,
		UserPromptTemplate:            input.UserPromptTemplate,
		EntitySystemPromptTemplate:    input.EntitySystemPromptTemplate,
		EntityUserPromptTemplate:      input.EntityUserPromptTemplate,
		SentimentSystemPromptTemplate: input.SentimentSystemPromptTemplate,
		SentimentUserPromptTemplate:   input.SentimentUserPromptTemplate,
		KgSystemPromptTemplate:        input.KgSystemPromptTemplate,
		KgUserPromptTemplate:          input.KgUserPromptTemplate,
	})
	if err != nil {
		return settingscrawl.NewsPromptConfigModel{}, err
	}
	normalized := settingscrawl.NormalizeNewsPromptConfigDocument(candidate, settingscrawl.DefaultNewsPromptConfig())
	document := newsPromptConfigDocument{
		Version:                       normalized.Version,
		SystemPromptTemplate:          normalized.SystemPromptTemplate,
		DenoisePromptTemplate:         settingscrawl.DefaultNewsPromptDenoiseTemplate(),
		UserPromptTemplate:            normalized.UserPromptTemplate,
		EntitySystemPromptTemplate:    normalized.EntitySystemPromptTemplate,
		EntityUserPromptTemplate:      normalized.EntityUserPromptTemplate,
		SentimentSystemPromptTemplate: normalized.SentimentSystemPromptTemplate,
		SentimentUserPromptTemplate:   normalized.SentimentUserPromptTemplate,
		KgSystemPromptTemplate:        normalized.KgSystemPromptTemplate,
		KgUserPromptTemplate:          normalized.KgUserPromptTemplate,
	}
	payload := mustJSON(document)
	description := "Configurable prompt templates for the news cleaning pipeline."
	if err := s.upsertSettingForceDescription(ctx, settingKeyNewsPromptConfig, payload, description, nullableActorID(identity.UserID)); err != nil {
		return settingscrawl.NewsPromptConfigModel{}, err
	}
	writeAuditLogBestEffort(s.db, ctx, identity.OrgID, identity.UserID, "news_pipeline_prompt", "update",
		newsPromptAuditMetadata{Version: normalized.Version})
	return normalized, nil
}

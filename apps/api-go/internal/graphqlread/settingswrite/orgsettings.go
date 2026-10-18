package settingswrite

import (
	"context"
	"encoding/json"

	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/contract"
	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/settingscrawl"
)

// This file holds the four per-organization settings writes whose optional
// input properties the resolver merges with the stored setting, plus the
// required-field-only entity impact and news indicator writes.

func (s *service) updateEntityImpactGraphSettingsResolver(ctx contract.Context) (settingscrawl.EntityImpactGraphSettingsModel, error) {
	input, err := parseUpdateEntityImpactGraphSettingsInput(ctx.Args)
	if err == nil {
		var model settingscrawl.EntityImpactGraphSettingsModel
		if model, err = s.updateEntityImpactGraphSettings(callContext(ctx), ctx.Identity, input); err == nil {
			return model, nil
		}
	}
	return settingscrawl.EntityImpactGraphSettingsModel{}, graphqlFailure(err)
}

func (s *service) updateKnowledgeGraphSettingsResolver(ctx contract.Context) (settingscrawl.KnowledgeGraphSettingsModel, error) {
	input, err := parseUpdateKnowledgeGraphSettingsInput(ctx.Args)
	if err == nil {
		var model settingscrawl.KnowledgeGraphSettingsModel
		if model, err = s.updateKnowledgeGraphSettings(callContext(ctx), ctx.Identity, input); err == nil {
			return model, nil
		}
	}
	return settingscrawl.KnowledgeGraphSettingsModel{}, graphqlFailure(err)
}

func (s *service) updateNewsEventSettingsResolver(ctx contract.Context) (settingscrawl.NewsEventSettingsModel, error) {
	input, err := parseUpdateNewsEventSettingsInput(ctx.Args)
	if err == nil {
		var model settingscrawl.NewsEventSettingsModel
		if model, err = s.updateNewsEventSettings(callContext(ctx), ctx.Identity, input); err == nil {
			return model, nil
		}
	}
	return settingscrawl.NewsEventSettingsModel{}, graphqlFailure(err)
}

func (s *service) updateNewsIndicatorSettingsResolver(ctx contract.Context) (settingscrawl.NewsIndicatorSettingsModel, error) {
	input, err := parseUpdateNewsIndicatorSettingsInput(ctx.Args)
	if err == nil {
		var model settingscrawl.NewsIndicatorSettingsModel
		if model, err = s.updateNewsIndicatorSettings(callContext(ctx), ctx.Identity, input); err == nil {
			return model, nil
		}
	}
	return settingscrawl.NewsIndicatorSettingsModel{}, graphqlFailure(err)
}

// updateEntityImpactGraphSettings mirrors
// EntityImpactGraphSettingsService.updateSettings: every field is required, so
// the normalized result depends only on the submitted input.
func (s *service) updateEntityImpactGraphSettings(ctx context.Context, identity contract.Identity, input updateEntityImpactGraphSettingsInput) (settingscrawl.EntityImpactGraphSettingsModel, error) {
	if err := s.assertAdmin(ctx, identity); err != nil {
		return settingscrawl.EntityImpactGraphSettingsModel{}, err
	}
	defaults := settingscrawl.DefaultEntityImpactGraphSettings()
	candidate, err := json.Marshal(entityImpactGraphCandidate{
		Enabled:             input.Enabled,
		MinEntityConfidence: input.MinEntityConfidence,
		MinCorrelation:      input.MinCorrelation,
		MinCoOccurrence:     input.MinCoOccurrence,
		MaxNodes:            input.MaxNodes,
		Categories:          input.Categories,
		CacheTTLSeconds:     input.CacheTTLSeconds,
	})
	if err != nil {
		return settingscrawl.EntityImpactGraphSettingsModel{}, err
	}
	normalized := settingscrawl.NormalizeEntityImpactGraphSettings(candidate, defaults)
	payload := mustJSON(newEntityImpactGraphSettingsDocument(normalized))
	if err := s.upsertOrganizationSetting(ctx, identity, settingKeyEntityImpactGraphSettingsPrefix,
		"Entity impact graph settings (org="+identity.OrgID+")", payload); err != nil {
		return settingscrawl.EntityImpactGraphSettingsModel{}, err
	}
	s.auditSettingsChange(ctx, identity, "entity_impact_graph_settings_update", payload)
	s.cacheSettingsDocument(ctx, cacheKeyEntityImpactGraphPrefix+identity.OrgID, payload, organizationSettingsCacheTTLSeconds)
	return normalized, nil
}

// updateKnowledgeGraphSettings mirrors KnowledgeGraphSettingsService.updateSettings
// together with the resolver's `input.x ?? current.x` merges.
func (s *service) updateKnowledgeGraphSettings(ctx context.Context, identity contract.Identity, input updateKnowledgeGraphSettingsInput) (settingscrawl.KnowledgeGraphSettingsModel, error) {
	if err := s.assertAdmin(ctx, identity); err != nil {
		return settingscrawl.KnowledgeGraphSettingsModel{}, err
	}
	defaults := settingscrawl.DefaultKnowledgeGraphSettings()
	current, err := s.loadKnowledgeGraph(ctx, identity.OrgID, defaults)
	if err != nil {
		return settingscrawl.KnowledgeGraphSettingsModel{}, err
	}
	candidate, err := json.Marshal(knowledgeGraphCandidate{
		Enabled:                                    input.Enabled,
		IngestionEnabled:                           input.IngestionEnabled,
		MaxBatchSize:                               input.MaxBatchSize,
		MaxRelationsPerArticle:                     input.MaxRelationsPerArticle,
		MinEdgeConfidence:                          float64Or(input.MinEdgeConfidence, current.MinEdgeConfidence),
		DynamicEdgeConfidenceEnabled:               boolOr(input.DynamicEdgeConfidenceEnabled, current.DynamicEdgeConfidenceEnabled),
		DynamicEdgeConfidenceQuantile:              float64Or(input.DynamicEdgeConfidenceQuantile, current.DynamicEdgeConfidenceQuantile),
		MultiModelValidationEnabled:                boolOr(input.MultiModelValidationEnabled, current.MultiModelValidationEnabled),
		MultiModelValidationModels:                 stringsOrNil(input.MultiModelValidationModels, current.MultiModelValidationModels),
		MultiModelValidationModelCount:             intOr(input.MultiModelValidationModelCount, current.MultiModelValidationModelCount),
		MultiModelValidationMaxRelationsPerArticle: intOr(input.MultiModelValidationMaxRelationsPerArticle, current.MultiModelValidationMaxRelationsPerArticle),
		EntityDisambiguationEnabled:                boolOr(input.EntityDisambiguationEnabled, current.EntityDisambiguationEnabled),
		EntityDisambiguationMaxCandidates:          intOr(input.EntityDisambiguationMaxCandidates, current.EntityDisambiguationMaxCandidates),
		CacheTTLSeconds:                            input.CacheTTLSeconds,
	})
	if err != nil {
		return settingscrawl.KnowledgeGraphSettingsModel{}, err
	}
	normalized := settingscrawl.NormalizeKnowledgeGraphSettings(candidate, defaults)
	payload := mustJSON(newKnowledgeGraphSettingsDocument(normalized))
	if err := s.upsertOrganizationSetting(ctx, identity, settingKeyKnowledgeGraphSettingsPrefix,
		"Knowledge graph settings (org="+identity.OrgID+")", payload); err != nil {
		return settingscrawl.KnowledgeGraphSettingsModel{}, err
	}
	s.auditSettingsChange(ctx, identity, "knowledge_graph_settings_update", payload)
	s.cacheSettingsDocument(ctx, cacheKeyKnowledgeGraphPrefix+identity.OrgID, payload, organizationSettingsCacheTTLSeconds)
	return normalized, nil
}

// updateNewsEventSettings mirrors NewsEventsSettingsService.updateSettings
// together with the resolver's `input.x ?? current.x` merges.
func (s *service) updateNewsEventSettings(ctx context.Context, identity contract.Identity, input updateNewsEventSettingsInput) (settingscrawl.NewsEventSettingsModel, error) {
	if err := s.assertAdmin(ctx, identity); err != nil {
		return settingscrawl.NewsEventSettingsModel{}, err
	}
	defaults := settingscrawl.DefaultNewsEventSettings()
	current, err := s.loadNewsEvent(ctx, identity.OrgID, defaults)
	if err != nil {
		return settingscrawl.NewsEventSettingsModel{}, err
	}
	candidate, err := json.Marshal(newsEventCandidate{
		Enabled:                               input.Enabled,
		IngestionEnabled:                      input.IngestionEnabled,
		TimelineEnabled:                       input.TimelineEnabled,
		ClusteringMode:                        stringOr(input.ClusteringMode, string(current.ClusteringMode)),
		BertopicMinItemsPerGroup:              intOr(input.BertopicMinItemsPerGroup, current.BertopicMinItemsPerGroup),
		BertopicMaxItemsPerRequest:            intOr(input.BertopicMaxItemsPerRequest, current.BertopicMaxItemsPerRequest),
		BertopicMinTopicSize:                  intOr(input.BertopicMinTopicSize, current.BertopicMinTopicSize),
		ForceAuthoritativeMode:                boolOr(input.ForceAuthoritativeMode, current.ForceAuthoritativeMode),
		ForceMinAuthoritativeSources:          intOr(input.ForceMinAuthoritativeSources, current.ForceMinAuthoritativeSources),
		MaxBatchSize:                          input.MaxBatchSize,
		BackfillDays:                          input.BackfillDays,
		LookbackDays:                          input.LookbackDays,
		TimelineMaxEventsPerRun:               input.TimelineMaxEventsPerRun,
		VectorMinScore:                        input.VectorMinScore,
		CrossLanguagePenalty:                  input.CrossLanguagePenalty,
		ClassificationGateEnabled:             boolOr(input.ClassificationGateEnabled, current.ClassificationGateEnabled),
		CategoryConflictReject:                boolOr(input.CategoryConflictReject, current.CategoryConflictReject),
		CategorySoftPenalty:                   float64Or(input.CategorySoftPenalty, current.CategorySoftPenalty),
		MinCategoryConfidenceForGate:          float64Or(input.MinCategoryConfidenceForGate, current.MinCategoryConfidenceForGate),
		TimelineLowConfidenceThreshold:        float64Or(input.TimelineLowConfidenceThreshold, current.TimelineLowConfidenceThreshold),
		TimelineHighConfidenceThreshold:       float64Or(input.TimelineHighConfidenceThreshold, current.TimelineHighConfidenceThreshold),
		TimelineDriftKlThreshold:              float64Or(input.TimelineDriftKlThreshold, current.TimelineDriftKlThreshold),
		TimelineMinBucketItemsForDrift:        intOr(input.TimelineMinBucketItemsForDrift, current.TimelineMinBucketItemsForDrift),
		TimelineCrossCategoryWarningShare:     float64Or(input.TimelineCrossCategoryWarningShare, current.TimelineCrossCategoryWarningShare),
		TimelineMaxCategoryDistributionItems:  intOr(input.TimelineMaxCategoryDistributionItems, current.TimelineMaxCategoryDistributionItems),
		TimelineMaxPhaseSummaries:             intOr(input.TimelineMaxPhaseSummaries, current.TimelineMaxPhaseSummaries),
		TimelinePresetCustomDistanceThreshold: float64Or(input.TimelinePresetCustomDistanceThreshold, current.TimelinePresetCustomDistanceThreshold),
		CacheTTLSeconds:                       input.CacheTTLSeconds,
	})
	if err != nil {
		return settingscrawl.NewsEventSettingsModel{}, err
	}
	normalized := settingscrawl.NormalizeNewsEventSettings(candidate, defaults)
	payload := mustJSON(newNewsEventSettingsDocument(normalized))
	if err := s.upsertOrganizationSetting(ctx, identity, settingKeyNewsEventSettingsPrefix,
		"News event settings (org="+identity.OrgID+")", payload); err != nil {
		return settingscrawl.NewsEventSettingsModel{}, err
	}
	s.auditSettingsChange(ctx, identity, "news_event_settings_update", payload)
	s.cacheSettingsDocument(ctx, cacheKeyNewsEventsPrefix+identity.OrgID, payload, organizationSettingsCacheTTLSeconds)
	return normalized, nil
}

// updateNewsIndicatorSettings mirrors
// NewsIndicatorSettingsService.updateSettings: every field is required.
func (s *service) updateNewsIndicatorSettings(ctx context.Context, identity contract.Identity, input updateNewsIndicatorSettingsInput) (settingscrawl.NewsIndicatorSettingsModel, error) {
	if err := s.assertAdmin(ctx, identity); err != nil {
		return settingscrawl.NewsIndicatorSettingsModel{}, err
	}
	defaults := settingscrawl.DefaultNewsIndicatorSettings()
	candidate, err := json.Marshal(newsIndicatorCandidate{
		Enabled:                     input.Enabled,
		IngestionEnabled:            input.IngestionEnabled,
		WindowDays:                  input.WindowDays,
		MaxLagDays:                  input.MaxLagDays,
		MinSampleSize:               input.MinSampleSize,
		MinAbsCorrelation:           input.MinAbsCorrelation,
		MaxPValue:                   input.MaxPValue,
		TopEntities:                 input.TopEntities,
		TopTopics:                   input.TopTopics,
		MaxAssociationsPerIndicator: input.MaxAssociationsPerIndicator,
		IndicatorSlugs:              input.IndicatorSlugs,
		BacktestTriggerZScore:       input.BacktestTriggerZScore,
		BacktestBaselineDays:        input.BacktestBaselineDays,
		BacktestHoldoutDays:         input.BacktestHoldoutDays,
		CacheTTLSeconds:             input.CacheTTLSeconds,
	})
	if err != nil {
		return settingscrawl.NewsIndicatorSettingsModel{}, err
	}
	normalized := settingscrawl.NormalizeNewsIndicatorSettings(candidate, defaults)
	payload := mustJSON(newNewsIndicatorSettingsDocument(normalized))
	if err := s.upsertOrganizationSetting(ctx, identity, settingKeyNewsIndicatorSettingsPrefix,
		"News indicator association settings (org="+identity.OrgID+")", payload); err != nil {
		return settingscrawl.NewsIndicatorSettingsModel{}, err
	}
	s.auditSettingsChange(ctx, identity, "news_indicator_settings_update", payload)
	s.cacheSettingsDocument(ctx, cacheKeyNewsIndicatorPrefix+identity.OrgID, payload, organizationSettingsCacheTTLSeconds)
	return normalized, nil
}

// ---- loaders ----

// loadKnowledgeGraph returns the normalized stored knowledge graph setting, or
// the defaults when the row is absent.
func (s *service) loadKnowledgeGraph(ctx context.Context, orgID string, defaults settingscrawl.KnowledgeGraphSettingsModel) (settingscrawl.KnowledgeGraphSettingsModel, error) {
	raw, found, err := s.selectSetting(ctx, settingKeyKnowledgeGraphSettingsPrefix+orgID)
	if err != nil {
		return defaults, err
	}
	if !found {
		return defaults, nil
	}
	return settingscrawl.NormalizeKnowledgeGraphSettings(raw, defaults), nil
}

// loadNewsEvent returns the normalized stored news event setting, or the
// defaults when the row is absent.
func (s *service) loadNewsEvent(ctx context.Context, orgID string, defaults settingscrawl.NewsEventSettingsModel) (settingscrawl.NewsEventSettingsModel, error) {
	raw, found, err := s.selectSetting(ctx, settingKeyNewsEventSettingsPrefix+orgID)
	if err != nil {
		return defaults, err
	}
	if !found {
		return defaults, nil
	}
	return settingscrawl.NormalizeNewsEventSettings(raw, defaults), nil
}

// upsertOrganizationSetting persists one organization settings document.
func (s *service) upsertOrganizationSetting(ctx context.Context, identity contract.Identity, keyPrefix, description string, payload json.RawMessage) error {
	return s.upsertSettingForceDescription(ctx, keyPrefix+identity.OrgID, payload, description, nullableActorID(identity.UserID))
}

// ---- tri-state merge helpers ----
//
// Each helper mirrors the resolver's `input.x ?? current.x`: an absent or null
// input keeps the stored value.

func boolOr(value *bool, fallback bool) bool {
	if value == nil {
		return fallback
	}
	return *value
}

func intOr(value *int, fallback int) int {
	if value == nil {
		return fallback
	}
	return *value
}

func float64Or(value *float64, fallback float64) float64 {
	if value == nil {
		return fallback
	}
	return *value
}

func stringOr(value *string, fallback string) string {
	if value == nil {
		return fallback
	}
	return *value
}

func stringsOrNil(value *[]string, fallback []string) []string {
	if value == nil {
		return fallback
	}
	return *value
}

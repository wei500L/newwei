package newspipeline

import (
	"context"
	"encoding/json"
	"strings"

	"github.com/wei500L/newwei/apps/api-go/internal/newsclassifier"
)

// This file ports processLegacyPipeline, processStagedPipeline,
// runIndependentEnrichmentStages and runClassificationStage.
//
// Stage order and the legacy/staged split are identical to the TypeScript source:
//
//	legacy: clean ("llm") -> classify -> dedupe -> persist
//	staged: preflight gate -> clean -> post-clean quality gate ->
//	        entities -> sentiment -> kg -> classify -> dedupe -> persist
//
// A rejected gate never throws: it persists the gate-rejected result with
// skipped stage_meta entries. An individual enrichment failure never aborts: the
// stage records failed, the output becomes []/null/[] and the failure is written
// to TaskLog. A persist failure after the dedupe mark rolls the Duplicate mark
// back and rethrows.

// processLegacyPipeline is processLegacyPipeline.
func (s *Service) processLegacyPipeline(ctx context.Context, job Job, raw RawItem, payload NormalizedPayload, article ArticleWithCache) (ProcessResult, error) {
	cleanResult, err := pipelineRunStage(s, ctx, job, "llm", func() (CleanResult, error) {
		// The legacy call site omits the provider argument, so cleanArticle's
		// default "llm" is used.
		return s.cleaner.CleanArticle(ctx, payload, article.CrawledArticle, job, "llm")
	}, func() any {
		return pipelineStageFailureURLRunID{URL: payload.URL, RunID: article.RunID}
	})
	if err != nil {
		return ProcessResult{}, err
	}

	cleaned := cleanResult.Cleaned
	if s.classifier != nil {
		classification, err := pipelineRunStage(s, ctx, job, "classify", func() (newsclassifier.Result, error) {
			classifierInput, err := pipelineClassifierInput(cleaned)
			if err != nil {
				return newsclassifier.Result{}, err
			}
			return s.classifier.Classify(ctx, job.OrgID, classifierInput, s.classificationOptions(job, payload, article.CrawledArticle, cleaned))
		}, func() any {
			return pipelineStageFailureItemMeta{ItemMetaID: job.ItemMetaID}
		})
		if err != nil {
			return ProcessResult{}, err
		}
		cleaned, err = pipelineApplyClassification(cleaned, classification)
		if err != nil {
			return ProcessResult{}, err
		}
	}

	dedupe, err := pipelineRunStage(s, ctx, job, "dedupe", func() (DedupeResult, error) {
		return s.deduper.EvaluateSummaryDedupe(ctx, DedupeInput{
			Job:                job,
			Payload:            payload,
			Cleaned:            cleaned,
			ContentDuplicateOf: cleanResult.ContentDuplicateOf,
		})
	}, nil)
	if err != nil {
		return ProcessResult{}, err
	}

	result, err := pipelineRunStage(s, ctx, job, "persist", func() (PersistResult, error) {
		return s.persistProcessedResult(ctx, pipelinePersistOptions{
			Job:                   job,
			Raw:                   raw,
			Payload:               payload,
			Article:               article.CrawledArticle,
			Cleaned:               cleaned,
			LLM:                   cleanResult.LLM,
			ContentHash:           cleanResult.ContentHash,
			ProcessedArticleID:    cleanResult.ProcessedArticleID,
			ArticleMetadataPatch:  cleanResult.ArticleMetadataPatch,
			SummaryEmbedding:      dedupe.SummaryEmbedding,
			SummaryEmbeddingModel: dedupe.SummaryEmbeddingModel,
			DuplicateOf:           dedupe.DuplicateOf,
			DuplicateSimilarity:   dedupe.DuplicateSimilarity,
		})
	}, func() any {
		return pipelineStageFailureRawItemMeta{RawItemID: raw.ID, ItemMetaID: job.ItemMetaID}
	})
	if err != nil {
		// The dedupe stage already marked the item Duplicate; if persist fails
		// the item must not stay Duplicate with no processed document.
		s.revertDuplicateMarkOnPersistFailure(ctx, job, dedupe.DuplicateOf)
		return ProcessResult{}, err
	}
	return result, nil
}

// processStagedPipeline is processStagedPipeline.
func (s *Service) processStagedPipeline(ctx context.Context, job Job, raw RawItem, payload NormalizedPayload, article ArticleWithCache, settings ExtractionSettings) (ProcessResult, error) {
	preflight := evaluatePreflightGate(article.CrawledArticle, settings)
	persistErrorData := func() any {
		return pipelineStageFailureRawItemMeta{RawItemID: raw.ID, ItemMetaID: job.ItemMetaID}
	}

	if preflight.rejected {
		reason := "preflight_rejected"
		if preflight.reason != nil {
			reason = *preflight.reason
		}
		stageMeta := &StageMeta{
			Preflight:   NewStageMetaEntryWithReason("rejected", stringPointer("rules"), reason),
			Clean:       NewStageMetaEntryWithReason("skipped", stringPointer("llm"), "preflight_rejected"),
			QualityGate: NewStageMetaEntryWithReason("skipped", stringPointer("rules"), "preflight_rejected"),
			Entities:    NewStageMetaEntryWithReason("skipped", &settings.Providers.Entities, "preflight_rejected"),
			Sentiment:   NewStageMetaEntryWithReason("skipped", &settings.Providers.Sentiment, "preflight_rejected"),
			KG:          NewStageMetaEntryWithReason("skipped", &settings.Providers.KG, "preflight_rejected"),
			Classify:    NewStageMetaEntryWithReason("skipped", stringPointer("classifier"), "preflight_rejected"),
			Dedupe:      NewStageMetaEntryWithReason("skipped", stringPointer("dedupe"), "preflight_rejected"),
		}
		cleaned := buildGateRejectedCleanedNews(article.CrawledArticle, payload, reason, stageMeta, s.config.MaxInputChars)
		s.recordStageOutcome(ctx, job, "preflight", stageMeta.Preflight, &pipelineStageOutcomeData{
			Reason:                    stringPointer(reason),
			PreflightQualityScore:     preflight.qualityScore,
			PreflightQualityThreshold: preflight.qualityThreshold,
		})

		contentHash := article.ContentHash
		if contentHash == "" {
			contentHash = hashContent(article.Markdown)
		}
		patch, err := pipelineExtractionPatch(PipelineModeStaged, true, stringPointer(reason), preflight.qualityScore)
		if err != nil {
			return ProcessResult{}, err
		}
		return pipelineRunStage(s, ctx, job, "persist", func() (PersistResult, error) {
			return s.persistProcessedResult(ctx, pipelinePersistOptions{
				Job:                  job,
				Raw:                  raw,
				Payload:              payload,
				Article:              article.CrawledArticle,
				Cleaned:              cleaned,
				LLM:                  EmptyLLMMetadata(),
				ContentHash:          contentHash,
				ArticleMetadataPatch: patch,
			})
		}, persistErrorData)
	}

	var preflightData *pipelineStageOutcomeData
	if preflight.qualityScore != nil || preflight.qualityThreshold != nil {
		preflightData = &pipelineStageOutcomeData{
			PreflightQualityScore:     preflight.qualityScore,
			PreflightQualityThreshold: preflight.qualityThreshold,
		}
	}
	s.recordStageOutcome(ctx, job, "preflight", NewStageMetaEntry("completed", stringPointer("rules")), preflightData)

	cleanResult, err := pipelineRunStage(s, ctx, job, "clean", func() (CleanResult, error) {
		return s.cleaner.CleanArticle(ctx, payload, article.CrawledArticle, job, settings.Providers.Clean)
	}, func() any {
		return pipelineStageFailureURLRunID{URL: payload.URL, RunID: article.RunID}
	})
	if err != nil {
		return ProcessResult{}, err
	}
	llm := cleanResult.LLM

	stagedCleaned := stripEnrichmentFields(cleanResult.Cleaned)
	cleanProvider := "processed_cache"
	if llm.Model != nil {
		cleanProvider = "llm"
	}
	cleanEntry := NewStageMetaEntry("completed", &cleanProvider)
	cleanEntry.Model = llm.Model
	cleanEntry.PromptVersion = llm.PromptVersion
	cleanEntry.PromptTokens = llm.PromptTokens
	cleanEntry.CompletionTokens = llm.CompletionTokens
	cleanEntry.TotalTokens = llm.TotalTokens
	cleanEntry.CostUSD = llm.CostUSD
	cleanEntry.LatencyMS = llm.LatencyMS
	stageMeta := &StageMeta{
		Preflight: NewStageMetaEntry("completed", stringPointer("rules")),
		Clean:     cleanEntry,
	}
	stagedCleaned.StageMeta = stageMeta
	s.recordStageOutcome(ctx, job, "clean", cleanEntry, nil)

	qualityGate := evaluatePostCleanGate(stagedCleaned, settings)
	qualityGateStatus := "completed"
	if qualityGate.rejected {
		qualityGateStatus = "rejected"
	}
	qualityGateEntry := NewStageMetaEntry(qualityGateStatus, stringPointer("rules"))
	qualityGateEntry.Reason = qualityGate.reason
	stageMeta.QualityGate = qualityGateEntry
	var qualityGateData *pipelineStageOutcomeData
	if qualityGate.reason != nil {
		qualityGateData = &pipelineStageOutcomeData{Reason: qualityGate.reason}
	}
	s.recordStageOutcome(ctx, job, "quality_gate", qualityGateEntry, qualityGateData)

	if qualityGate.rejected {
		reason := "quality_gate_rejected"
		if qualityGate.reason != nil {
			reason = *qualityGate.reason
		}
		stageMeta.Entities = NewStageMetaEntryWithReason("skipped", &settings.Providers.Entities, reason)
		stageMeta.Sentiment = NewStageMetaEntryWithReason("skipped", &settings.Providers.Sentiment, reason)
		stageMeta.KG = NewStageMetaEntryWithReason("skipped", &settings.Providers.KG, reason)
		stageMeta.Classify = NewStageMetaEntryWithReason("skipped", stringPointer("classifier"), reason)
		stageMeta.Dedupe = NewStageMetaEntryWithReason("skipped", stringPointer("dedupe"), reason)
		s.recordStageOutcome(ctx, job, "extract_entities", stageMeta.Entities, nil)
		s.recordStageOutcome(ctx, job, "extract_sentiment", stageMeta.Sentiment, nil)
		s.recordStageOutcome(ctx, job, "extract_kg", stageMeta.KG, nil)
		s.recordStageOutcome(ctx, job, "classify", stageMeta.Classify, nil)
		s.recordStageOutcome(ctx, job, "dedupe", stageMeta.Dedupe, nil)

		patch, err := pipelineExtractionPatchWithBase(cleanResult.ArticleMetadataPatch, PipelineModeStaged, true, stringPointer(reason), preflight.qualityScore)
		if err != nil {
			return ProcessResult{}, err
		}
		return pipelineRunStage(s, ctx, job, "persist", func() (PersistResult, error) {
			return s.persistProcessedResult(ctx, pipelinePersistOptions{
				Job:                  job,
				Raw:                  raw,
				Payload:              payload,
				Article:              article.CrawledArticle,
				Cleaned:              stagedCleaned,
				LLM:                  llm,
				ContentHash:          cleanResult.ContentHash,
				ProcessedArticleID:   cleanResult.ProcessedArticleID,
				ArticleMetadataPatch: patch,
			})
		}, persistErrorData)
	}

	stagedCleaned = s.runIndependentEnrichmentStages(ctx, job, payload, article.CrawledArticle, stagedCleaned, settings)

	classified, err := s.runClassificationStage(ctx, job, payload, article.CrawledArticle, stagedCleaned)
	if err != nil {
		return ProcessResult{}, err
	}
	stagedCleaned = classified

	dedupe, err := pipelineRunStage(s, ctx, job, "dedupe", func() (DedupeResult, error) {
		return s.deduper.EvaluateSummaryDedupe(ctx, DedupeInput{
			Job:                job,
			Payload:            payload,
			Cleaned:            stagedCleaned,
			ContentDuplicateOf: cleanResult.ContentDuplicateOf,
		})
	}, nil)
	if err != nil {
		return ProcessResult{}, err
	}
	dedupeEntry := NewStageMetaEntry("completed", stringPointer("dedupe"))
	if dedupe.DuplicateOf != nil && dedupe.DuplicateSimilarity != nil {
		dedupeEntry.Reason = stringPointer("duplicate:" + *dedupe.DuplicateOf)
	}
	stageMeta = stagedCleaned.StageMeta
	if stageMeta == nil {
		stageMeta = &StageMeta{}
		stagedCleaned.StageMeta = stageMeta
	}
	stageMeta.Dedupe = dedupeEntry
	s.recordStageOutcome(ctx, job, "dedupe", dedupeEntry, nil)

	patch, err := pipelineExtractionPatchWithBase(cleanResult.ArticleMetadataPatch, PipelineModeStaged, false, nil, preflight.qualityScore)
	if err != nil {
		return ProcessResult{}, err
	}
	result, err := pipelineRunStage(s, ctx, job, "persist", func() (PersistResult, error) {
		return s.persistProcessedResult(ctx, pipelinePersistOptions{
			Job:                   job,
			Raw:                   raw,
			Payload:               payload,
			Article:               article.CrawledArticle,
			Cleaned:               stagedCleaned,
			LLM:                   llm,
			ContentHash:           cleanResult.ContentHash,
			ProcessedArticleID:    cleanResult.ProcessedArticleID,
			ArticleMetadataPatch:  patch,
			SummaryEmbedding:      dedupe.SummaryEmbedding,
			SummaryEmbeddingModel: dedupe.SummaryEmbeddingModel,
			DuplicateOf:           dedupe.DuplicateOf,
			DuplicateSimilarity:   dedupe.DuplicateSimilarity,
		})
	}, persistErrorData)
	if err != nil {
		// The dedupe stage already marked the item Duplicate; if persist fails
		// the item must not stay Duplicate with no processed document.
		s.revertDuplicateMarkOnPersistFailure(ctx, job, dedupe.DuplicateOf)
		return ProcessResult{}, err
	}
	return result, nil
}

// runIndependentEnrichmentStages is runIndependentEnrichmentStages: entities,
// sentiment and kg are independent, failures are contained and recorded, and
// the returned cleaned news carries the stage_meta entries.
func (s *Service) runIndependentEnrichmentStages(ctx context.Context, job Job, payload NormalizedPayload, article CrawledArticle, cleaned CleanedNews, settings ExtractionSettings) CleanedNews {
	promptConfig := s.settings.PromptConfig(ctx)
	stageContext := StageContext{OrgID: job.OrgID, JobID: job.JobID}
	language := cleaned.Language
	if language == nil {
		language = payload.Language
	}
	promptInput := EnrichmentInput{
		Title:    cleaned.Title,
		Summary:  cleaned.Summary,
		Language: language,
		Markdown: cleaned.CleanedMarkdown,
	}

	next := cleaned
	next.StageMeta = pipelineCloneStageMeta(cleaned.StageMeta)
	if next.StageMeta == nil {
		next.StageMeta = &StageMeta{}
	}
	stageMeta := next.StageMeta

	if !settings.Capabilities.Entities {
		entry := NewStageMetaEntryWithReason("skipped", &settings.Providers.Entities, "capability_disabled")
		stageMeta.Entities = entry
		s.recordStageOutcome(ctx, job, "extract_entities", entry, nil)
	} else {
		entities, llmMetadata, err := s.extractor.ExtractEntities(ctx, stageContext, promptConfig, settings.Providers.Entities, promptInput)
		if err != nil {
			next.Entities = []Entity{}
			entry := NewStageMetaEntry("failed", &settings.Providers.Entities)
			entry.Reason = pipelineStageFailureReason(err, "entity_extraction_failed")
			stageMeta.Entities = entry
			s.logStageFailure(ctx, job, "extract_entities", nil, err)
			s.recordStageOutcome(ctx, job, "extract_entities", entry, nil)
		} else {
			if entities == nil {
				entities = []Entity{}
			}
			next.Entities = entities
			entry := NewStageMetaEntry("completed", &settings.Providers.Entities)
			pipelineFillStageMetaLLM(entry, llmMetadata, promptConfig.Version)
			stageMeta.Entities = entry
			s.recordStageOutcome(ctx, job, "extract_entities", entry, nil)
		}
	}

	if !settings.Capabilities.Sentiment {
		entry := NewStageMetaEntryWithReason("skipped", &settings.Providers.Sentiment, "capability_disabled")
		stageMeta.Sentiment = entry
		s.recordStageOutcome(ctx, job, "extract_sentiment", entry, nil)
	} else {
		label, llmMetadata, err := s.extractor.AnalyzeSentiment(ctx, stageContext, promptConfig, settings.Providers.Sentiment, promptInput)
		if err != nil {
			next.Sentiment = nil
			next.SentimentLabel = nil
			entry := NewStageMetaEntry("failed", &settings.Providers.Sentiment)
			entry.Reason = pipelineStageFailureReason(err, "sentiment_extraction_failed")
			stageMeta.Sentiment = entry
			s.logStageFailure(ctx, job, "extract_sentiment", nil, err)
			s.recordStageOutcome(ctx, job, "extract_sentiment", entry, nil)
		} else {
			var labelPointer *string
			if label != "" {
				labelPointer = stringPointer(label)
			}
			next.Sentiment = labelPointer
			next.SentimentLabel = labelPointer
			entry := NewStageMetaEntry("completed", &settings.Providers.Sentiment)
			pipelineFillStageMetaLLM(entry, llmMetadata, promptConfig.Version)
			stageMeta.Sentiment = entry
			s.recordStageOutcome(ctx, job, "extract_sentiment", entry, nil)
		}
	}

	if !settings.Capabilities.KG {
		entry := NewStageMetaEntryWithReason("skipped", &settings.Providers.KG, "capability_disabled")
		stageMeta.KG = entry
		s.recordStageOutcome(ctx, job, "extract_kg", entry, nil)
		return next
	}

	kgInput := promptInput
	kgInput.Markdown = pipelineBuildKGExtractionMarkdown(promptInput, next.Entities)
	relations, llmMetadata, err := s.extractor.ExtractKGRelations(ctx, stageContext, promptConfig, settings.Providers.KG, kgInput)
	if err != nil {
		next.KGRelations = []KGRelation{}
		entry := NewStageMetaEntry("failed", &settings.Providers.KG)
		entry.Reason = pipelineStageFailureReason(err, "kg_extraction_failed")
		stageMeta.KG = entry
		s.logStageFailure(ctx, job, "extract_kg", nil, err)
		s.recordStageOutcome(ctx, job, "extract_kg", entry, nil)
	} else {
		if relations == nil {
			relations = []KGRelation{}
		}
		next.KGRelations = relations
		entry := NewStageMetaEntry("completed", &settings.Providers.KG)
		pipelineFillStageMetaLLM(entry, llmMetadata, promptConfig.Version)
		stageMeta.KG = entry
		s.recordStageOutcome(ctx, job, "extract_kg", entry, nil)
	}
	return next
}

// runClassificationStage is runClassificationStage.
func (s *Service) runClassificationStage(ctx context.Context, job Job, payload NormalizedPayload, article CrawledArticle, cleaned CleanedNews) (CleanedNews, error) {
	if cleaned.StageMeta == nil {
		cleaned.StageMeta = &StageMeta{}
	}
	if s.classifier == nil {
		entry := NewStageMetaEntryWithReason("skipped", stringPointer("classifier"), "classifier_unavailable")
		cleaned.StageMeta.Classify = entry
		s.recordStageOutcome(ctx, job, "classify", entry, nil)
		return cleaned, nil
	}

	classification, err := pipelineRunStage(s, ctx, job, "classify", func() (newsclassifier.Result, error) {
		classifierInput, err := pipelineClassifierInput(cleaned)
		if err != nil {
			return newsclassifier.Result{}, err
		}
		return s.classifier.Classify(ctx, job.OrgID, classifierInput, s.classificationOptions(job, payload, article, cleaned))
	}, func() any {
		return pipelineStageFailureItemMeta{ItemMetaID: job.ItemMetaID}
	})
	if err != nil {
		return CleanedNews{}, err
	}
	next, err := pipelineApplyClassification(cleaned, classification)
	if err != nil {
		return CleanedNews{}, err
	}
	if next.StageMeta == nil {
		next.StageMeta = &StageMeta{}
	}
	entry := NewStageMetaEntry("completed", stringPointer("classifier"))
	entry.Reason = stringPointer(classification.Method)
	next.StageMeta.Classify = entry
	s.recordStageOutcome(ctx, job, "classify", entry, nil)
	return next, nil
}

// revertDuplicateMarkOnPersistFailure best-effort reverts the Duplicate mark.
func (s *Service) revertDuplicateMarkOnPersistFailure(ctx context.Context, job Job, duplicateOf *string) {
	if err := s.deduper.RevertDuplicateMarkOnPersistFailure(ctx, job, duplicateOf); err != nil {
		s.logf("failed to revert Duplicate mark after persist failure for itemMetaId %s: %v", job.ItemMetaID, err)
	}
}

// classificationOptions builds the classifier context exactly like the
// TypeScript call sites: jobId, payload metadata sourceId, trimmed article
// sourceUrl falling back to payload.url, and cleaned.source ?? payload.sourceName.
func (s *Service) classificationOptions(job Job, payload NormalizedPayload, article CrawledArticle, cleaned CleanedNews) newsclassifier.Options {
	sourceURL := payload.URL
	if trimmed := strings.TrimSpace(article.SourceURL); trimmed != "" {
		sourceURL = trimmed
	}
	options := newsclassifier.Options{JobID: job.JobID, SourceURL: sourceURL}
	if sourceID := extractSourceId(payload); sourceID != nil {
		options.SourceID = *sourceID
	}
	if sourceLabel := pipelineFirstNonNilString(cleaned.Source, payload.SourceName); sourceLabel != nil {
		options.SourceLabel = *sourceLabel
	}
	return options
}

// pipelineEnsureCleanedArrays replaces nil business arrays with empty slices.
// The typed struct can carry nil after a stage that produced no members, but the
// stored-result round trip must not write JSON null where CleanedNewsSchema
// requires an array.
func pipelineEnsureCleanedArrays(cleaned CleanedNews) CleanedNews {
	if cleaned.CategoryLabels == nil {
		cleaned.CategoryLabels = []string{}
	}
	if cleaned.CategoryCandidates == nil {
		cleaned.CategoryCandidates = []ClassificationCandidate{}
	}
	if cleaned.Topics == nil {
		cleaned.Topics = []string{}
	}
	if cleaned.KeyPoints == nil {
		cleaned.KeyPoints = []string{}
	}
	if cleaned.Entities == nil {
		cleaned.Entities = []Entity{}
	}
	if cleaned.KGRelations == nil {
		cleaned.KGRelations = []KGRelation{}
	}
	if cleaned.RemovedNoiseTypes == nil {
		cleaned.RemovedNoiseTypes = []string{}
	}
	return cleaned
}

// pipelineClassifierInput projects the typed cleaned news onto the classifier
// input through the stored-result parser, so the classifier sees the same
// projection a stored ProcessedItem.result would produce.
func pipelineClassifierInput(cleaned CleanedNews) (newsclassifier.CleanedNews, error) {
	cleaned = pipelineEnsureCleanedArrays(cleaned)
	raw, err := json.Marshal(cleaned)
	if err == nil {
		if stored, ok := newsclassifier.ParseStoredCleanedNews(raw); ok {
			return stored.ClassifierInput(), nil
		}
	}
	// The TypeScript classify stage receives the typed cleaned news directly and
	// never re-validates it; the direct projection keeps that behaviour when the
	// stored-result parser rejects an otherwise usable document.
	return pipelineDirectClassifierInput(cleaned), nil
}

// pipelineDirectClassifierInput is the CleanedNews projection of the classifier
// input, used as the lenient fallback of pipelineClassifierInput.
func pipelineDirectClassifierInput(cleaned CleanedNews) newsclassifier.CleanedNews {
	input := newsclassifier.CleanedNews{
		Topics:    cleaned.Topics,
		KeyPoints: cleaned.KeyPoints,
	}
	if cleaned.Title != nil {
		input.Title = *cleaned.Title
	}
	if cleaned.Subtitle != nil {
		input.Subtitle = *cleaned.Subtitle
	}
	if cleaned.Summary != nil {
		input.Summary = *cleaned.Summary
	}
	if cleaned.Source != nil {
		input.Source = *cleaned.Source
	}
	if cleaned.Language != nil {
		input.Language = *cleaned.Language
	}
	return input
}

// pipelineApplyClassificationFields is applyToCleanedNews on the typed struct.
// It is the fallback when the stored-document rewrite no longer satisfies
// CleanedNewsSchema: NestJS never re-validates applyToCleanedNews' output, so a
// classifier projection that is technically out of schema must not fail the
// stage here.
func pipelineApplyClassificationFields(cleaned CleanedNews, result newsclassifier.Result) CleanedNews {
	category := result.LegacyCategory
	if category == "" && cleaned.Category != nil {
		category = *cleaned.Category
	}
	var categoryPointer *string
	if category != "" {
		categoryPointer = stringPointer(category)
	}
	labels := result.Labels
	if labels == nil {
		labels = []string{}
	}
	candidates := make([]ClassificationCandidate, 0, len(result.Candidates))
	for _, candidate := range result.Candidates {
		candidates = append(candidates, ClassificationCandidate{
			Path:           candidate.Path,
			Score:          candidate.Score,
			LegacyCategory: candidate.LegacyCategory,
			Reason:         candidate.Reason,
		})
	}
	cleaned.Category = categoryPointer
	cleaned.CategoryPath = result.CategoryPath
	cleaned.CategoryLabels = labels
	cleaned.CategoryConfidence = result.Confidence
	cleaned.CategoryReason = result.Reason
	cleaned.CategoryMethod = stringPointer(result.Method)
	cleaned.CategoryCandidates = candidates
	return cleaned
}

// pipelineApplyClassification is classifier.applyToCleanedNews: the stored
// document rewrite keeps the open members (stage_meta included) and writes the
// classification fields, then the result is parsed back into the typed cleaned
// news.
func pipelineApplyClassification(cleaned CleanedNews, result newsclassifier.Result) (CleanedNews, error) {
	cleaned = pipelineEnsureCleanedArrays(cleaned)
	raw, err := json.Marshal(cleaned)
	if err != nil {
		return CleanedNews{}, err
	}
	stored, ok := newsclassifier.ParseStoredCleanedNews(raw)
	if !ok {
		return pipelineApplyClassificationFields(cleaned, result), nil
	}
	updated, err := stored.ApplyToCleanedNews(result)
	if err != nil {
		return CleanedNews{}, err
	}
	parsed, parseErr := ParseCleanedNews(updated)
	if parseErr != nil {
		// NestJS never re-validates the applied result; do not fail the stage for
		// a classifier projection that is technically out of schema.
		return pipelineApplyClassificationFields(cleaned, result), nil
	}
	return parsed, nil
}

// pipelineFillStageMetaLLM copies the LLM call metadata into a stage entry.
// promptVersion falls back to the prompt config version because the enrichment
// stage always stamps it.
func pipelineFillStageMetaLLM(entry *StageMetaEntry, llmMetadata *LLMMetadata, promptVersion string) {
	if llmMetadata == nil {
		entry.PromptVersion = stringPointer(promptVersion)
		return
	}
	entry.Model = llmMetadata.Model
	if llmMetadata.PromptVersion != nil {
		entry.PromptVersion = llmMetadata.PromptVersion
	} else {
		entry.PromptVersion = stringPointer(promptVersion)
	}
	entry.PromptTokens = llmMetadata.PromptTokens
	entry.CompletionTokens = llmMetadata.CompletionTokens
	entry.TotalTokens = llmMetadata.TotalTokens
	entry.CostUSD = llmMetadata.CostUSD
	entry.LatencyMS = llmMetadata.LatencyMS
}

// pipelineStageFailureReason is `error instanceof Error ? error.message : fallback`.
func pipelineStageFailureReason(err error, fallback string) *string {
	if err != nil {
		if message := err.Error(); message != "" {
			return stringPointer(message)
		}
	}
	return stringPointer(fallback)
}

// pipelineBuildKGExtractionMarkdown is buildKgExtractionMarkdown.
func pipelineBuildKGExtractionMarkdown(input EnrichmentInput, entities []Entity) string {
	entitySummary := ""
	if len(entities) > 0 {
		limit := pipelineMinInt(len(entities), 20)
		parts := make([]string, 0, limit)
		for _, entity := range entities[:limit] {
			parts = append(parts, entity.Name+" ("+entity.Type+")")
		}
		entitySummary = "Entities: " + strings.Join(parts, ", ")
	}
	if entitySummary == "" {
		return input.Markdown
	}
	if input.Markdown == "" {
		return entitySummary
	}
	return entitySummary + "\n\n" + input.Markdown
}

// pipelineExtractionMetadata is the articleMetadataPatch.extraction block.
type pipelineExtractionMetadata struct {
	Mode                  PipelineMode `json:"mode"`
	GateRejected          bool         `json:"gateRejected"`
	GateReason            *string      `json:"gateReason,omitempty"`
	PreflightQualityScore *float64     `json:"preflightQualityScore"`
}

// pipelineExtractionPatch builds {extraction: {...}} for the preflight-rejected
// persist path.
func pipelineExtractionPatch(mode PipelineMode, gateRejected bool, gateReason *string, preflightScore *float64) (json.RawMessage, error) {
	return json.Marshal(struct {
		Extraction pipelineExtractionMetadata `json:"extraction"`
	}{Extraction: pipelineExtractionMetadata{
		Mode:                  mode,
		GateRejected:          gateRejected,
		GateReason:            gateReason,
		PreflightQualityScore: preflightScore,
	}})
}

// pipelineExtractionPatchWithBase is `{...articleMetadataPatch, extraction}` for
// the clean-stage persist paths.
func pipelineExtractionPatchWithBase(base json.RawMessage, mode PipelineMode, gateRejected bool, gateReason *string, preflightScore *float64) (json.RawMessage, error) {
	extraction, err := json.Marshal(pipelineExtractionMetadata{
		Mode:                  mode,
		GateRejected:          gateRejected,
		GateReason:            gateReason,
		PreflightQualityScore: preflightScore,
	})
	if err != nil {
		return nil, err
	}
	patch := map[string]json.RawMessage{}
	if err := pipelineMergeRawObject(patch, base); err != nil {
		return nil, err
	}
	patch["extraction"] = extraction
	return json.Marshal(patch)
}

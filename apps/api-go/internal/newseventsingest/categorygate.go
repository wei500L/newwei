package newseventsingest

import (
	"context"
	"encoding/json"
	"time"
)

// eventClassification is the classification block read from NewsEvent.metadata.
type eventClassification struct {
	LegacyCategory *string
	CategoryPath   *string
	Confidence     *float64
}

// eventMetadataDocument is the additive projection of NewsEvent.metadata. Only
// metadata.classification participates in the gate.
type eventMetadataDocument struct {
	Classification *struct {
		LegacyCategory json.RawMessage `json:"legacyCategory"`
		CategoryPath   json.RawMessage `json:"categoryPath"`
		Confidence     json.RawMessage `json:"confidence"`
	} `json:"classification"`
}

// extractEventClassification mirrors extractEventClassification: metadata and
// metadata.classification must both be objects, a non-numeric confidence is
// null, and the two strings are re-normalized.
func extractEventClassification(metadataJSON []byte) eventClassification {
	if len(metadataJSON) == 0 {
		return eventClassification{}
	}
	var document eventMetadataDocument
	if !jsonObjectFields(json.RawMessage(metadataJSON), &document) || document.Classification == nil {
		return eventClassification{}
	}
	classification := eventClassification{
		LegacyCategory: normalizeLegacyCategoryRaw(document.Classification.LegacyCategory),
		CategoryPath:   normalizeCategoryPathRaw(document.Classification.CategoryPath),
	}
	if confidence, _, isNumber := jsonNumber(document.Classification.Confidence); isNumber {
		clamped := jsClampUnit(confidence)
		classification.Confidence = &clamped
	}
	return classification
}

// classificationMetadata is the `classification` object a new event stores. The
// field order is the order the NestJS object literal produces.
type classificationMetadata struct {
	LegacyCategory string   `json:"legacyCategory"`
	CategoryPath   string   `json:"categoryPath,omitempty"`
	Confidence     *float64 `json:"confidence,omitempty"`
}

// classificationEnvelope wraps the classification block the way
// NewsEventsService.createEvent stores it.
type classificationEnvelope struct {
	Classification classificationMetadata `json:"classification"`
}

// buildClassificationMetadata renders the NewsEvent.metadata column. A nil
// result means the column is not written (SQL NULL), matching Prisma's
// `metadata: undefined`.
func buildClassificationMetadata(signal NewsSignal) []byte {
	legacyCategory := normalizeLegacyCategory(signal.LegacyCategory)
	if legacyCategory == nil {
		return nil
	}
	envelope := classificationEnvelope{Classification: classificationMetadata{LegacyCategory: *legacyCategory}}
	if categoryPath := normalizeCategoryPath(signal.CategoryPath); categoryPath != nil {
		envelope.Classification.CategoryPath = *categoryPath
	}
	if signal.CategoryConfidence != nil {
		clamped := jsClampUnit(*signal.CategoryConfidence)
		envelope.Classification.Confidence = &clamped
	}
	encoded, err := json.Marshal(envelope)
	if err != nil {
		return nil
	}
	return encoded
}

// applyLanguagePenalty mirrors applyLanguagePenalty: only two non-blank,
// different (case-sensitive) languages are penalized.
func applyLanguagePenalty(score float64, signalLanguage, eventLanguage *string, settings Settings) float64 {
	signalValue := jsNormalizeOptionalString(signalLanguage)
	eventValue := jsNormalizeOptionalString(eventLanguage)
	if signalValue == nil || eventValue == nil || *signalValue == *eventValue {
		return score
	}
	penalty := jsClampPenalty(settings.CrossLanguagePenalty)
	return score * (1 - penalty)
}

// assignmentSession carries the per-assignment category gate decision log and
// the settings every decision reads. One session maps to exactly one
// assignNewsSignalToEvent / assignNewsSignalToSpecificEventWithSettings call, so
// the logs are flushed as one ordered:false batch per assignment (O2).
type assignmentSession struct {
	orgID    string
	settings Settings
	logs     []categoryGateLogData
}

// applyCategoryGate implements the eight-decision category ladder. The second
// result is false when the gate rejects the candidate (`null` in the NestJS
// code).
func (s *assignmentSession) applyCategoryGate(score float64, signal NewsSignal, eventMetadataJSON []byte) (float64, bool) {
	if !s.settings.ClassificationGateEnabled {
		s.collect(signal, categoryGateSkippedDisabled, score, func(data *categoryGateLogData) {})
		return score, true
	}

	signalCategory := normalizeLegacyCategory(signal.LegacyCategory)
	signalConfidence := signal.CategoryConfidence
	if signalCategory == nil {
		s.collect(signal, categoryGateNoSignalCategory, score, func(data *categoryGateLogData) {})
		return score, true
	}
	if signalConfidence == nil || *signalConfidence < s.settings.MinCategoryConfidenceForGate {
		clamped := clampConfidencePointer(signalConfidence)
		s.collect(signal, categoryGateLowConfidence, score, func(data *categoryGateLogData) {
			data.SignalConfidence = clamped
			minimum := s.settings.MinCategoryConfidenceForGate
			data.MinCategoryConfidenceForGate = &minimum
		})
		return score, true
	}

	classification := extractEventClassification(eventMetadataJSON)
	if classification.LegacyCategory == nil {
		s.collect(signal, categoryGateNoEventCategory, score, func(data *categoryGateLogData) {
			data.SignalCategory = signalCategory
		})
		return score, true
	}
	if *classification.LegacyCategory != *signalCategory {
		if s.settings.CategoryConflictReject {
			s.collect(signal, categoryGateDecisionReject, score, func(data *categoryGateLogData) {
				data.SignalCategory = signalCategory
				data.EventCategory = classification.LegacyCategory
			})
			return 0, false
		}
		adjusted := score * (1 - jsClampUnit(s.settings.CategorySoftPenalty))
		s.collect(signal, categoryGateDecisionPenalized, score, func(data *categoryGateLogData) {
			data.AdjustedScore = &adjusted
			data.SignalCategory = signalCategory
			data.EventCategory = classification.LegacyCategory
		})
		return adjusted, true
	}

	signalPath := normalizeCategoryPath(signal.CategoryPath)
	eventPath := normalizeCategoryPath(classification.CategoryPath)
	if signalPath == nil || eventPath == nil || *signalPath == *eventPath {
		s.collect(signal, categoryGateDecisionAccepted, score, func(data *categoryGateLogData) {
			data.SignalCategory = signalCategory
			data.SignalPath = signalPath
			data.EventPath = eventPath
		})
		return score, true
	}

	adjusted := score * (1 - jsClampUnit(s.settings.CategorySoftPenalty*0.5))
	s.collect(signal, categoryGateDecisionPenalized, score, func(data *categoryGateLogData) {
		data.AdjustedScore = &adjusted
		data.SignalCategory = signalCategory
		data.SignalPath = signalPath
		data.EventPath = eventPath
	})
	return adjusted, true
}

// collect appends one decision. The base members reproduce the NestJS literal:
// the raw signal category and path, and the raw signal confidence, before the
// branch overwrites what it needs.
func (s *assignmentSession) collect(signal NewsSignal, decision categoryGateDecision, score float64, decorate func(*categoryGateLogData)) {
	data := categoryGateLogData{
		Decision:           decision,
		ProcessedItemID:    signal.ProcessedItemID,
		ProcessedArticleID: signal.ProcessedArticleID,
		SignalCategory:     signal.LegacyCategory,
		SignalCategoryPath: signal.CategoryPath,
		SignalConfidence:   signal.CategoryConfidence,
		Score:              score,
	}
	decorate(&data)
	s.logs = append(s.logs, data)
}

// flushCategoryGateDecisionLogs writes the collected decisions as one
// insertMany with ordered:false. A write failure is a warning: the assignment
// result is unaffected.
func (s *assignmentSession) flushCategoryGateDecisionLogs(ctx context.Context, st *store, now time.Time) {
	if len(s.logs) == 0 {
		return
	}
	documents := make([]taskLogDocument, 0, len(s.logs))
	for _, data := range s.logs {
		encoded, err := marshalDocument(data)
		if err != nil {
			continue
		}
		documents = append(documents, taskLogDocument{
			Queue:     taskLogQueueNewsEvents,
			JobID:     data.ProcessedArticleID,
			OrgID:     s.orgID,
			Stage:     categoryGateStage,
			Status:    taskLogStatusCompleted,
			Data:      encoded,
			CreatedAt: now,
			UpdatedAt: now,
		})
	}
	s.logs = nil
	if len(documents) == 0 {
		return
	}
	_ = st.insertTaskLogs(ctx, documents)
}

// clampConfidencePointer mirrors the gate's local clamp: a nil or non-finite
// value stays nil, everything else is clamped into 0..1.
func clampConfidencePointer(value *float64) *float64 {
	if value == nil {
		return nil
	}
	if !isFinite(*value) {
		return nil
	}
	clamped := jsClampUnit(*value)
	return &clamped
}

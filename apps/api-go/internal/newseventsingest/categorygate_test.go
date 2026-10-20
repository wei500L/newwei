package newseventsingest

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
)

// testMetadataDocument is the typed fixture shape of a NewsEvent.metadata row.
type testMetadataDocument struct {
	Classification struct {
		LegacyCategory string `json:"legacyCategory"`
		CategoryPath   string `json:"categoryPath,omitempty"`
	} `json:"classification"`
}

// metadataWithClassification renders a NewsEvent.metadata document holding one
// classification block.
func metadataWithClassification(legacyCategory, categoryPath string) []byte {
	var document testMetadataDocument
	document.Classification.LegacyCategory = legacyCategory
	document.Classification.CategoryPath = categoryPath
	encoded, err := json.Marshal(document)
	if err != nil {
		panic(err)
	}
	return encoded
}

// gatedSignal builds a signal with a usable category and confidence.
func gatedSignal(category, path string, confidence float64) NewsSignal {
	return NewsSignal{
		ProcessedArticleID: "pa_1",
		ProcessedItemID:    stringPtr("pi_1"),
		LegacyCategory:     stringPtr(category),
		CategoryPath:       stringPtr(path),
		CategoryConfidence: floatPtr(confidence),
	}
}

// TestApplyCategoryGateBranches pins every decision of the ladder together with
// the value the gate returns.
func TestApplyCategoryGateBranches(t *testing.T) {
	settings := baseSettings()
	settings.CategorySoftPenalty = 0.2

	t.Run("skipped_disabled", func(t *testing.T) {
		disabled := settings
		disabled.ClassificationGateEnabled = false
		session := &assignmentSession{orgID: "org_1", settings: disabled}
		score, accepted := session.applyCategoryGate(0.9, gatedSignal("tech", "a", 0.9), metadataWithClassification("politics", ""))
		if !accepted || score != 0.9 {
			t.Fatalf("score = %v accepted = %v", score, accepted)
		}
		if got := session.logs[0].Decision; got != categoryGateSkippedDisabled {
			t.Fatalf("decision = %q", got)
		}
	})

	t.Run("skipped_no_signal_category", func(t *testing.T) {
		session := &assignmentSession{orgID: "org_1", settings: settings}
		signal := gatedSignal("sports", "a", 0.9)
		score, accepted := session.applyCategoryGate(0.5, signal, metadataWithClassification("politics", ""))
		if !accepted || score != 0.5 {
			t.Fatalf("score = %v accepted = %v", score, accepted)
		}
		data := session.logs[0]
		if data.Decision != categoryGateNoSignalCategory {
			t.Fatalf("decision = %q", data.Decision)
		}
		// The base member keeps the RAW signal category, not the normalized one.
		if data.SignalCategory == nil || *data.SignalCategory != "sports" {
			t.Fatalf("signalCategory = %v, want the raw value", data.SignalCategory)
		}
	})

	t.Run("skipped_low_signal_confidence", func(t *testing.T) {
		session := &assignmentSession{orgID: "org_1", settings: settings}
		signal := gatedSignal("tech", "a", 0.2)
		score, accepted := session.applyCategoryGate(0.5, signal, metadataWithClassification("tech", ""))
		if !accepted || score != 0.5 {
			t.Fatalf("score = %v accepted = %v", score, accepted)
		}
		data := session.logs[0]
		if data.Decision != categoryGateLowConfidence {
			t.Fatalf("decision = %q", data.Decision)
		}
		if data.MinCategoryConfidenceForGate == nil || *data.MinCategoryConfidenceForGate != 0.4 {
			t.Fatalf("minCategoryConfidenceForGate = %v", data.MinCategoryConfidenceForGate)
		}
		if data.SignalConfidence == nil || *data.SignalConfidence != 0.2 {
			t.Fatalf("signalConfidence = %v", data.SignalConfidence)
		}
	})

	t.Run("skipped_low_signal_confidence_without_confidence", func(t *testing.T) {
		session := &assignmentSession{orgID: "org_1", settings: settings}
		signal := gatedSignal("tech", "a", 0.9)
		signal.CategoryConfidence = nil
		_, accepted := session.applyCategoryGate(0.5, signal, metadataWithClassification("tech", ""))
		if !accepted {
			t.Fatalf("gate rejected a missing confidence")
		}
		if got := session.logs[0].Decision; got != categoryGateLowConfidence {
			t.Fatalf("decision = %q", got)
		}
		if session.logs[0].SignalConfidence != nil {
			t.Fatalf("signalConfidence = %v, want nil", session.logs[0].SignalConfidence)
		}
	})

	t.Run("skipped_no_event_category", func(t *testing.T) {
		session := &assignmentSession{orgID: "org_1", settings: settings}
		score, accepted := session.applyCategoryGate(0.5, gatedSignal("tech", "a", 0.9), nil)
		if !accepted || score != 0.5 {
			t.Fatalf("score = %v accepted = %v", score, accepted)
		}
		data := session.logs[0]
		if data.Decision != categoryGateNoEventCategory {
			t.Fatalf("decision = %q", data.Decision)
		}
		// The branch overwrites the raw category with the normalized one.
		if data.SignalCategory == nil || *data.SignalCategory != "tech" {
			t.Fatalf("signalCategory = %v", data.SignalCategory)
		}
	})

	t.Run("reject", func(t *testing.T) {
		session := &assignmentSession{orgID: "org_1", settings: settings}
		_, accepted := session.applyCategoryGate(0.5, gatedSignal("tech", "a", 0.9), metadataWithClassification("politics", ""))
		if accepted {
			t.Fatal("gate accepted a conflicting category")
		}
		data := session.logs[0]
		if data.Decision != categoryGateDecisionReject {
			t.Fatalf("decision = %q", data.Decision)
		}
		if data.EventCategory == nil || *data.EventCategory != "politics" {
			t.Fatalf("eventCategory = %v", data.EventCategory)
		}
	})

	t.Run("penalized_conflict", func(t *testing.T) {
		soft := settings
		soft.CategoryConflictReject = false
		session := &assignmentSession{orgID: "org_1", settings: soft}
		score, accepted := session.applyCategoryGate(1, gatedSignal("tech", "a", 0.9), metadataWithClassification("politics", ""))
		if !accepted {
			t.Fatal("gate rejected a soft conflict")
		}
		if score != 0.8 {
			t.Fatalf("score = %v, want 0.8", score)
		}
		data := session.logs[0]
		if data.Decision != categoryGateDecisionPenalized {
			t.Fatalf("decision = %q", data.Decision)
		}
		if data.AdjustedScore == nil || *data.AdjustedScore != 0.8 {
			t.Fatalf("adjustedScore = %v", data.AdjustedScore)
		}
		if data.EventCategory == nil || *data.EventCategory != "politics" {
			t.Fatalf("eventCategory = %v", data.EventCategory)
		}
	})

	t.Run("accepted", func(t *testing.T) {
		session := &assignmentSession{orgID: "org_1", settings: settings}
		score, accepted := session.applyCategoryGate(0.9, gatedSignal("tech", "a/b", 0.9), metadataWithClassification("tech", "a/b"))
		if !accepted || score != 0.9 {
			t.Fatalf("score = %v accepted = %v", score, accepted)
		}
		data := session.logs[0]
		if data.Decision != categoryGateDecisionAccepted {
			t.Fatalf("decision = %q", data.Decision)
		}
		if data.SignalPath == nil || *data.SignalPath != "a/b" || data.EventPath == nil || *data.EventPath != "a/b" {
			t.Fatalf("paths = %v/%v", data.SignalPath, data.EventPath)
		}
	})

	t.Run("accepted_without_event_path", func(t *testing.T) {
		session := &assignmentSession{orgID: "org_1", settings: settings}
		score, accepted := session.applyCategoryGate(0.9, gatedSignal("tech", "a/b", 0.9), metadataWithClassification("tech", ""))
		if !accepted || score != 0.9 {
			t.Fatalf("score = %v accepted = %v", score, accepted)
		}
		data := session.logs[0]
		if data.Decision != categoryGateDecisionAccepted || data.EventPath != nil {
			t.Fatalf("decision/eventPath = %q/%v", data.Decision, data.EventPath)
		}
	})

	t.Run("penalized_path", func(t *testing.T) {
		session := &assignmentSession{orgID: "org_1", settings: settings}
		score, accepted := session.applyCategoryGate(1, gatedSignal("tech", "a/b", 0.9), metadataWithClassification("tech", "a/c"))
		if !accepted {
			t.Fatal("gate rejected a path mismatch")
		}
		// The path penalty is half of categorySoftPenalty: 1 * (1 - 0.1).
		if score != 0.9 {
			t.Fatalf("score = %v, want 0.9", score)
		}
		data := session.logs[0]
		if data.Decision != categoryGateDecisionPenalized {
			t.Fatalf("decision = %q", data.Decision)
		}
		if data.SignalPath == nil || *data.SignalPath != "a/b" {
			t.Fatalf("signalPath = %v", data.SignalPath)
		}
		if data.EventPath == nil || *data.EventPath != "a/c" {
			t.Fatalf("eventPath = %v", data.EventPath)
		}
	})
}

// TestCategoryGateLogFieldOrder locks the BSON member order of the data payload,
// which is the order of the NestJS object spread.
func TestCategoryGateLogFieldOrder(t *testing.T) {
	settings := baseSettings()
	settings.CategorySoftPenalty = 0.2
	// Soft conflict: the branch writes adjustedScore before eventCategory.
	settings.CategoryConflictReject = false
	session := &assignmentSession{orgID: "org_1", settings: settings}
	session.applyCategoryGate(1, gatedSignal("tech", "a/b", 0.9), metadataWithClassification("politics", "a/c"))

	document, err := marshalDocument(session.logs[0])
	if err != nil {
		t.Fatal(err)
	}
	keys := bsonDocumentKeys(t, document)
	want := []string{
		"decision",
		"processedItemId",
		"processedArticleId",
		"signalCategory",
		"signalCategoryPath",
		"signalConfidence",
		"score",
		"adjustedScore",
		"eventCategory",
	}
	if len(keys) != len(want) {
		t.Fatalf("keys = %v, want %v", keys, want)
	}
	for index := range want {
		if keys[index] != want[index] {
			t.Fatalf("keys = %v, want %v", keys, want)
		}
	}
}

// TestCategoryGateLogFieldOrderPathBranch locks the penalized-path member order:
// adjustedScore, then the two paths.
func TestCategoryGateLogFieldOrderPathBranch(t *testing.T) {
	settings := baseSettings()
	session := &assignmentSession{orgID: "org_1", settings: settings}
	session.applyCategoryGate(1, gatedSignal("tech", "a/b", 0.9), metadataWithClassification("tech", "a/c"))

	document, err := marshalDocument(session.logs[0])
	if err != nil {
		t.Fatal(err)
	}
	keys := bsonDocumentKeys(t, document)
	want := []string{
		"decision",
		"processedItemId",
		"processedArticleId",
		"signalCategory",
		"signalCategoryPath",
		"signalConfidence",
		"score",
		"adjustedScore",
		"signalPath",
		"eventPath",
	}
	if len(keys) != len(want) {
		t.Fatalf("keys = %v, want %v", keys, want)
	}
	for index := range want {
		if keys[index] != want[index] {
			t.Fatalf("keys = %v, want %v", keys, want)
		}
	}
}

// TestCategoryGateLogKeepsNulls locks that the base members are written as BSON
// null instead of being omitted, while an unset branch member is absent.
func TestCategoryGateLogKeepsNulls(t *testing.T) {
	session := &assignmentSession{orgID: "org_1", settings: baseSettings()}
	signal := NewsSignal{
		ProcessedArticleID: "pa_1",
		ProcessedItemID:    nil,
		LegacyCategory:     nil,
		CategoryConfidence: nil,
	}
	session.applyCategoryGate(0.5, signal, nil)
	document, err := marshalDocument(session.logs[0])
	if err != nil {
		t.Fatal(err)
	}
	var decoded bson.Raw
	if err := bson.Unmarshal(document, &decoded); err != nil {
		t.Fatal(err)
	}
	elements, err := decoded.Elements()
	if err != nil {
		t.Fatal(err)
	}
	values := make(map[string]bson.RawValue, len(elements))
	for _, element := range elements {
		key, err := element.KeyErr()
		if err != nil {
			t.Fatal(err)
		}
		value, err := element.ValueErr()
		if err != nil {
			t.Fatal(err)
		}
		values[key] = value
	}
	for _, key := range []string{"processedItemId", "signalCategory", "signalCategoryPath", "signalConfidence"} {
		value, ok := values[key]
		if !ok {
			t.Fatalf("%s missing", key)
		}
		if value.Type != bson.TypeNull {
			t.Fatalf("%s type = %v, want null", key, value.Type)
		}
	}
	if _, ok := values["adjustedScore"]; ok {
		t.Fatal("adjustedScore must be absent on the skipped_no_signal_category branch")
	}
}

// TestFlushCategoryGateDecisionLogsWritesOneBatchPerAssignment locks O2: the logs
// keep the news_events/category_gate/completed shape and the batch is reset
// after the flush.
func TestFlushCategoryGateDecisionLogsWritesOneBatchPerAssignment(t *testing.T) {
	session := &assignmentSession{orgID: "org_1", settings: baseSettings()}
	dispatcher := &recordingTaskLogStore{}
	session.applyCategoryGate(0.5, gatedSignal("tech", "a", 0.9), metadataWithClassification("tech", "a"))
	session.applyCategoryGate(0.4, gatedSignal("tech", "a", 0.9), metadataWithClassification("tech", "a"))
	dispatcher.flush(context.Background(), session, fixedNow)

	if len(dispatcher.batches) != 1 {
		t.Fatalf("batches = %d, want 1", len(dispatcher.batches))
	}
	batch := dispatcher.batches[0]
	if len(batch) != 2 {
		t.Fatalf("batch size = %d, want 2", len(batch))
	}
	for _, document := range batch {
		if document.Queue != taskLogQueueNewsEvents || document.Stage != categoryGateStage || document.Status != taskLogStatusCompleted {
			t.Fatalf("document = %+v", document)
		}
		if document.JobID != "pa_1" || document.OrgID != "org_1" {
			t.Fatalf("document identity = %q/%q", document.JobID, document.OrgID)
		}
	}
	if len(session.logs) != 0 {
		t.Fatalf("logs were not reset: %d", len(session.logs))
	}
}

// recordingTaskLogStore captures the TaskLog batches a flush would write.
type recordingTaskLogStore struct {
	batches [][]taskLogDocument
}

// flush is the test seam for assignmentSession.flushCategoryGateDecisionLogs.
func (r *recordingTaskLogStore) flush(ctx context.Context, session *assignmentSession, now time.Time) {
	_ = ctx
	if len(session.logs) == 0 {
		return
	}
	documents := make([]taskLogDocument, 0, len(session.logs))
	for _, data := range session.logs {
		encoded, err := marshalDocument(data)
		if err != nil {
			continue
		}
		documents = append(documents, taskLogDocument{
			Queue:     taskLogQueueNewsEvents,
			JobID:     data.ProcessedArticleID,
			OrgID:     session.orgID,
			Stage:     categoryGateStage,
			Status:    taskLogStatusCompleted,
			Data:      encoded,
			CreatedAt: now,
			UpdatedAt: now,
		})
	}
	session.logs = nil
	r.batches = append(r.batches, documents)
}

// bsonDocumentKeys returns the member names of one BSON document in storage
// order.
func bsonDocumentKeys(t *testing.T, document bsonDocument) []string {
	t.Helper()
	var decoded bson.Raw
	if err := bson.Unmarshal(document, &decoded); err != nil {
		t.Fatal(err)
	}
	elements, err := decoded.Elements()
	if err != nil {
		t.Fatal(err)
	}
	keys := make([]string, 0, len(elements))
	for _, element := range elements {
		key, err := element.KeyErr()
		if err != nil {
			t.Fatal(err)
		}
		keys = append(keys, key)
	}
	return keys
}

package situationsignals

import (
	"errors"
	"testing"

	"go.mongodb.org/mongo-driver/v2/bson"
)

func TestExtractTokens(t *testing.T) {
	cases := []struct {
		name string
		text string
		want []string
	}{
		{"empty", "", []string{}},
		{"stopwords dropped", "the quick brown fox and the lazy dog", []string{"quick", "brown", "fox", "lazy", "dog"}},
		{"short tokens dropped", "a ab abc abcd", []string{"abc", "abcd"}},
		{"dedupe keeps first occurrence", "alpha beta alpha gamma beta", []string{"alpha", "beta", "gamma"}},
		{"upper case is lowered", "ALPHA Bravo", []string{"alpha", "bravo"}},
		{
			"cap at eight",
			"one two three four five six seven eight nine ten",
			[]string{"one", "two", "three", "four", "five", "six", "seven", "eight"},
		},
		{"punctuation splits", "alpha,beta;gamma", []string{"alpha", "beta", "gamma"}},
		{"digits count", "911 attack 2024", []string{"911", "attack", "2024"}},
		// A long run is consumed greedily in chunks of 24; the 16-character
		// remainder is the second match.
		{"long run chunking", "abcdefghijklmnopqrstuvwxyz0123456789", []string{"abcdefghijklmnopqrstuvwx", "yz0123456789"}},
		// 26 characters: 24 + a 2-character remainder that is too short.
		{"short remainder dropped", "abcdefghijklmnopqrstuvwxyz", []string{"abcdefghijklmnopqrstuvwx"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := extractTokens(tc.text)
			if len(got) != len(tc.want) {
				t.Fatalf("got %v, want %v", got, tc.want)
			}
			for index := range got {
				if got[index] != tc.want[index] {
					t.Fatalf("got %v, want %v", got, tc.want)
				}
			}
		})
	}
}

func TestLearningStateUpdateFalsePositive(t *testing.T) {
	update := learningStateUpdate(learningStateInput{
		OrgID:      "org-1",
		SignalType: "narrative",
		SignalID:   "sig-1",
		Label:      "false_positive",
		Tokens:     []string{"alpha", "beta"},
		ItemMetaID: "meta-1",
	})
	setOnInsert := operatorDocument(t, update, "$setOnInsert")
	if value, ok := lookupString(setOnInsert, "orgId"); !ok || value != "org-1" {
		t.Fatalf("setOnInsert.orgId = %v", setOnInsert)
	}
	if _, ok := lookupRaw(setOnInsert, "createdAt"); !ok {
		t.Fatal("setOnInsert must carry createdAt (Mongoose timestamps)")
	}
	if _, ok := lookupRaw(operatorDocument(t, update, "$set"), "updatedAt"); !ok {
		t.Fatal("$set must carry updatedAt")
	}
	increments := operatorDocument(t, update, "$inc")
	if value, ok := lookupInt(increments, "falsePositiveCount"); !ok || value != 1 {
		t.Fatalf("falsePositiveCount = %v", increments)
	}
	if value, ok := lookupInt(increments, "blockedTokenCounts.alpha"); !ok || value != 1 {
		t.Fatalf("blockedTokenCounts.alpha = %v", increments)
	}
	if value, ok := lookupInt(increments, "blockedTokenCounts.beta"); !ok || value != 1 {
		t.Fatalf("blockedTokenCounts.beta = %v", increments)
	}
	if _, ok := lookupInt(increments, "falseNegativeCount"); ok {
		t.Fatal("false_positive must not touch falseNegativeCount")
	}
	addToSet, ok := findOperator(update, "$addToSet")
	if !ok {
		t.Fatal("$addToSet missing for a false positive with an itemMetaId")
	}
	if value, ok := lookupString(addToSet, "suppressedItemMetaIds"); !ok || value != "meta-1" {
		t.Fatalf("$addToSet = %v", addToSet)
	}
}

func TestLearningStateUpdateFalseNegative(t *testing.T) {
	update := learningStateUpdate(learningStateInput{
		OrgID:      "org-1",
		SignalType: "correlation",
		SignalID:   "sig-2",
		Label:      "false_negative",
		Tokens:     []string{"gamma"},
	})
	increments := operatorDocument(t, update, "$inc")
	if value, ok := lookupInt(increments, "falseNegativeCount"); !ok || value != 1 {
		t.Fatalf("falseNegativeCount = %v", increments)
	}
	if value, ok := lookupInt(increments, "boostedTokenCounts.gamma"); !ok || value != 1 {
		t.Fatalf("boostedTokenCounts.gamma = %v", increments)
	}
	if _, ok := findOperator(update, "$addToSet"); ok {
		t.Fatal("false_negative must never suppress itemMetaIds")
	}
}

func TestLearningStateUpdateFalsePositiveWithoutItemMetaID(t *testing.T) {
	update := learningStateUpdate(learningStateInput{
		OrgID:      "org-1",
		SignalType: "narrative",
		SignalID:   "sig-3",
		Label:      "false_positive",
		Tokens:     []string{},
	})
	if _, ok := findOperator(update, "$addToSet"); ok {
		t.Fatal("a false positive without an itemMetaId must not add to the suppression set")
	}
}

func TestRecordFeedbackRejectsBlankSignalIDBeforeWriting(t *testing.T) {
	store, ops := newMemoryCache()
	service := &Service{cache: ops}
	err := service.recordFeedback(t.Context(), "org-1", "user-1", feedbackInput{
		SignalType: "narrative",
		SignalID:   "   ",
		Label:      "false_positive",
	})
	var status *statusError
	if !errors.As(err, &status) || status.status != 400 || status.message != "signalId is required" {
		t.Fatalf("err = %v", err)
	}
	// Nothing was written: the guard runs before the Mongo insert and before the
	// learning-revision increment.
	if len(store.incs) != 0 {
		t.Fatalf("redis increments = %v", store.incs)
	}
}

// findOperator returns one MongoDB update operator document.
func findOperator(update bson.D, operator string) (bson.D, bool) {
	for _, entry := range update {
		if entry.Key != operator {
			continue
		}
		document, ok := entry.Value.(bson.D)
		if !ok {
			return nil, false
		}
		return document, true
	}
	return nil, false
}

// operatorDocument returns one MongoDB update operator document, failing the
// test when it is absent.
func operatorDocument(t *testing.T, update bson.D, operator string) bson.D {
	t.Helper()
	document, ok := findOperator(update, operator)
	if !ok {
		t.Fatalf("%s missing from %v", operator, update)
	}
	return document
}

// lookupRaw returns one field of an operator document verbatim.
func lookupRaw(document bson.D, key string) (bson.RawValue, bool) {
	for _, entry := range document {
		if entry.Key == key {
			return bson.RawValue{}, true
		}
	}
	return bson.RawValue{}, false
}

// lookupInt resolves a numeric counter value.
func lookupInt(document bson.D, key string) (int, bool) {
	for _, entry := range document {
		if entry.Key != key {
			continue
		}
		switch value := entry.Value.(type) {
		case int:
			return value, true
		case int32:
			return int(value), true
		case int64:
			return int(value), true
		}
		return 0, false
	}
	return 0, false
}

// lookupString resolves a string field value.
func lookupString(document bson.D, key string) (string, bool) {
	for _, entry := range document {
		if entry.Key != key {
			continue
		}
		value, ok := entry.Value.(string)
		return value, ok
	}
	return "", false
}

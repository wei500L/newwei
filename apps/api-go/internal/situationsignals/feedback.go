package situationsignals

import (
	"context"
	"errors"
	"strings"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

// stopwords mirrors STOPWORDS in
// apps/api/src/modules/situation-monitor/situation-monitor-feedback.service.ts.
var stopwords = map[string]bool{
	"a": true, "an": true, "and": true, "are": true, "as": true, "at": true,
	"be": true, "but": true, "by": true, "for": true, "from": true, "has": true,
	"have": true, "he": true, "her": true, "hers": true, "him": true, "his": true,
	"i": true, "in": true, "into": true, "is": true, "it": true, "its": true,
	"may": true, "more": true, "of": true, "on": true, "or": true, "our": true,
	"ours": true, "she": true, "that": true, "the": true, "their": true,
	"them": true, "then": true, "they": true, "this": true, "to": true,
	"was": true, "we": true, "were": true, "will": true, "with": true,
	"you": true, "your": true,
}

// feedbackDocument is the shape inserted into the situationsignalfeedbacks
// collection. Field names match the Mongoose schema, including the timestamps
// Mongoose adds, so a Go insert is indistinguishable from a NestJS insert.
type feedbackDocument struct {
	OrgID      string    `bson:"orgId"`
	UserID     string    `bson:"userId"`
	SignalType string    `bson:"signalType"`
	SignalID   string    `bson:"signalId"`
	Label      string    `bson:"label"`
	ItemMetaID *string   `bson:"itemMetaId"`
	ItemLink   *string   `bson:"itemLink"`
	ItemTitle  *string   `bson:"itemTitle"`
	ItemSource *string   `bson:"itemSource"`
	Note       *string   `bson:"note"`
	CreatedAt  time.Time `bson:"createdAt"`
	UpdatedAt  time.Time `bson:"updatedAt"`
	Version    int32     `bson:"__v"`
}

// feedbackResponse is the 201 body.
type feedbackResponse struct {
	OK bool `json:"ok"`
}

// feedbackOutcome carries the keys the smoke workflow asserts on.
type feedbackOutcome struct {
	Document      feedbackDocument
	LearningState bson.D
	Tokens        []string
	RedisKey      string
}

// recordFeedback mirrors SituationMonitorFeedbackService.recordFeedback.
//
// S1: a signalId that is blank after trimming is a client error (400), not the
// bare Error that NestJS mapped onto a 500.
func (s *Service) recordFeedback(ctx context.Context, orgID, userID string, input feedbackInput) error {
	signalID := strings.TrimSpace(input.SignalID)
	if signalID == "" {
		return errSignalIDRequired
	}
	itemMetaID := strings.TrimSpace(input.ItemMetaID)
	itemLink := strings.TrimSpace(input.ItemLink)
	itemTitle := strings.TrimSpace(input.ItemTitle)
	itemSource := strings.TrimSpace(input.ItemSource)
	note := strings.TrimSpace(input.Note)

	now := time.Now().UTC()
	document := feedbackDocument{
		OrgID:      orgID,
		UserID:     userID,
		SignalType: input.SignalType,
		SignalID:   signalID,
		Label:      input.Label,
		ItemMetaID: nullableString(itemMetaID),
		ItemLink:   nullableString(itemLink),
		ItemTitle:  nullableString(itemTitle),
		ItemSource: nullableString(itemSource),
		Note:       nullableString(note),
		CreatedAt:  now,
		UpdatedAt:  now,
	}
	if s.mongo == nil {
		return errNoDatabase
	}
	if _, err := s.mongo.Collection(feedbackCollection).InsertOne(ctx, document); err != nil {
		return err
	}

	tokens := extractTokens(itemTitle)
	update := learningStateUpdate(learningStateInput{
		OrgID:      orgID,
		SignalType: input.SignalType,
		SignalID:   signalID,
		Label:      input.Label,
		Tokens:     tokens,
		ItemMetaID: itemMetaID,
		Now:        now,
	})
	_, err := s.mongo.Collection(learningStateCollection).UpdateOne(
		ctx,
		bson.D{
			{Key: "orgId", Value: orgID},
			{Key: "signalType", Value: input.SignalType},
			{Key: "signalId", Value: signalID},
		},
		update,
		options.UpdateOne().SetUpsert(true),
	)
	if err != nil {
		return err
	}

	return s.bumpInsightsLearningRevision(ctx, orgID)
}

// bumpInsightsLearningRevision mirrors CacheService.incr: INCR, and the TTL is
// set only when the counter was created by this call (value === 1). A second
// call must not extend the 90 day window.
func (s *Service) bumpInsightsLearningRevision(ctx context.Context, orgID string) error {
	if s.cache.incr == nil {
		return errNoDatabase
	}
	key := insightsRevPrefix + ":" + orgID
	value, err := s.cache.incr(ctx, key)
	if err != nil {
		return err
	}
	if value == 1 {
		if err := s.cache.expire(ctx, key, insightsRevTTL); err != nil {
			return err
		}
	}
	return nil
}

// learningStateInput is the pure input of the learning-state update builder.
type learningStateInput struct {
	OrgID      string
	SignalType string
	SignalID   string
	Label      string
	Tokens     []string
	ItemMetaID string
	Now        time.Time
}

// learningStateUpdate builds the upsert document for the
// situationsignallearningstates collection:
//
//	$setOnInsert: {orgId, signalType, signalId, createdAt}
//	$set:         {updatedAt}
//	$inc:         {falsePositiveCount: 1, blockedTokenCounts.<token>: 1, ...}
//	$addToSet:    {suppressedItemMetaIds: <itemMetaId>}   (false_positive only)
//
// The counter key names use Mongo dot notation, which is why the token list is
// restricted to [a-z0-9] before it gets here.
func learningStateUpdate(input learningStateInput) bson.D {
	increments := bson.D{}
	if input.Label == string(feedbackLabelFalsePositive) {
		increments = append(increments, bson.E{Key: "falsePositiveCount", Value: 1})
		for _, token := range input.Tokens {
			increments = append(increments, bson.E{Key: "blockedTokenCounts." + token, Value: 1})
		}
	} else {
		increments = append(increments, bson.E{Key: "falseNegativeCount", Value: 1})
		for _, token := range input.Tokens {
			increments = append(increments, bson.E{Key: "boostedTokenCounts." + token, Value: 1})
		}
	}

	update := bson.D{
		{Key: "$setOnInsert", Value: bson.D{
			{Key: "orgId", Value: input.OrgID},
			{Key: "signalType", Value: input.SignalType},
			{Key: "signalId", Value: input.SignalID},
			{Key: "createdAt", Value: input.Now},
		}},
		// Mongoose's timestamps option adds updatedAt to every update.
		{Key: "$set", Value: bson.D{{Key: "updatedAt", Value: input.Now}}},
		{Key: "$inc", Value: increments},
	}
	if input.Label == string(feedbackLabelFalsePositive) && input.ItemMetaID != "" {
		update = append(update, bson.E{Key: "$addToSet", Value: bson.D{
			{Key: "suppressedItemMetaIds", Value: input.ItemMetaID},
		}})
	}
	return update
}

// extractTokens mirrors extractTokens: lower-case, take the [a-z0-9]{3,24}
// matches in order, drop stopwords and duplicates and stop at eight tokens.
func extractTokens(text string) []string {
	if text == "" {
		return []string{}
	}
	lowered := strings.ToLower(text)
	result := make([]string, 0, matchedTermLimit)
	seen := map[string]bool{}
	for _, match := range alphaNumericMatches(lowered) {
		if stopwords[match] {
			continue
		}
		if seen[match] {
			continue
		}
		seen[match] = true
		result = append(result, match)
		if len(result) >= 8 {
			break
		}
	}
	return result
}

// alphaNumericMatches reproduces `text.match(/[a-z0-9]{3,24}/g)`: every maximal
// run of [a-z0-9] is consumed greedily in chunks of at most 24 characters, and a
// trailing chunk shorter than three characters is not a match.
func alphaNumericMatches(text string) []string {
	out := []string{}
	runes := []rune(text)
	index := 0
	for index < len(runes) {
		if !isAlphaNumericRune(runes[index]) {
			index++
			continue
		}
		start := index
		for index < len(runes) && isAlphaNumericRune(runes[index]) {
			index++
		}
		run := string(runes[start:index])
		for len(run) >= 3 {
			take := len(run)
			if take > 24 {
				take = 24
			}
			out = append(out, run[:take])
			run = run[take:]
		}
	}
	return out
}

// isAlphaNumericRune mirrors [a-z0-9] after the input was lower-cased.
func isAlphaNumericRune(r rune) bool {
	return (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9')
}

// nullableString turns an empty trimmed value into a stored null, which is what
// `itemMetaId || null` writes.
func nullableString(value string) *string {
	if value == "" {
		return nil
	}
	return &value
}

// isMongoUnavailable reports whether a Mongo error should surface as the
// generic 500 shape rather than a 503. Mongo is not a pooled MySQL dependency,
// so NestJS maps every Mongo failure onto a plain 500.
func isMongoUnavailable(err error) bool {
	return errors.Is(err, mongo.ErrClientDisconnected)
}

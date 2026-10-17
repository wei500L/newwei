package platformgovernance

import (
	"context"
	"errors"
	"fmt"
	"math"
	"strconv"
	"strings"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

// ttlIndexProfile describes one managed TTL index domain. The reconciliation
// algorithm is shared; only the index name, the conflict text and the retryable
// error set differ between the task-log and llm-request-log services.
type ttlIndexProfile struct {
	// IndexName is the managed index name (TASK_LOG_TTL_INDEX_NAME or
	// LLM_REQUEST_LOG_TTL_INDEX_NAME).
	IndexName string
	// ConflictMessage renders the exact NestJS error for a blocking non-TTL
	// createdAt index.
	ConflictMessage func(name string) string
	// Retryable reports whether an index-management error may be retried.
	Retryable func(error) bool
}

// declaredIndex is one index from listIndexes reduced to the fields the
// reconciliation reads. Name is already trimmed and non-empty; only createdAt
// single-key indexes reach this type.
type declaredIndex struct {
	Name string
	// ExpireAfterSeconds is nil when the index has no expireAfterSeconds or the
	// value is not a finite number/string, matching NestJS
	// normalizeExpireAfterSeconds.
	ExpireAfterSeconds *int64
}

// indexList is the typed listIndexes snapshot the pure decision helpers below
// operate on.
type indexList []declaredIndex

// rawIndexDocument is one listIndexes result element. Both `key` and
// `expireAfterSeconds` are decoded as RawValue so an unexpected BSON type never
// fails the whole listing - NestJS inspects the same fields dynamically.
type rawIndexDocument struct {
	Name               string        `bson:"name"`
	Key                bson.RawValue `bson:"key"`
	ExpireAfterSeconds bson.RawValue `bson:"expireAfterSeconds"`
}

// parseIndexList converts a listIndexes result into the typed snapshot,
// reproducing NestJS getManagedCreatedAtIndexes: only indexes whose key
// document has exactly one element `createdAt: 1` and whose name is a non-empty
// string survive.
func parseIndexList(documents []rawIndexDocument) indexList {
	out := make(indexList, 0, len(documents))
	for _, document := range documents {
		if !hasCreatedAtSingleKey(document.Key) {
			continue
		}
		name := strings.TrimSpace(document.Name)
		if name == "" {
			continue
		}
		out = append(out, declaredIndex{
			Name:               name,
			ExpireAfterSeconds: normalizeExpireAfterSeconds(document.ExpireAfterSeconds),
		})
	}
	return out
}

// hasCreatedAtSingleKey mirrors `Object.keys(key).length === 1 &&
// key.createdAt === 1`.
func hasCreatedAtSingleKey(key bson.RawValue) bool {
	if key.Type != bson.TypeEmbeddedDocument {
		return false
	}
	document, ok := key.DocumentOK()
	if !ok {
		return false
	}
	elements, err := document.Elements()
	if err != nil || len(elements) != 1 {
		return false
	}
	element := elements[0]
	if element.Key() != "createdAt" {
		return false
	}
	value := element.Value()
	if !value.IsNumber() {
		return false
	}
	// JS compares the decoded number to 1; every BSON numeric type qualifies.
	switch value.Type {
	case bson.TypeInt32:
		return value.Int32() == 1
	case bson.TypeInt64:
		return value.Int64() == 1
	case bson.TypeDouble:
		return value.Double() == 1
	default:
		return false
	}
}

// normalizeExpireAfterSeconds mirrors the NestJS helper: a finite number is
// truncated, a non-empty numeric string is parsed then truncated, everything
// else (missing, null, a non-numeric string, an object) is nil.
func normalizeExpireAfterSeconds(value bson.RawValue) *int64 {
	switch value.Type {
	case bson.TypeInt32:
		parsed := int64(value.Int32())
		return &parsed
	case bson.TypeInt64:
		parsed := value.Int64()
		return &parsed
	case bson.TypeDouble:
		parsed := value.Double()
		if math.IsNaN(parsed) || math.IsInf(parsed, 0) {
			return nil
		}
		truncated := int64(math.Trunc(parsed))
		return &truncated
	case bson.TypeString:
		text := strings.TrimSpace(value.StringValue())
		if text == "" {
			return nil
		}
		parsed, err := strconv.ParseFloat(text, 64)
		if err != nil || math.IsNaN(parsed) || math.IsInf(parsed, 0) {
			return nil
		}
		truncated := int64(math.Trunc(parsed))
		return &truncated
	default:
		return nil
	}
}

// hasDesiredManagedTTLIndex mirrors hasDesiredManagedTtlIndex: one managed
// createdAt index already carries the target expireAfterSeconds.
func hasDesiredManagedTTLIndex(indexes indexList, target int64) bool {
	for _, index := range indexes {
		if index.ExpireAfterSeconds != nil && *index.ExpireAfterSeconds == target {
			return true
		}
	}
	return false
}

// findStaleManagedTTLIndexes mirrors findStaleManagedTtlIndexes: the managed
// index with a different TTL, plus every other createdAt single-key index that
// carries a TTL. A non-TTL createdAt index is never stale (it is handled by
// findBlockingNonTTLCreatedAtIndex).
func findStaleManagedTTLIndexes(indexes indexList, managedName string, target int64) []string {
	stale := make([]string, 0, len(indexes))
	for _, index := range indexes {
		isStale := false
		if index.Name == managedName {
			isStale = index.ExpireAfterSeconds == nil || *index.ExpireAfterSeconds != target
		} else if index.ExpireAfterSeconds != nil {
			isStale = *index.ExpireAfterSeconds != target
		}
		if isStale && !containsString(stale, index.Name) {
			stale = append(stale, index.Name)
		}
	}
	return stale
}

// findBlockingNonTTLCreatedAtIndex mirrors findBlockingNonTtlCreatedAtIndex: a
// createdAt single-key index without a TTL whose name is not the managed one
// blocks index creation.
func findBlockingNonTTLCreatedAtIndex(indexes indexList, managedName string) (string, bool) {
	for _, index := range indexes {
		if index.ExpireAfterSeconds == nil && index.Name != managedName {
			return index.Name, true
		}
	}
	return "", false
}

// applyRetentionTTLIndex reconciles the managed TTL index for one collection,
// retrying up to three times with the same 150ms * attempt backoff as NestJS.
func (s *Service) applyRetentionTTLIndex(ctx context.Context, collectionName string, profile ttlIndexProfile, retentionDays int) error {
	expireAfterSeconds := int64(retentionDays) * secondsPerDay
	sleep := s.sleep
	if sleep == nil {
		sleep = time.Sleep
	}

	var lastErr error
	for attempt := 1; attempt <= ttlReconcileMaxAttempts; attempt++ {
		_, err := s.reconcileTTLIndexOnce(ctx, collectionName, profile, expireAfterSeconds)
		if err == nil {
			return nil
		}
		lastErr = err
		if !profile.Retryable(err) || attempt >= ttlReconcileMaxAttempts {
			return err
		}
		sleep(time.Duration(ttlReconcileBaseDelayMs*attempt) * time.Millisecond)
	}
	return lastErr
}

// reconcileTTLIndexOnce runs one reconciliation attempt:
//
//  1. listIndexes (a missing collection is an empty list - TTL-01);
//  2. return unchanged when the desired managed index already exists;
//  3. drop stale managed TTL indexes, ignoring IndexNotFound and retryable
//     failures;
//  4. re-list and return updated when the desired index now exists;
//  5. refuse to write when a non-TTL createdAt index would conflict;
//  6. create the managed index with the target expireAfterSeconds.
func (s *Service) reconcileTTLIndexOnce(ctx context.Context, collectionName string, profile ttlIndexProfile, expireAfterSeconds int64) (TtlReconcileStatus, error) {
	collection := s.mongoCollection(collectionName)
	if collection == nil {
		return "", errNoMongo
	}
	initial, err := s.listIndexes(ctx, collection)
	if err != nil {
		return "", err
	}
	if hasDesiredManagedTTLIndex(initial, expireAfterSeconds) {
		return TtlReconcileUnchanged, nil
	}

	stale := findStaleManagedTTLIndexes(initial, profile.IndexName, expireAfterSeconds)
	for _, name := range stale {
		if err := collection.Indexes().DropOne(ctx, name); err != nil {
			if !isIndexNotFoundError(err) && !profile.Retryable(err) {
				return "", err
			}
		}
	}

	afterDrop := initial
	if len(stale) > 0 {
		afterDrop, err = s.listIndexes(ctx, collection)
		if err != nil {
			return "", err
		}
	}
	if hasDesiredManagedTTLIndex(afterDrop, expireAfterSeconds) {
		return TtlReconcileUpdated, nil
	}
	if blocking, found := findBlockingNonTTLCreatedAtIndex(afterDrop, profile.IndexName); found {
		return "", errors.New(profile.ConflictMessage(blocking))
	}

	// The managed TTL window is 1..3650 days, so the int32 seconds field never
	// overflows; the conversion is explicit to keep the API contract visible.
	seconds := int32(expireAfterSeconds)
	if _, err := collection.Indexes().CreateOne(ctx, mongo.IndexModel{
		Keys:    bson.D{{Key: "createdAt", Value: 1}},
		Options: options.Index().SetName(profile.IndexName).SetExpireAfterSeconds(seconds),
	}); err != nil {
		return "", err
	}
	return TtlReconcileUpdated, nil
}

// listIndexes reads the collection's indexes. A missing collection
// (NamespaceNotFound) is a valid empty list, which is what lets the first
// write on a fresh deployment succeed instead of returning 500 (TTL-01).
func (s *Service) listIndexes(ctx context.Context, collection *mongo.Collection) (indexList, error) {
	cursor, err := collection.Indexes().List(ctx)
	if err != nil {
		if isNamespaceNotFoundError(err) {
			return indexList{}, nil
		}
		return nil, err
	}
	defer func() {
		_ = cursor.Close(ctx)
	}()
	var documents []rawIndexDocument
	if err := cursor.All(ctx, &documents); err != nil {
		if isNamespaceNotFoundError(err) {
			return indexList{}, nil
		}
		return nil, err
	}
	return parseIndexList(documents), nil
}

// taskLogTTLIndexProfile is the task-log reconciliation profile.
func taskLogTTLIndexProfile() ttlIndexProfile {
	return ttlIndexProfile{
		IndexName: taskLogTTLIndexName,
		ConflictMessage: func(name string) string {
			return fmt.Sprintf("Cannot apply TaskLog TTL index: existing non-TTL createdAt index (%s) would conflict", name)
		},
		Retryable: taskLogRetryableIndexError,
	}
}

// llmRequestLogTTLIndexProfile is the llm-request-log reconciliation profile.
func llmRequestLogTTLIndexProfile() ttlIndexProfile {
	return ttlIndexProfile{
		IndexName: llmRequestLogTTLIndexName,
		ConflictMessage: func(name string) string {
			return fmt.Sprintf("Cannot apply LLM request log TTL index: existing non-TTL createdAt index (%s) would conflict", name)
		},
		Retryable: llmRequestLogRetryableIndexError,
	}
}

// ---- Mongo error inspection ----

// mongoErrorDetails extracts the driver's code, codeName and message from a
// command error or a write exception, mirroring how NestJS reads error.code,
// error.codeName and error.message.
func mongoErrorDetails(err error) (int64, string, string) {
	var commandError *mongo.CommandError
	if errors.As(err, &commandError) {
		return int64(commandError.Code), commandError.Name, err.Error()
	}
	var writeException *mongo.WriteException
	if errors.As(err, &writeException) {
		if len(writeException.WriteErrors) > 0 {
			writeError := writeException.WriteErrors[0]
			return int64(writeError.Code), "", writeError.Message
		}
		if writeException.WriteConcernError != nil {
			return int64(writeException.WriteConcernError.Code), writeException.WriteConcernError.Name, err.Error()
		}
	}
	var bulkException *mongo.BulkWriteException
	if errors.As(err, &bulkException) {
		if len(bulkException.WriteErrors) > 0 {
			bulkError := bulkException.WriteErrors[0]
			return int64(bulkError.Code), "", bulkError.Message
		}
	}
	return 0, "", err.Error()
}

// isNamespaceNotFoundError reports MongoDB error 26 in either of the two forms
// the server may use.
func isNamespaceNotFoundError(err error) bool {
	code, name, _ := mongoErrorDetails(err)
	return code == 26 || name == "NamespaceNotFound"
}

// isIndexNotFoundError reports MongoDB error 27 in either form. A dropped index
// that another writer already removed must not fail the reconciliation.
func isIndexNotFoundError(err error) bool {
	code, name, _ := mongoErrorDetails(err)
	return code == 27 || name == "IndexNotFound"
}

// taskLogRetryableIndexError mirrors TaskLogSettingsService.isRetryableIndexError.
func taskLogRetryableIndexError(err error) bool {
	code, name, _ := mongoErrorDetails(err)
	switch code {
	case 85, 86, 91, 112, 12586:
		return true
	}
	switch name {
	case "IndexOptionsConflict", "IndexKeySpecsConflict", "ShutdownInProgress",
		"WriteConflict", "BackgroundOperationInProgressForNamespace":
		return true
	}
	return false
}

// llmRequestLogRetryableIndexError mirrors
// LlmRequestLogSettingsService.isRetryableIndexError, including the lowercase
// message-substring fallbacks.
func llmRequestLogRetryableIndexError(err error) bool {
	code, name, message := mongoErrorDetails(err)
	switch code {
	case 85, 86, 11000, 12586, 12587, 285:
		return true
	}
	switch name {
	case "IndexOptionsConflict", "IndexKeySpecsConflict", "IndexBuildAlreadyInProgress",
		"BackgroundOperationInProgressForNamespace", "BackgroundOperationInProgressForDatabase":
		return true
	}
	lowerMessage := strings.ToLower(message)
	return strings.Contains(lowerMessage, "index build") ||
		strings.Contains(lowerMessage, "already exists") ||
		strings.Contains(lowerMessage, "conflict") ||
		strings.Contains(lowerMessage, "in progress")
}

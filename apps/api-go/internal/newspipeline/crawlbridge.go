package newspipeline

// This file ports NewsPipelineCrawlBridgeService plus the URL canonicalization
// helpers of apps/api/src/modules/crawl/url-fingerprint.ts and
// packages/utils/src/url-canonical.ts. It also owns the small ordered-JSON and
// database/Mongo adapters the clean stage shares (they live here because the
// crawl bridge is the only place that must merge stored JSON documents in
// JavaScript spread order).
//
// The bridge never consumes a crawl queue: the migrated crawl executor runs the
// task synchronously in-process (CrawlExecutor.RunTask). Everything else is the
// Prisma/Mongoose access of the NestJS service translated to SQL and the Mongo
// driver:
//
//   - findRecentStoredCrawlResultId (url fingerprint first, raw URL fallback);
//   - crawlViaCrawlTask (reuse/create NewsPipeline CrawlTask, run it, pick the
//     best CrawlResult candidate and report an alternative selection);
//   - the candidate scoring used for the "best result" selection.

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
	"golang.org/x/net/idna"
	"golang.org/x/text/collate"
	"golang.org/x/text/language"

	"github.com/wei500L/newwei/apps/api-go/internal/crawloptions"
	"github.com/wei500L/newwei/apps/api-go/internal/newssources"
)

const (
	crawlResultContentsCollection = "crawlresultcontents"
	processedItemsCollection      = "processeditems"

	newsPipelineDisplayNamePrefix = "NewsPipeline:"
	newsSourceDisplayNamePrefix   = "NewsSource:"
	maxCrawlDisplayNameUnits      = 80
	maxCrawlResultCandidates      = 12
)

// --- ordered JSON documents (JavaScript spread/JSON.stringify semantics) ---

// contentOrderedJSON is an insertion-ordered JSON object. It exists to merge
// schema-less documents the way the NestJS service does with object spread:
// overriding an existing key keeps its original position, a new key is appended,
// and a member assigned `undefined` keeps its slot but is dropped when the
// object is serialized (JSON.stringify).
type contentOrderedJSON struct {
	keys   []string
	values map[string]json.RawMessage
}

// contentNewOrderedJSON returns an empty ordered object.
func contentNewOrderedJSON() *contentOrderedJSON {
	return &contentOrderedJSON{values: map[string]json.RawMessage{}}
}

// contentParseOrderedJSON decodes a JSON object preserving member order. It
// returns false for a nil/invalid value or a non-object document.
func contentParseOrderedJSON(raw json.RawMessage) (*contentOrderedJSON, bool) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || trimmed[0] != '{' {
		return nil, false
	}
	decoder := json.NewDecoder(bytes.NewReader(trimmed))
	token, err := decoder.Token()
	if err != nil {
		return nil, false
	}
	if delimiter, ok := token.(json.Delim); !ok || delimiter != '{' {
		return nil, false
	}
	object := contentNewOrderedJSON()
	for decoder.More() {
		keyToken, err := decoder.Token()
		if err != nil {
			return nil, false
		}
		key, ok := keyToken.(string)
		if !ok {
			return nil, false
		}
		var value json.RawMessage
		if err := decoder.Decode(&value); err != nil {
			return nil, false
		}
		if _, exists := object.values[key]; !exists {
			object.keys = append(object.keys, key)
		}
		object.values[key] = value
	}
	return object, true
}

// contentJSONObjectOrEmpty never fails: a missing/non-object value becomes an
// empty ordered object.
func contentJSONObjectOrEmpty(raw json.RawMessage) *contentOrderedJSON {
	if object, ok := contentParseOrderedJSON(raw); ok {
		return object
	}
	return contentNewOrderedJSON()
}

// setRaw stores a member. A nil value records the JavaScript property slot
// (`key: undefined`) so a later spread keeps its position while serialization
// drops it.
func (o *contentOrderedJSON) setRaw(key string, value json.RawMessage) {
	if o == nil {
		return
	}
	if _, exists := o.values[key]; !exists {
		o.keys = append(o.keys, key)
	}
	if value == nil {
		o.values[key] = nil
		return
	}
	o.values[key] = contentTrimJSON(value)
}

// setString stores a string member serialized like JSON.stringify.
func (o *contentOrderedJSON) setString(key, value string) {
	o.setRaw(key, contentEncodeJSONString(value))
}

// setBool stores a boolean member.
func (o *contentOrderedJSON) setBool(key string, value bool) {
	if value {
		o.setRaw(key, json.RawMessage("true"))
		return
	}
	o.setRaw(key, json.RawMessage("false"))
}

// setNull stores an explicit null member.
func (o *contentOrderedJSON) setNull(key string) {
	o.setRaw(key, json.RawMessage("null"))
}

// setNumber stores an integer member.
func (o *contentOrderedJSON) setNumber(key string, value int) {
	o.setRaw(key, json.RawMessage(strconv.Itoa(value)))
}

// lookup reports the stored raw member and whether the key exists (a key whose
// value was assigned undefined exists but has no bytes).
func (o *contentOrderedJSON) lookup(key string) (json.RawMessage, bool) {
	if o == nil {
		return nil, false
	}
	value, ok := o.values[key]
	return value, ok
}

// defined returns the member when the key exists and the value is neither null
// nor undefined, mirroring the `??` operator.
func (o *contentOrderedJSON) defined(key string) json.RawMessage {
	value, ok := o.lookup(key)
	if !ok {
		return nil
	}
	return contentNonNullishJSON(value)
}

// merge spreads other over o with JavaScript key-order semantics.
func (o *contentOrderedJSON) merge(other *contentOrderedJSON) {
	if o == nil || other == nil {
		return
	}
	for _, key := range other.keys {
		o.setRaw(key, other.values[key])
	}
}

// clone returns a defensive copy.
func (o *contentOrderedJSON) clone() *contentOrderedJSON {
	if o == nil {
		return contentNewOrderedJSON()
	}
	copyObject := contentNewOrderedJSON()
	copyObject.keys = append(copyObject.keys, o.keys...)
	for key, value := range o.values {
		copyObject.values[key] = value
	}
	return copyObject
}

// marshal serializes the object like JSON.stringify: undefined members and
// their separators disappear, the remaining key order is preserved.
func (o *contentOrderedJSON) marshal() json.RawMessage {
	var buffer bytes.Buffer
	buffer.WriteByte('{')
	first := true
	for _, key := range o.keys {
		value, ok := o.values[key]
		if !ok || len(value) == 0 {
			continue
		}
		if !first {
			buffer.WriteByte(',')
		}
		first = false
		buffer.Write(contentEncodeJSONString(key))
		buffer.WriteByte(':')
		buffer.Write(contentTrimJSON(value))
	}
	buffer.WriteByte('}')
	return buffer.Bytes()
}

// contentTrimJSON strips surrounding whitespace.
func contentTrimJSON(raw json.RawMessage) json.RawMessage {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 {
		return nil
	}
	return json.RawMessage(trimmed)
}

// contentIsNullishJSON reports a nil, empty or JSON null value.
func contentIsNullishJSON(raw json.RawMessage) bool {
	trimmed := contentTrimJSON(raw)
	return len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null"))
}

// contentNonNullishJSON returns the trimmed value unless it is nullish.
func contentNonNullishJSON(raw json.RawMessage) json.RawMessage {
	if contentIsNullishJSON(raw) {
		return nil
	}
	return contentTrimJSON(raw)
}

// contentEncodeJSONString serializes a string like JSON.stringify (no HTML
// escaping, non-ASCII kept as UTF-8).
func contentEncodeJSONString(value string) json.RawMessage {
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(value); err != nil {
		return json.RawMessage(`null`)
	}
	return json.RawMessage(bytes.TrimRight(buffer.Bytes(), "\n"))
}

// contentEncodeJSONArray serializes a string array like JSON.stringify (no HTML
// escaping, [] for an empty/nil slice).
func contentEncodeJSONArray(values []string) json.RawMessage {
	if values == nil {
		values = []string{}
	}
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(values); err != nil {
		return json.RawMessage("[]")
	}
	return json.RawMessage(bytes.TrimRight(buffer.Bytes(), "\n"))
}

// contentIsJSONObject reports whether the raw value is a JSON object.
func contentIsJSONObject(raw json.RawMessage) bool {
	trimmed := contentTrimJSON(raw)
	return len(trimmed) >= 2 && trimmed[0] == '{' && trimmed[len(trimmed)-1] == '}' && json.Valid(trimmed)
}

// contentJSONStringMember returns a member when it is a JSON string.
func contentJSONStringMember(raw json.RawMessage) *string {
	trimmed := contentTrimJSON(raw)
	if len(trimmed) == 0 || trimmed[0] != '"' {
		return nil
	}
	var value string
	if err := json.Unmarshal(trimmed, &value); err != nil {
		return nil
	}
	return &value
}

// contentBSONJSON carries a schema-less BSON value as relaxed extended JSON.
// The decoding mirrors crawlreadtelemetry.RawJSON and newseventsingest.jsonLeaf:
// the raw value is wrapped in a one-element document, re-encoded as JSON and the
// wrapper is stripped afterwards.
type contentBSONJSON []byte

// UnmarshalBSONValue implements bson.ValueUnmarshaler.
func (r *contentBSONJSON) UnmarshalBSONValue(valueType byte, data []byte) error {
	if bson.Type(valueType) == bson.TypeNull || bson.Type(valueType) == bson.TypeUndefined {
		*r = nil
		return nil
	}
	wrapped, err := bson.MarshalExtJSON(
		bson.D{{Key: "v", Value: bson.RawValue{Type: bson.Type(valueType), Value: data}}},
		false,
		false,
	)
	if err != nil {
		return err
	}
	colon := bytes.IndexByte(wrapped, ':')
	if colon < 0 || len(wrapped) < colon+2 || wrapped[len(wrapped)-1] != '}' {
		return errors.New("newspipeline: unexpected extended JSON value")
	}
	inner := bytes.TrimSpace(wrapped[colon+1 : len(wrapped)-1])
	encoded := make([]byte, len(inner))
	copy(encoded, inner)
	*r = contentBSONJSON(encoded)
	return nil
}

// raw returns the JSON bytes (nil when the BSON value was null/absent).
func (r contentBSONJSON) raw() json.RawMessage {
	if len(r) == 0 {
		return nil
	}
	return json.RawMessage(r)
}

// --- SQL access -------------------------------------------------------------

// contentRow is the subset of *sql.Row the read paths use.
type contentRow interface {
	Scan(dest ...any) error
}

// contentRows is the subset of *sql.Rows the read paths use.
type contentRows interface {
	Next() bool
	Scan(dest ...any) error
	Err() error
	Close() error
}

// contentSQL is the MySQL surface of the pipeline reads/writes. It is an
// interface only so unit tests can script rows; production wraps *sql.DB.
type contentSQL interface {
	queryRowContext(ctx context.Context, query string, args ...any) contentRow
	queryContext(ctx context.Context, query string, args ...any) (contentRows, error)
	execContext(ctx context.Context, query string, args ...any) (sql.Result, error)
}

type contentSQLDB struct {
	db *sql.DB
}

func (r contentSQLDB) queryRowContext(ctx context.Context, query string, args ...any) contentRow {
	return r.db.QueryRowContext(ctx, query, args...)
}

func (r contentSQLDB) queryContext(ctx context.Context, query string, args ...any) (contentRows, error) {
	rows, err := r.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	return contentSQLRows{rows: rows}, nil
}

func (r contentSQLDB) execContext(ctx context.Context, query string, args ...any) (sql.Result, error) {
	return r.db.ExecContext(ctx, query, args...)
}

type contentSQLRows struct {
	rows *sql.Rows
}

func (r contentSQLRows) Next() bool             { return r.rows.Next() }
func (r contentSQLRows) Scan(dest ...any) error { return r.rows.Scan(dest...) }
func (r contentSQLRows) Err() error             { return r.rows.Err() }
func (r contentSQLRows) Close() error           { return r.rows.Close() }
func newContentSQL(db *sql.DB) contentSQL {
	if db == nil {
		return nil
	}
	return contentSQLDB{db: db}
}

// --- Mongo content reads ----------------------------------------------------

// crawlbridgeContentDoc is the projection of a crawlresultcontents document the
// pipeline reads (CrawlResultContent model). Only the members on the call path
// are mapped; the schema-less metadata is kept as raw JSON.
type crawlbridgeContentDoc struct {
	Markdown              *string         `bson:"markdown"`
	MarkdownWithCitations *string         `bson:"markdownWithCitations"`
	RawMarkdown           *string         `bson:"rawMarkdown"`
	FitMarkdown           *string         `bson:"fitMarkdown"`
	ReferencesMarkdown    *string         `bson:"referencesMarkdown"`
	CrawlRunID            *string         `bson:"crawlRunId"`
	Metadata              contentBSONJSON `bson:"metadata"`
}

// fields renders the document as the readMarkdownField/selectBestMarkdown helper
// input.
func (d *crawlbridgeContentDoc) fields() map[string]json.RawMessage {
	record := map[string]json.RawMessage{}
	if d == nil {
		return record
	}
	if d.Markdown != nil {
		record["markdown"] = contentEncodeJSONString(*d.Markdown)
	}
	if d.MarkdownWithCitations != nil {
		record["markdownWithCitations"] = contentEncodeJSONString(*d.MarkdownWithCitations)
	}
	if d.RawMarkdown != nil {
		record["rawMarkdown"] = contentEncodeJSONString(*d.RawMarkdown)
	}
	if d.FitMarkdown != nil {
		record["fitMarkdown"] = contentEncodeJSONString(*d.FitMarkdown)
	}
	if d.ReferencesMarkdown != nil {
		record["referencesMarkdown"] = contentEncodeJSONString(*d.ReferencesMarkdown)
	}
	if metadata := d.Metadata.raw(); metadata != nil {
		record["metadata"] = metadata
	}
	return record
}

// contentReader is the Mongo surface of the pipeline: the crawlresultcontents
// document of a CrawlResult and the result document of a ProcessedItem.
type contentReader interface {
	crawlResultContentByID(ctx context.Context, contentID string) (*crawlbridgeContentDoc, error)
	crawlResultContentsByResultIDs(ctx context.Context, resultIDs []string) (map[string]*crawlbridgeContentDoc, error)
	processedItemResultByID(ctx context.Context, ref string) (json.RawMessage, bool, error)
}

// mongoContentReader is the production content reader.
type mongoContentReader struct {
	db *mongo.Database
}

func (r *mongoContentReader) crawlResultContentByID(ctx context.Context, contentID string) (*crawlbridgeContentDoc, error) {
	if r == nil || r.db == nil {
		return nil, errors.New("newspipeline: mongo is not configured")
	}
	objectID, err := bson.ObjectIDFromHex(contentID)
	if err != nil {
		return nil, fmt.Errorf("Cast to ObjectId failed for value %q at path \"_id\"", contentID)
	}
	var document crawlbridgeContentDoc
	err = r.db.Collection(crawlResultContentsCollection).
		FindOne(ctx, bson.D{{Key: "_id", Value: objectID}}).
		Decode(&document)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &document, nil
}

func (r *mongoContentReader) crawlResultContentsByResultIDs(ctx context.Context, resultIDs []string) (map[string]*crawlbridgeContentDoc, error) {
	result := map[string]*crawlbridgeContentDoc{}
	if r == nil || r.db == nil {
		return nil, errors.New("newspipeline: mongo is not configured")
	}
	if len(resultIDs) == 0 {
		return result, nil
	}
	projection := bson.D{
		{Key: "resultId", Value: 1},
		{Key: "markdown", Value: 1},
		{Key: "markdownWithCitations", Value: 1},
		{Key: "rawMarkdown", Value: 1},
		{Key: "fitMarkdown", Value: 1},
	}
	cursor, err := r.db.Collection(crawlResultContentsCollection).Find(ctx,
		bson.D{{Key: "resultId", Value: bson.D{{Key: "$in", Value: resultIDs}}}},
		options.Find().SetProjection(projection))
	if err != nil {
		return nil, err
	}
	defer func() { _ = cursor.Close(ctx) }()
	for cursor.Next(ctx) {
		var row struct {
			ResultID              *string         `bson:"resultId"`
			Markdown              *string         `bson:"markdown"`
			MarkdownWithCitations *string         `bson:"markdownWithCitations"`
			RawMarkdown           *string         `bson:"rawMarkdown"`
			FitMarkdown           *string         `bson:"fitMarkdown"`
			Metadata              contentBSONJSON `bson:"metadata"`
		}
		if err := cursor.Decode(&row); err != nil {
			return nil, err
		}
		if row.ResultID == nil {
			continue
		}
		resultID := strings.TrimSpace(*row.ResultID)
		if resultID == "" {
			continue
		}
		result[resultID] = &crawlbridgeContentDoc{
			Markdown:              row.Markdown,
			MarkdownWithCitations: row.MarkdownWithCitations,
			RawMarkdown:           row.RawMarkdown,
			FitMarkdown:           row.FitMarkdown,
			Metadata:              row.Metadata,
		}
	}
	if err := cursor.Err(); err != nil {
		return nil, err
	}
	return result, nil
}

func (r *mongoContentReader) processedItemResultByID(ctx context.Context, ref string) (json.RawMessage, bool, error) {
	if r == nil || r.db == nil {
		return nil, false, errors.New("newspipeline: mongo is not configured")
	}
	objectID, err := bson.ObjectIDFromHex(ref)
	if err != nil {
		return nil, false, fmt.Errorf("Cast to ObjectId failed for value %q at path \"_id\"", ref)
	}
	var document struct {
		Result contentBSONJSON `bson:"result"`
	}
	err = r.db.Collection(processedItemsCollection).
		FindOne(ctx, bson.D{{Key: "_id", Value: objectID}}).
		Decode(&document)
	if errors.Is(err, mongo.ErrNoDocuments) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	result := document.Result.raw()
	if result == nil {
		return nil, false, nil
	}
	return result, true, nil
}

// newContentReader builds the production Mongo reader.
func newContentReader(db *mongo.Database) contentReader {
	if db == nil {
		return nil
	}
	return &mongoContentReader{db: db}
}

// --- crawl alternative-selection TaskLog ------------------------------------

// crawlAlternateLogger records the "selected an alternative crawl result" TaskLog
// row. It is best effort exactly like writeTaskLogBestEffort.
type crawlAlternateLogger interface {
	logAlternateSelection(ctx context.Context, orgID, crawlTaskID, preferredResultID, selectedResultID, preferredSourceURL string) error
}

type mongoCrawlAlternateLogger struct {
	db *mongo.Database
}

func (l *mongoCrawlAlternateLogger) logAlternateSelection(ctx context.Context, orgID, crawlTaskID, preferredResultID, selectedResultID, preferredSourceURL string) error {
	if l == nil || l.db == nil {
		return errors.New("newspipeline: mongo is not configured")
	}
	now := time.Now().UTC()
	document := bson.D{
		{Key: "queue", Value: "news_pipeline"},
		{Key: "jobId", Value: crawlTaskID},
		{Key: "orgId", Value: orgID},
		{Key: "stage", Value: "crawl"},
		{Key: "status", Value: "completed"},
		{Key: "message", Value: "Selected alternative crawl result for higher content quality"},
		{Key: "data", Value: bson.D{
			{Key: "preferredResultId", Value: preferredResultID},
			{Key: "selectedResultId", Value: selectedResultID},
			{Key: "preferredSourceUrl", Value: preferredSourceURL},
		}},
		{Key: "createdAt", Value: now},
		{Key: "updatedAt", Value: now},
		{Key: "__v", Value: 0},
	}
	_, err := l.db.Collection(taskLogsCollection).InsertOne(ctx, document)
	return err
}

func newCrawlAlternateLogger(db *mongo.Database) crawlAlternateLogger {
	if db == nil {
		return nil
	}
	return &mongoCrawlAlternateLogger{db: db}
}

// --- crawl bridge -----------------------------------------------------------

// crawlTaskResult is the crawlViaCrawlTask return value.
type crawlTaskResult struct {
	CrawlResultID string
	CrawlTaskID   string
}

// crawlBridge ports NewsPipelineCrawlBridgeService.
type crawlBridge struct {
	sql       contentSQL
	contents  contentReader
	crawl     CrawlExecutor
	config    NewsPipelineConfig
	now       func() time.Time
	alternate crawlAlternateLogger

	actorMu      sync.Mutex
	actorByOrgID map[string]string
}

// newCrawlBridge wires the bridge. Nil collaborators disable only the branch
// that needs them (production always provides DB, Mongo, Crawl and Config).
func newCrawlBridge(db *sql.DB, mongoDB *mongo.Database, crawl CrawlExecutor, config NewsPipelineConfig, now func() time.Time) *crawlBridge {
	if now == nil {
		now = time.Now
	}
	return &crawlBridge{
		sql:          newContentSQL(db),
		contents:     newContentReader(mongoDB),
		crawl:        crawl,
		config:       config,
		now:          now,
		alternate:    newCrawlAlternateLogger(mongoDB),
		actorByOrgID: map[string]string{},
	}
}

// bridgeNow is the Prisma-compatible millisecond clock.
func (b *crawlBridge) bridgeNow() time.Time {
	return b.now().UTC().Truncate(time.Millisecond)
}

// findRecentStoredCrawlResultID ports findRecentStoredCrawlResultId: the
// canonical URL fingerprint lookup first, then the raw sourceUrl fallback.
func (b *crawlBridge) findRecentStoredCrawlResultID(ctx context.Context, orgID, rawURL string, since time.Time, queryParamAllowlist []string) (string, error) {
	if b.sql == nil {
		return "", errors.New("newspipeline: mysql is not configured")
	}
	if _, fingerprint, ok := crawlbridgeBuildCanonicalURLFingerprint(rawURL, queryParamAllowlist); ok {
		var id string
		err := b.sql.queryRowContext(ctx,
			"SELECT `id` FROM `CrawlResult` WHERE `orgId` = ? AND `sourceUrlFingerprint` = ? AND `fetchedAt` >= ? ORDER BY `fetchedAt` DESC LIMIT 1",
			orgID, fingerprint, since).Scan(&id)
		switch {
		case err == nil:
			if id != "" {
				return id, nil
			}
		case errors.Is(err, sql.ErrNoRows):
			// fall through to the raw URL lookup
		default:
			return "", err
		}
	}

	var fallbackID string
	err := b.sql.queryRowContext(ctx,
		"SELECT `id` FROM `CrawlResult` WHERE `orgId` = ? AND `sourceUrl` = ? AND `fetchedAt` >= ? ORDER BY `fetchedAt` DESC LIMIT 1",
		orgID, rawURL, since).Scan(&fallbackID)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	return fallbackID, nil
}

// buildCrawlTaskOptions ports buildCrawlTaskOptions: the config crawler
// defaults, the stored markdown options, the per-payload crawl options and the
// resolved user agent merged in NestJS object-spread order, then validated by
// the crawl4ai LLM guard.
func (b *crawlBridge) buildCrawlTaskOptions(payload NormalizedPayload) (json.RawMessage, error) {
	cfg := b.config.Crawl4AI
	defaults := contentJSONObjectOrEmpty(cfg.CrawlerDefaults)
	options := defaults.clone()

	cleanMarkdown := contentNonNullishJSON(cfg.CleanMarkdown)
	if cleanMarkdown == nil {
		cleanMarkdown = defaults.defined("cleanMarkdown")
	}
	options.setRaw("cleanMarkdown", cleanMarkdown)

	markdownOptions := contentNonNullishJSON(cfg.Markdown)
	if markdownOptions == nil {
		markdownOptions = defaults.defined("markdownOptions")
	}
	options.setRaw("markdownOptions", markdownOptions)

	crawlOptions, _ := contentParseOrderedJSON(payload.CrawlOptions)
	if crawlOptions != nil {
		options.merge(crawlOptions)
	}

	userAgent := json.RawMessage(nil)
	if crawlOptions != nil {
		userAgent = crawlOptions.defined("userAgent")
	}
	if userAgent == nil {
		userAgent = defaults.defined("userAgent")
	}
	if userAgent == nil && cfg.UserAgent != "" {
		userAgent = contentEncodeJSONString(cfg.UserAgent)
	}
	options.setRaw("userAgent", userAgent)

	merged := options.marshal()
	if err := crawloptions.AssertNoCrawl4aiLlmOptions(merged, "newsPipeline.crawlOptions"); err != nil {
		return nil, err
	}
	return merged, nil
}

// resolveCrawlActorID ports resolveCrawlActorId: the oldest membership of the
// org, cached per org exactly like the NestJS Map.
func (b *crawlBridge) resolveCrawlActorID(ctx context.Context, orgID string) (string, error) {
	b.actorMu.Lock()
	cached := b.actorByOrgID[orgID]
	b.actorMu.Unlock()
	if cached != "" {
		return cached, nil
	}
	if b.sql == nil {
		return "", errors.New("newspipeline: mysql is not configured")
	}
	var userID string
	err := b.sql.queryRowContext(ctx,
		"SELECT `userId` FROM `Membership` WHERE `orgId` = ? ORDER BY `createdAt` ASC LIMIT 1",
		orgID).Scan(&userID)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	userID = strings.TrimSpace(userID)
	if userID == "" {
		return "", nil
	}
	b.actorMu.Lock()
	b.actorByOrgID[orgID] = userID
	b.actorMu.Unlock()
	return userID, nil
}

// crawlViaCrawlTask ports crawlViaCrawlTask.
func (b *crawlBridge) crawlViaCrawlTask(ctx context.Context, orgID, rawURL string, payload NormalizedPayload) (crawlTaskResult, error) {
	if b.sql == nil {
		return crawlTaskResult{}, errors.New("newspipeline: mysql is not configured")
	}
	crawlOptions, err := b.buildCrawlTaskOptions(payload)
	if err != nil {
		return crawlTaskResult{}, err
	}
	urlQueryParamAllowlist := extractUrlQueryParamAllowlist(payload)
	orgContentDedupeWindowHours := extractSeedDedupeWindowHours(payload)

	crawlTaskConfig, _ := contentParseOrderedJSON(crawlOptions)
	if crawlTaskConfig == nil {
		crawlTaskConfig = contentNewOrderedJSON()
	}
	if len(urlQueryParamAllowlist) > 0 {
		crawlTaskConfig.setRaw("urlQueryParamAllowlist", contentEncodeJSONArray(urlQueryParamAllowlist))
	}
	if orgContentDedupeWindowHours != nil {
		crawlTaskConfig.setNumber("orgContentDedupeWindowHours", *orgContentDedupeWindowHours)
	}
	configJSON := crawlTaskConfig.marshal()

	displayNameLabel := ""
	if payload.SourceName != nil {
		displayNameLabel = strings.TrimSpace(*payload.SourceName)
	}
	if displayNameLabel == "" {
		if parsed, parseErr := url.Parse(rawURL); parseErr == nil && parsed.Hostname() != "" {
			// new URL(url).hostname is lower-case.
			displayNameLabel = strings.ToLower(parsed.Hostname())
		} else {
			displayNameLabel = rawURL
		}
	}
	displayName := truncateUTF16(newsPipelineDisplayNamePrefix+" "+displayNameLabel, maxCrawlDisplayNameUnits)

	keywordsJSON := contentEncodeJSONArray(payload.Keywords)

	var crawlTaskID string
	err = b.sql.queryRowContext(ctx,
		"SELECT `id` FROM `CrawlTask` WHERE `orgId` = ? AND `targetUrl` = ? AND (`displayName` LIKE '"+newsPipelineDisplayNamePrefix+"%' OR `displayName` LIKE '"+newsSourceDisplayNamePrefix+"%') ORDER BY `createdAt` DESC LIMIT 1",
		orgID, rawURL).Scan(&crawlTaskID)
	if errors.Is(err, sql.ErrNoRows) {
		crawlTaskID = ""
	} else if err != nil {
		return crawlTaskResult{}, err
	}

	if crawlTaskID != "" {
		now := b.bridgeNow()
		if _, err := b.sql.execContext(ctx,
			"UPDATE `CrawlTask` SET `displayName` = ?, `keywords` = ?, `config` = ?, `updatedAt` = ? WHERE `id` = ?",
			displayName, string(keywordsJSON), string(configJSON), now, crawlTaskID); err != nil {
			return crawlTaskResult{}, err
		}
	} else {
		actorID, err := b.resolveCrawlActorID(ctx, orgID)
		if err != nil {
			return crawlTaskResult{}, err
		}
		if actorID == "" {
			return crawlTaskResult{}, errors.New("crawl task actor unavailable")
		}
		taskID, err := crawlbridgeNewRowID()
		if err != nil {
			return crawlTaskResult{}, err
		}
		now := b.bridgeNow()
		if _, err := b.sql.execContext(ctx,
			"INSERT INTO `CrawlTask` (`id`, `orgId`, `createdById`, `targetUrl`, `displayName`, `status`, `concurrency`, `keywords`, `config`, `runCount`, `createdAt`, `updatedAt`)"+
				" VALUES (?, ?, ?, ?, ?, 'pending', 1, ?, ?, 0, ?, ?)",
			taskID, orgID, actorID, rawURL, displayName, string(keywordsJSON), string(configJSON), now, now); err != nil {
			return crawlTaskResult{}, err
		}
		crawlTaskID = taskID
	}

	if b.crawl == nil {
		return crawlTaskResult{}, errors.New("crawl executor unavailable")
	}
	summary, err := b.crawl.RunTask(ctx, orgID, crawlTaskID)
	if err != nil {
		return crawlTaskResult{}, err
	}
	reusedResultID := strings.TrimSpace(summary.ReusedResultID)

	preferredResultID := ""
	if reusedResultID != "" {
		var id string
		err := b.sql.queryRowContext(ctx,
			"SELECT `id` FROM `CrawlResult` WHERE `id` = ? AND `orgId` = ? LIMIT 1",
			reusedResultID, orgID).Scan(&id)
		switch {
		case err == nil:
			preferredResultID = id
		case errors.Is(err, sql.ErrNoRows):
		default:
			return crawlTaskResult{}, err
		}
	}
	if preferredResultID == "" {
		var id string
		err := b.sql.queryRowContext(ctx,
			"SELECT `id` FROM `CrawlResult` WHERE `taskId` = ? AND `sourceUrl` = ? AND `orgId` = ? ORDER BY `fetchedAt` DESC LIMIT 1",
			crawlTaskID, rawURL, orgID).Scan(&id)
		switch {
		case err == nil:
			preferredResultID = id
		case errors.Is(err, sql.ErrNoRows):
		default:
			return crawlTaskResult{}, err
		}
	}
	if preferredResultID == "" {
		var id string
		err := b.sql.queryRowContext(ctx,
			"SELECT `id` FROM `CrawlResult` WHERE `taskId` = ? AND `orgId` = ? ORDER BY `fetchedAt` DESC LIMIT 1",
			crawlTaskID, orgID).Scan(&id)
		switch {
		case err == nil:
			preferredResultID = id
		case errors.Is(err, sql.ErrNoRows):
		default:
			return crawlTaskResult{}, err
		}
	}
	if preferredResultID == "" {
		return crawlTaskResult{}, errors.New("crawl task produced no results")
	}

	crawlResultID, err := b.selectBestPipelineCrawlResultID(ctx, orgID, crawlTaskID, preferredResultID, rawURL)
	if err != nil {
		return crawlTaskResult{}, err
	}
	return crawlTaskResult{CrawlResultID: crawlResultID, CrawlTaskID: crawlTaskID}, nil
}

// selectBestPipelineCrawlResultID ports selectBestPipelineCrawlResultId.
func (b *crawlBridge) selectBestPipelineCrawlResultID(ctx context.Context, orgID, crawlTaskID, preferredResultID, preferredSourceURL string) (string, error) {
	rows, err := b.sql.queryContext(ctx,
		fmt.Sprintf("SELECT `id`, `sourceUrl` FROM `CrawlResult` WHERE `taskId` = ? AND `orgId` = ? ORDER BY `fetchedAt` DESC LIMIT %d", maxCrawlResultCandidates),
		crawlTaskID, orgID)
	if err != nil {
		return "", err
	}
	defer func() { _ = rows.Close() }()

	var candidateIDs []string
	var candidateSourceURLs []string
	for rows.Next() {
		var id string
		var sourceURL sql.NullString
		if err := rows.Scan(&id, &sourceURL); err != nil {
			return "", err
		}
		candidateIDs = append(candidateIDs, id)
		if sourceURL.Valid {
			candidateSourceURLs = append(candidateSourceURLs, sourceURL.String)
		} else {
			candidateSourceURLs = append(candidateSourceURLs, "")
		}
	}
	if err := rows.Err(); err != nil {
		return "", err
	}
	if len(candidateIDs) == 0 {
		return preferredResultID, nil
	}

	contents, err := b.loadPipelineCrawlResultCandidateContent(ctx, candidateIDs)
	if err != nil {
		return "", err
	}

	bestID := preferredResultID
	bestScore := math.Inf(-1)
	for index, candidateID := range candidateIDs {
		if candidateID == "" {
			continue
		}
		score := b.scorePipelineCrawlResultCandidate(candidateSourceURLs[index], contents[candidateID], preferredSourceURL)
		if score > bestScore {
			bestScore = score
			bestID = candidateID
		}
	}

	if bestID != preferredResultID && b.alternate != nil {
		_ = b.alternate.logAlternateSelection(ctx, orgID, crawlTaskID, preferredResultID, bestID, preferredSourceURL)
	}
	return bestID, nil
}

// loadPipelineCrawlResultCandidateContent ports
// loadPipelineCrawlResultCandidateContent.
func (b *crawlBridge) loadPipelineCrawlResultCandidateContent(ctx context.Context, resultIDs []string) (map[string]*crawlbridgeContentDoc, error) {
	normalized := make([]string, 0, len(resultIDs))
	seen := map[string]bool{}
	for _, resultID := range resultIDs {
		trimmed := strings.TrimSpace(resultID)
		if trimmed == "" || seen[trimmed] {
			continue
		}
		seen[trimmed] = true
		normalized = append(normalized, trimmed)
	}
	if len(normalized) == 0 {
		return map[string]*crawlbridgeContentDoc{}, nil
	}
	if b.contents == nil {
		return nil, errors.New("newspipeline: mongo is not configured")
	}
	return b.contents.crawlResultContentsByResultIDs(ctx, normalized)
}

// scorePipelineCrawlResultCandidate ports scorePipelineCrawlResultCandidate.
func (b *crawlBridge) scorePipelineCrawlResultCandidate(sourceURL string, doc *crawlbridgeContentDoc, preferredSourceURL string) float64 {
	if doc == nil {
		return math.Inf(-1)
	}
	selectedMarkdown := selectBestMarkdownFromContentDoc(doc.fields())
	if selectedMarkdown == nil {
		return math.Inf(-1)
	}
	normalized := strings.TrimSpace(*selectedMarkdown)
	if normalized == "" {
		return math.Inf(-1)
	}
	words := len(strings.Fields(normalized))
	paragraphs := len(crawlbridgeSplitParagraphs(normalized))
	isChallenge := isLikelyBotChallengeMarkdown(normalized)

	// String.prototype.length counts UTF-16 code units.
	score := math.Min(float64(utf16Length(normalized)), 24000) +
		math.Min(float64(words), 12000) +
		math.Min(float64(paragraphs), 200)*4
	if sourceURL == preferredSourceURL {
		score += 120
	}
	if isChallenge {
		score -= 16000
	}
	return score
}

// --- URL fingerprint (crawl/url-fingerprint.ts + packages/utils) ------------

// crawlbridgeResolveQueryParamAllowlist ports resolveQueryParamAllowlist with the
// default fallback; a nil input means "use the defaults".
func crawlbridgeResolveQueryParamAllowlist(value []string) []string {
	if value == nil {
		return newssources.NormalizeURLQueryParamAllowlist(nil, newssources.DefaultURLQueryParamAllowlist)
	}
	return newssources.NormalizeURLQueryParamAllowlist(value, nil)
}

// crawlbridgeBuildCanonicalURLFingerprint is buildCanonicalUrlFingerprint.
func crawlbridgeBuildCanonicalURLFingerprint(value string, queryParamAllowlist []string) (canonicalURL string, fingerprint string, ok bool) {
	canonical, ok := crawlbridgeCanonicalizeURLWithQueryAllowlist(value, queryParamAllowlist)
	if !ok {
		return "", "", false
	}
	sum := sha256.Sum256([]byte(canonical))
	return canonical, hex.EncodeToString(sum[:]), true
}

// crawlbridgeCanonicalizeURLWithQueryAllowlist is
// canonicalizeUrlWithQueryAllowlist.
func crawlbridgeCanonicalizeURLWithQueryAllowlist(value string, queryParamAllowlist []string) (string, bool) {
	parsed, ok := crawlbridgeParseHTTPURL(value)
	if !ok {
		return "", false
	}
	allowlist := crawlbridgeResolveQueryParamAllowlist(queryParamAllowlist)
	allowed := make(map[string]bool, len(allowlist))
	for _, key := range allowlist {
		allowed[key] = true
	}

	host := strings.ToLower(parsed.Hostname())
	if ascii, err := idna.Lookup.ToASCII(host); err == nil {
		host = ascii
	}
	port := parsed.Port()
	if parsed.Scheme == "http" && port == "80" {
		port = ""
	}
	if parsed.Scheme == "https" && port == "443" {
		port = ""
	}

	path := crawlbridgeNormalizeCanonicalPath(parsed.EscapedPath())
	query := crawlbridgeNormalizeCanonicalSearch(parsed.RawQuery, allowed)

	var builder strings.Builder
	builder.WriteString(parsed.Scheme)
	builder.WriteString("://")
	builder.WriteString(host)
	if port != "" {
		builder.WriteString(":")
		builder.WriteString(port)
	}
	builder.WriteString(path)
	if query != "" {
		builder.WriteString("?")
		builder.WriteString(query)
	}
	return builder.String(), true
}

// crawlbridgeParseHTTPURL is parseHttpUrl: a missing scheme defaults to
// https://, only http/https survive.
func crawlbridgeParseHTTPURL(value string) (*url.URL, bool) {
	trimmed := crawlbridgeTrimJS(value)
	if trimmed == "" {
		return nil, false
	}
	withProtocol := trimmed
	lowered := strings.ToLower(trimmed)
	if !strings.HasPrefix(lowered, "http://") && !strings.HasPrefix(lowered, "https://") {
		withProtocol = "https://" + trimmed
	}
	parsed, err := url.Parse(withProtocol)
	if err != nil {
		return nil, false
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return nil, false
	}
	if parsed.Hostname() == "" {
		return nil, false
	}
	parsed.Fragment = ""
	parsed.RawFragment = ""
	parsed.User = nil
	return parsed, true
}

// crawlbridgeNormalizeCanonicalPath ports normalizePathname: collapse repeated
// slashes and drop the trailing slash unless the path is exactly "/".
func crawlbridgeNormalizeCanonicalPath(escapedPath string) string {
	if escapedPath == "" {
		return "/"
	}
	segments := strings.Split(escapedPath, "/")
	resolved := make([]string, 0, len(segments))
	for index, segment := range segments {
		if segment == "" {
			if index == 0 {
				resolved = append(resolved, "")
			}
			continue
		}
		if segment == "." {
			continue
		}
		if segment == ".." {
			if len(resolved) > 1 {
				resolved = resolved[:len(resolved)-1]
			}
			continue
		}
		resolved = append(resolved, segment)
	}
	if len(resolved) == 0 {
		return "/"
	}
	normalized := strings.Join(resolved, "/")
	if !strings.HasPrefix(normalized, "/") {
		normalized = "/" + normalized
	}
	if normalized == "/" {
		return "/"
	}
	return strings.TrimRight(normalized, "/")
}

// crawlbridgeNormalizeCanonicalSearch keeps the allowlisted pairs, normalizes
// their keys and re-serializes them as application/x-www-form-urlencoded sorted
// by key and value with the root collation.
func crawlbridgeNormalizeCanonicalSearch(rawQuery string, allowed map[string]bool) string {
	if len(allowed) == 0 {
		return ""
	}
	type pair struct {
		key   string
		value string
	}
	accepted := make([]pair, 0, 4)
	for _, field := range strings.Split(rawQuery, "&") {
		if field == "" {
			continue
		}
		rawKey := field
		rawValue := ""
		if index := strings.Index(field, "="); index >= 0 {
			rawKey = field[:index]
			rawValue = field[index+1:]
		}
		key := crawlbridgeNormalizeQueryParamKey(crawlbridgeDecodeFormComponent(rawKey))
		if key == "" || !allowed[key] {
			continue
		}
		accepted = append(accepted, pair{key: key, value: crawlbridgeDecodeFormComponent(rawValue)})
	}
	sort.SliceStable(accepted, func(left, right int) bool {
		if accepted[left].key != accepted[right].key {
			return crawlbridgeLocaleCompare(accepted[left].key, accepted[right].key) < 0
		}
		return crawlbridgeLocaleCompare(accepted[left].value, accepted[right].value) < 0
	})
	var builder strings.Builder
	for index, entry := range accepted {
		if index > 0 {
			builder.WriteString("&")
		}
		builder.WriteString(crawlbridgeEncodeFormComponent(entry.key))
		builder.WriteString("=")
		builder.WriteString(crawlbridgeEncodeFormComponent(entry.value))
	}
	return builder.String()
}

// crawlbridgeNormalizeQueryParamKey is normalizeParamKey.
func crawlbridgeNormalizeQueryParamKey(value string) string {
	trimmed := strings.ToLower(crawlbridgeTrimJS(value))
	if trimmed == "" || len(trimmed) > 64 {
		return ""
	}
	for _, r := range trimmed {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || r == '_' || r == '.' || r == '-' {
			continue
		}
		return ""
	}
	return trimmed
}

// crawlbridgeDecodeFormComponent is URLSearchParams' form decoding.
func crawlbridgeDecodeFormComponent(value string) string {
	decoded, err := url.QueryUnescape(value)
	if err != nil {
		return strings.ReplaceAll(value, "+", " ")
	}
	return decoded
}

// crawlbridgeEncodeFormComponent is URLSearchParams' serializer (the
// application/x-www-form-urlencoded set): only alphanumerics and * - . _ stay
// literal, a space becomes '+', every other UTF-8 byte is percent-encoded.
func crawlbridgeEncodeFormComponent(value string) string {
	var builder strings.Builder
	for _, b := range []byte(value) {
		switch {
		case b >= 'a' && b <= 'z', b >= 'A' && b <= 'Z', b >= '0' && b <= '9':
			builder.WriteByte(b)
		case b == '-', b == '_', b == '.', b == '*':
			builder.WriteByte(b)
		case b == ' ':
			builder.WriteByte('+')
		default:
			const hexDigits = "0123456789ABCDEF"
			builder.WriteByte('%')
			builder.WriteByte(hexDigits[b>>4])
			builder.WriteByte(hexDigits[b&0x0f])
		}
	}
	return builder.String()
}

// crawlbridgeLocaleCompare is a.localeCompare(b) under the default ICU root
// collation.
func crawlbridgeLocaleCompare(left, right string) int {
	if left == right {
		return 0
	}
	return collate.New(language.Und).CompareString(left, right)
}

// crawlbridgeTrimJS is String.prototype.trim (Unicode whitespace and BOM).
func crawlbridgeTrimJS(value string) string {
	return strings.TrimFunc(value, crawlbridgeIsJSSpace)
}

// crawlbridgeIsJSSpace reports the characters String.prototype.trim strips.
func crawlbridgeIsJSSpace(r rune) bool {
	return r == '\uFEFF' || unicode.IsSpace(r)
}

// --- small helpers ----------------------------------------------------------

// crawlbridgeSplitParagraphs splits markdown on /\n\s*\n/ and drops empty
// entries, mirroring the NestJS paragraph count.
func crawlbridgeSplitParagraphs(markdown string) []string {
	parts := splitMarkdownParagraphs(markdown)
	out := make([]string, 0, len(parts))
	for _, part := range parts {
		trimmed := crawlbridgeTrimJS(part)
		if trimmed != "" {
			out = append(out, trimmed)
		}
	}
	return out
}

// crawlbridgeNewRowID writes a Prisma-cuid-shaped primary key (c + 24 hex).
func crawlbridgeNewRowID() (string, error) {
	var buffer [12]byte
	if _, err := rand.Read(buffer[:]); err != nil {
		return "", err
	}
	return "c" + hex.EncodeToString(buffer[:]), nil
}

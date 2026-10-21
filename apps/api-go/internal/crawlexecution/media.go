package crawlexecution

// This file ports the media half of
// apps/api/src/modules/crawl/crawl-result.service.ts: normalizeMediaCollection,
// normalizeMediaItem, normalizeMediaSources, normalizeStringList,
// extractMediaExtras, flattenMediaEntries, pickMediaUrl, buildInlineMediaAsset,
// fetchMediaAsset and collectMediaAssets. The normalized shapes are the ones
// crawlreadtelemetry reads back from the CrawlResultContent `media` field
// (CrawlMediaCollection / CrawlMediaItem / CrawlMediaSource).

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"math"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
)

// mediaReservedKeys is mediaReservedKeys: the item fields with a dedicated slot
// in CrawlMediaItem. Every other key is preserved verbatim under `raw`.
var mediaReservedKeys = map[string]struct{}{
	"src":               {},
	"url":               {},
	"href":              {},
	"alt":               {},
	"title":             {},
	"desc":              {},
	"description":       {},
	"caption":           {},
	"type":              {},
	"media_type":        {},
	"mediaType":         {},
	"format":            {},
	"mime":              {},
	"mimeType":          {},
	"width":             {},
	"height":            {},
	"score":             {},
	"poster":            {},
	"thumbnail":         {},
	"sizes":             {},
	"srcset":            {},
	"srcSet":            {},
	"sources":           {},
	"picture_sources":   {},
	"pictureSources":    {},
	"responsive_images": {},
	"responsiveImages":  {},
}

// mediaCollection is CrawlMediaCollection: Crawl4AI media buckets in the order
// the parsed JSON object lists them (the NestJS Object.entries order that fixes
// which assets the per-result cap keeps).
type mediaCollection struct {
	buckets []mediaBucket
}

// mediaBucket is one `kind` (for example "images") and its normalized items.
type mediaBucket struct {
	Kind  string
	Items []mediaItem
}

// mediaItem is the normalized CrawlMediaItem stored in the Mongo `media`
// buckets. The field order is the normalizeMediaItem insertion order.
type mediaItem struct {
	Src               *string
	Alt               *string
	Title             *string
	Desc              *string
	Type              *string
	Format            *string
	Poster            *string
	Sizes             *string
	Width             *int
	Height            *int
	Score             *float64
	Srcset            []string
	PictureSources    []mediaSource
	ResponsiveSources []mediaSource
	Raw               mediaRawExtras
}

// mediaSource is CrawlMediaSource (a <picture>/responsive source entry).
type mediaSource struct {
	Srcset *string
	Src    *string
	Type   *string
	Media  *string
	Sizes  *string
}

// mediaRawField is one preserved unmatched field. The ordered slice keeps the
// Crawl4AI key order so the stored document is stable.
type mediaRawField struct {
	Key   string
	Value json.RawMessage
}

// mediaRawExtras is CrawlMediaItem.raw (Record<string, unknown>).
type mediaRawExtras []mediaRawField

// mediaEntry is one flattened `{kind, item}` pair.
type mediaEntry struct {
	Kind string
	Item mediaItem
}

// isEmpty reports whether the collection holds no bucket.
func (c *mediaCollection) isEmpty() bool {
	return c == nil || len(c.buckets) == 0
}

// flatten is flattenMediaEntries.
func (c *mediaCollection) flatten() []mediaEntry {
	if c == nil {
		return nil
	}
	total := 0
	for _, bucket := range c.buckets {
		total += len(bucket.Items)
	}
	entries := make([]mediaEntry, 0, total)
	for _, bucket := range c.buckets {
		for _, item := range bucket.Items {
			entries = append(entries, mediaEntry{Kind: bucket.Kind, Item: item})
		}
	}
	return entries
}

// bsonDocument renders the collection as the Mongo `media` document.
func (c *mediaCollection) bsonDocument() (bson.D, error) {
	if c == nil {
		return nil, nil
	}
	document := make(bson.D, 0, len(c.buckets))
	for _, bucket := range c.buckets {
		items := make(bson.A, 0, len(bucket.Items))
		for _, item := range bucket.Items {
			encoded, err := item.bsonDocument()
			if err != nil {
				return nil, err
			}
			items = append(items, encoded)
		}
		document = append(document, bson.E{Key: bucket.Kind, Value: items})
	}
	return document, nil
}

// bsonDocument renders one item in the NestJS key order.
func (i mediaItem) bsonDocument() (bson.D, error) {
	document := bson.D{}
	appendString := func(key string, value *string) {
		if value != nil {
			document = append(document, bson.E{Key: key, Value: *value})
		}
	}
	appendString("src", i.Src)
	appendString("alt", i.Alt)
	appendString("title", i.Title)
	appendString("desc", i.Desc)
	appendString("type", i.Type)
	appendString("format", i.Format)
	appendString("poster", i.Poster)
	appendString("sizes", i.Sizes)
	if i.Width != nil {
		document = append(document, bson.E{Key: "width", Value: mediaNumberValue(float64(*i.Width))})
	}
	if i.Height != nil {
		document = append(document, bson.E{Key: "height", Value: mediaNumberValue(float64(*i.Height))})
	}
	if i.Score != nil {
		document = append(document, bson.E{Key: "score", Value: *i.Score})
	}
	if len(i.Srcset) > 0 {
		srcset := make(bson.A, 0, len(i.Srcset))
		for _, entry := range i.Srcset {
			srcset = append(srcset, entry)
		}
		document = append(document, bson.E{Key: "srcset", Value: srcset})
	}
	if len(i.PictureSources) > 0 {
		sources := make(bson.A, 0, len(i.PictureSources))
		for _, source := range i.PictureSources {
			sources = append(sources, source.bsonDocument())
		}
		document = append(document, bson.E{Key: "pictureSources", Value: sources})
	}
	if len(i.ResponsiveSources) > 0 {
		sources := make(bson.A, 0, len(i.ResponsiveSources))
		for _, source := range i.ResponsiveSources {
			sources = append(sources, source.bsonDocument())
		}
		document = append(document, bson.E{Key: "responsiveSources", Value: sources})
	}
	if len(i.Raw) > 0 {
		raw, err := i.Raw.bsonDocument()
		if err != nil {
			return nil, err
		}
		document = append(document, bson.E{Key: "raw", Value: raw})
	}
	return document, nil
}

// bsonDocument renders a CrawlMediaSource in the NestJS key order.
func (s mediaSource) bsonDocument() bson.D {
	document := bson.D{}
	if s.Srcset != nil {
		document = append(document, bson.E{Key: "srcset", Value: *s.Srcset})
	}
	if s.Src != nil {
		document = append(document, bson.E{Key: "src", Value: *s.Src})
	}
	if s.Type != nil {
		document = append(document, bson.E{Key: "type", Value: *s.Type})
	}
	if s.Media != nil {
		document = append(document, bson.E{Key: "media", Value: *s.Media})
	}
	if s.Sizes != nil {
		document = append(document, bson.E{Key: "sizes", Value: *s.Sizes})
	}
	return document
}

// bsonDocument renders the preserved extras (CrawlMediaItem.raw).
func (r mediaRawExtras) bsonDocument() (bson.D, error) {
	document := make(bson.D, 0, len(r))
	for _, field := range r {
		value, err := decodeMediaJSONValue(field.Value)
		if err != nil {
			return nil, fmt.Errorf("crawlexecution: encode media raw field %q: %w", field.Key, err)
		}
		document = append(document, bson.E{Key: field.Key, Value: value})
	}
	return document, nil
}

// mediaNumberValue encodes an integral number as int32 when it fits, so the
// crawlreadtelemetry int projections can decode it, and as int64 otherwise.
func mediaNumberValue(value float64) any {
	if math.IsNaN(value) || math.IsInf(value, 0) {
		return 0
	}
	integer := int64(math.Trunc(value))
	if integer >= math.MinInt32 && integer <= math.MaxInt32 {
		return int32(integer)
	}
	return integer
}

// decodeMediaJSONValue converts one JSON value into its BSON Go representation.
// The converter is explicit instead of a JSON round trip through extended JSON
// so a `$`-prefixed extra key can never be mistaken for an extended-JSON
// operator.
func decodeMediaJSONValue(raw json.RawMessage) (any, error) {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	return decodeMediaJSONToken(decoder)
}

func decodeMediaJSONToken(decoder *json.Decoder) (any, error) {
	token, err := decoder.Token()
	if err != nil {
		return nil, err
	}
	switch typed := token.(type) {
	case nil:
		return nil, nil
	case bool:
		return typed, nil
	case string:
		return typed, nil
	case json.Number:
		if integer, intErr := typed.Int64(); intErr == nil {
			if integer >= math.MinInt32 && integer <= math.MaxInt32 {
				return int32(integer), nil
			}
			return integer, nil
		}
		return typed.Float64()
	case json.Delim:
		switch typed {
		case '{':
			document := bson.D{}
			for decoder.More() {
				keyToken, keyErr := decoder.Token()
				if keyErr != nil {
					return nil, keyErr
				}
				key, ok := keyToken.(string)
				if !ok {
					return nil, fmt.Errorf("crawlexecution: unexpected object key token %v", keyToken)
				}
				value, valueErr := decodeMediaJSONToken(decoder)
				if valueErr != nil {
					return nil, valueErr
				}
				document = append(document, bson.E{Key: key, Value: value})
			}
			if _, closeErr := decoder.Token(); closeErr != nil {
				return nil, closeErr
			}
			return document, nil
		case '[':
			array := bson.A{}
			for decoder.More() {
				value, valueErr := decodeMediaJSONToken(decoder)
				if valueErr != nil {
					return nil, valueErr
				}
				array = append(array, value)
			}
			if _, closeErr := decoder.Token(); closeErr != nil {
				return nil, closeErr
			}
			return array, nil
		}
	}
	return nil, fmt.Errorf("crawlexecution: unexpected JSON token %v", token)
}

// normalizeMediaCollection is normalizeMediaCollection. It returns nil when the
// payload is not a non-empty object of item arrays, which is the NestJS
// `undefined` case (`media ?? null` then stores null).
func normalizeMediaCollection(raw json.RawMessage) *mediaCollection {
	if len(bytes.TrimSpace(raw)) == 0 {
		return nil
	}
	fields, ok := decodeMediaJSONObject(raw)
	if !ok {
		return nil
	}
	buckets := make([]mediaBucket, 0, len(fields))
	for _, field := range fields {
		items := normalizeMediaItems(field.Value)
		if len(items) == 0 {
			continue
		}
		buckets = append(buckets, mediaBucket{Kind: field.Key, Items: items})
	}
	if len(buckets) == 0 {
		return nil
	}
	return &mediaCollection{buckets: buckets}
}

// normalizeMediaItems normalizes one bucket array.
func normalizeMediaItems(raw json.RawMessage) []mediaItem {
	entries, ok := decodeMediaJSONArray(raw)
	if !ok {
		return nil
	}
	items := make([]mediaItem, 0, len(entries))
	for _, entry := range entries {
		if item := normalizeMediaItem(entry); item != nil {
			items = append(items, *item)
		}
	}
	return items
}

// normalizeMediaItem is normalizeMediaItem.
func normalizeMediaItem(raw json.RawMessage) *mediaItem {
	fields, ok := decodeMediaJSONObject(raw)
	if !ok {
		return nil
	}
	values := make(map[string]json.RawMessage, len(fields))
	orderedKeys := make([]string, 0, len(fields))
	for _, field := range fields {
		if _, exists := values[field.Key]; !exists {
			orderedKeys = append(orderedKeys, field.Key)
		}
		values[field.Key] = field.Value
	}
	item := mediaItem{
		Src:    pickJSONString(values, "src", "url", "href"),
		Alt:    pickJSONString(values, "alt"),
		Title:  pickJSONString(values, "title"),
		Desc:   pickJSONString(values, "desc", "description", "caption"),
		Type:   pickJSONString(values, "type", "media_type", "mediaType"),
		Format: pickJSONString(values, "format", "mime", "mimeType"),
		Poster: pickJSONString(values, "poster", "thumbnail"),
		Sizes:  pickJSONString(values, "sizes"),
		Width:  pickJSONInteger(values, "width"),
		Height: pickJSONInteger(values, "height"),
		Score:  pickJSONNumber(values, "score"),
	}
	item.Srcset = normalizeMediaStringList(firstNonNullJSONValue(values, "srcset", "srcSet"))
	item.PictureSources = normalizeMediaSources(firstNonNullJSONValue(values, "sources", "picture_sources", "pictureSources"))
	item.ResponsiveSources = normalizeMediaSources(firstNonNullJSONValue(values, "responsive_images", "responsiveImages"))
	item.Raw = extractMediaExtras(values, orderedKeys)
	if item.isEmpty() {
		return nil
	}
	return &item
}

// isEmpty reports whether normalizeMediaItem would have produced no key.
func (i mediaItem) isEmpty() bool {
	if i.Src != nil || i.Alt != nil || i.Title != nil || i.Desc != nil ||
		i.Type != nil || i.Format != nil || i.Poster != nil || i.Sizes != nil ||
		i.Width != nil || i.Height != nil || i.Score != nil {
		return false
	}
	return len(i.Srcset) == 0 && len(i.PictureSources) == 0 &&
		len(i.ResponsiveSources) == 0 && len(i.Raw) == 0
}

// normalizeMediaSources is normalizeMediaSources.
func normalizeMediaSources(raw json.RawMessage) []mediaSource {
	if len(raw) == 0 {
		return nil
	}
	entries, ok := decodeMediaJSONArray(raw)
	if !ok {
		return nil
	}
	sources := make([]mediaSource, 0, len(entries))
	for _, entry := range entries {
		fields, objectOK := decodeMediaJSONObject(entry)
		if !objectOK {
			continue
		}
		values := make(map[string]json.RawMessage, len(fields))
		for _, field := range fields {
			values[field.Key] = field.Value
		}
		source := mediaSource{
			Srcset: pickJSONString(values, "srcset", "srcSet"),
			Src:    pickJSONString(values, "src", "url", "href"),
			Type:   pickJSONString(values, "type"),
			Media:  pickJSONString(values, "media"),
			Sizes:  pickJSONString(values, "sizes"),
		}
		if source.isEmpty() {
			continue
		}
		sources = append(sources, source)
	}
	if len(sources) == 0 {
		return nil
	}
	return sources
}

// isEmpty reports whether normalizeMediaSources would have produced no key.
func (s mediaSource) isEmpty() bool {
	return s.Srcset == nil && s.Src == nil && s.Type == nil &&
		s.Media == nil && s.Sizes == nil
}

// normalizeMediaStringList is normalizeStringList: a string becomes a one-entry
// list, an array keeps the non-empty strings capped at 20 entries.
func normalizeMediaStringList(raw json.RawMessage) []string {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 {
		return nil
	}
	switch trimmed[0] {
	case '"':
		var value string
		if err := json.Unmarshal(trimmed, &value); err != nil {
			return nil
		}
		value = strings.TrimSpace(value)
		if value == "" {
			return nil
		}
		return []string{value}
	case '[':
		entries, ok := decodeMediaJSONArray(trimmed)
		if !ok {
			return nil
		}
		values := make([]string, 0, len(entries))
		for _, entry := range entries {
			var value string
			if err := json.Unmarshal(entry, &value); err != nil {
				continue
			}
			value = strings.TrimSpace(value)
			if value == "" {
				continue
			}
			values = append(values, value)
		}
		if len(values) == 0 {
			return nil
		}
		if len(values) > 20 {
			values = values[:20]
		}
		return values
	default:
		return nil
	}
}

// extractMediaExtras is extractMediaExtras: every key without a dedicated slot,
// in its original order. JSON null is preserved (the NestJS guard is
// `value !== undefined`, and a parsed JSON null is not undefined).
func extractMediaExtras(values map[string]json.RawMessage, orderedKeys []string) mediaRawExtras {
	var extras mediaRawExtras
	for _, key := range orderedKeys {
		if _, reserved := mediaReservedKeys[key]; reserved {
			continue
		}
		value, ok := values[key]
		if !ok {
			continue
		}
		extras = append(extras, mediaRawField{Key: key, Value: value})
	}
	return extras
}

// pickJSONString is pickString: the first key holding a non-empty string.
func pickJSONString(values map[string]json.RawMessage, keys ...string) *string {
	for _, key := range keys {
		raw, ok := values[key]
		if !ok {
			continue
		}
		var value string
		if err := json.Unmarshal(raw, &value); err != nil || value == "" {
			continue
		}
		copied := value
		return &copied
	}
	return nil
}

// pickJSONNumber is pickNumber: the first key holding a JSON number. The
// leading-token check matters because encoding/json accepts a JSON null into a
// float64 without an error, while NestJS requires typeof value === "number".
func pickJSONNumber(values map[string]json.RawMessage, keys ...string) *float64 {
	for _, key := range keys {
		raw, ok := values[key]
		if !ok {
			continue
		}
		trimmed := bytes.TrimSpace(raw)
		if len(trimmed) == 0 || (trimmed[0] != '-' && (trimmed[0] < '0' || trimmed[0] > '9')) {
			continue
		}
		var value float64
		if err := json.Unmarshal(trimmed, &value); err != nil {
			continue
		}
		copied := value
		return &copied
	}
	return nil
}

// pickJSONInteger is pickNumber narrowed to the integer domain of the Prisma Int
// columns and the crawlreadtelemetry int projection. A fractional Crawl4AI
// width/height (which Mongo would keep as a double and the read model cannot
// decode into int) is truncated toward zero.
func pickJSONInteger(values map[string]json.RawMessage, keys ...string) *int {
	number := pickJSONNumber(values, keys...)
	if number == nil || math.IsNaN(*number) || math.IsInf(*number, 0) {
		return nil
	}
	truncated := math.Trunc(*number)
	if truncated < math.MinInt32 || truncated > math.MaxInt32 {
		return nil
	}
	converted := int(truncated)
	return &converted
}

// firstNonNullJSONValue is the `a ?? b ?? c` operator: the first key that is
// present and not JSON null.
func firstNonNullJSONValue(values map[string]json.RawMessage, keys ...string) json.RawMessage {
	for _, key := range keys {
		raw, ok := values[key]
		if !ok {
			continue
		}
		if string(bytes.TrimSpace(raw)) == "null" {
			continue
		}
		return raw
	}
	return nil
}

// decodeMediaJSONObject decodes a JSON object into its ordered fields.
func decodeMediaJSONObject(raw json.RawMessage) ([]mediaRawField, bool) {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	token, err := decoder.Token()
	if err != nil {
		return nil, false
	}
	if delim, ok := token.(json.Delim); !ok || delim != '{' {
		return nil, false
	}
	fields := make([]mediaRawField, 0, 8)
	for decoder.More() {
		keyToken, keyErr := decoder.Token()
		if keyErr != nil {
			return nil, false
		}
		key, ok := keyToken.(string)
		if !ok {
			return nil, false
		}
		var value json.RawMessage
		if decodeErr := decoder.Decode(&value); decodeErr != nil {
			return nil, false
		}
		fields = append(fields, mediaRawField{Key: key, Value: value})
	}
	if _, closeErr := decoder.Token(); closeErr != nil {
		return nil, false
	}
	return fields, true
}

// decodeMediaJSONArray decodes a JSON array into its raw entries.
func decodeMediaJSONArray(raw json.RawMessage) ([]json.RawMessage, bool) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || trimmed[0] != '[' {
		return nil, false
	}
	var entries []json.RawMessage
	if err := json.Unmarshal(trimmed, &entries); err != nil {
		return nil, false
	}
	return entries, true
}

// downloadedMediaAsset is DownloadedMediaAsset.
type downloadedMediaAsset struct {
	Kind        string
	SourceURL   string
	Bytes       int
	ContentType *string
	Data        []byte
	Width       *int
	Height      *int
	Alt         *string
	Title       *string
	Desc        *string
	Poster      *string
	Format      *string
	Metadata    mediaRawExtras
}

// pickMediaURL is pickMediaUrl.
func (i mediaItem) pickMediaURL() string {
	if i.Src != nil && *i.Src != "" {
		return *i.Src
	}
	if i.Poster != nil && *i.Poster != "" {
		return *i.Poster
	}
	return ""
}

// collectMediaAssets is collectMediaAssets. Every download and storage failure
// is swallowed exactly like the NestJS per-asset try/catch: a media problem
// never fails the crawl result. The caller only reaches this method when
// shouldStoreMedia is set and the normalized collection is non-empty.
func (s *Service) collectMediaAssets(ctx context.Context, task *taskRow, resultID string, media *mediaCollection) {
	config := s.mediaSettings()
	if media.isEmpty() || config.MaxPerResult <= 0 {
		return
	}
	store := newMediaStore(s)
	if store == nil {
		log.Printf("crawlexecution: crawl media asset storage is unavailable taskId=%s orgId=%s resultId=%s",
			task.ID, task.OrgID, resultID)
		return
	}
	collectCrawlMediaAssets(ctx, config, store, task, resultID, media)
}

// collectCrawlMediaAssets is the download/store loop. It is separate from the
// Service method so tests can inject a fake media store.
func collectCrawlMediaAssets(
	ctx context.Context,
	config mediaConfig,
	store *mediaStore,
	task *taskRow,
	resultID string,
	media *mediaCollection,
) {
	entries := media.flatten()
	if len(entries) == 0 {
		return
	}
	storedCount := 0
	failedCount := 0
	seenSources := make(map[string]struct{}, len(entries))
	for _, entry := range entries {
		if storedCount >= config.MaxPerResult {
			break
		}
		candidate := entry.Item.pickMediaURL()
		if candidate == "" {
			continue
		}
		var downloaded *downloadedMediaAsset
		if strings.HasPrefix(candidate, "data:") {
			downloaded = buildInlineMediaAsset(candidate, entry.Kind, entry.Item, config.MaxBytes)
		} else {
			if !isHTTPMediaURL(candidate) {
				continue
			}
			if _, seen := seenSources[candidate]; seen {
				continue
			}
			seenSources[candidate] = struct{}{}
			downloaded = fetchMediaAsset(ctx, store.httpClient, config, candidate, entry.Kind, entry.Item)
		}
		if downloaded == nil {
			continue
		}
		if err := store.storeAsset(ctx, task, resultID, *downloaded); err != nil {
			failedCount++
			log.Printf("crawlexecution: failed to store crawl media asset taskId=%s orgId=%s resultId=%s kind=%s sourceUrl=%s: %v",
				task.ID, task.OrgID, resultID, downloaded.Kind, downloaded.SourceURL, err)
			continue
		}
		storedCount++
	}
	if failedCount > 0 {
		log.Printf("crawlexecution: stored crawl media with partial failures taskId=%s orgId=%s resultId=%s storedCount=%d failedCount=%d",
			task.ID, task.OrgID, resultID, storedCount, failedCount)
	}
}

// buildInlineMediaAsset is buildInlineMediaAsset: decode a base64 data URI
// under the same length and byte guards.
func buildInlineMediaAsset(dataURI, kind string, item mediaItem, maxBytes int) *downloadedMediaAsset {
	if maxBytes <= 0 {
		return nil
	}
	maxDataURIChars := 1024 + maxBase64PayloadLength(maxBytes)
	if len(dataURI) > maxDataURIChars {
		log.Printf("crawlexecution: skipped inline media asset exceeding max length kind=%s length=%d max=%d",
			kind, len(dataURI), maxDataURIChars)
		return nil
	}
	commaIndex := strings.Index(dataURI, ",")
	if commaIndex < 0 {
		return nil
	}
	meta := dataURI[len("data:"):commaIndex]
	payload := dataURI[commaIndex+1:]
	metaParts := strings.Split(meta, ";")
	isBase64 := false
	for _, part := range metaParts {
		if strings.ToLower(strings.TrimSpace(part)) == "base64" {
			isBase64 = true
		}
	}
	if !isBase64 {
		return nil
	}
	mime := ""
	if len(metaParts) > 0 {
		mime = strings.TrimSpace(metaParts[0])
	}
	estimatedBytes := estimateBase64DecodedBytes(payload)
	if estimatedBytes == 0 {
		return nil
	}
	if estimatedBytes > maxBytes {
		log.Printf("crawlexecution: skipped inline media asset exceeding max bytes kind=%s estimatedBytes=%d maxBytes=%d",
			kind, estimatedBytes, maxBytes)
		return nil
	}
	buffer, err := decodeBase64Payload(payload)
	if err != nil {
		log.Printf("crawlexecution: failed to parse inline media asset: %v", err)
		return nil
	}
	if len(buffer) > maxBytes {
		log.Printf("crawlexecution: skipped inline media asset exceeding max bytes kind=%s size=%d maxBytes=%d",
			kind, len(buffer), maxBytes)
		return nil
	}
	var contentType *string
	if mime != "" {
		contentType = &mime
	}
	return &downloadedMediaAsset{
		Kind:        kind,
		SourceURL:   "data-uri:inline",
		Bytes:       len(buffer),
		Data:        buffer,
		ContentType: contentType,
		Width:       item.Width,
		Height:      item.Height,
		Alt:         item.Alt,
		Title:       item.Title,
		Desc:        item.Desc,
		Poster:      item.Poster,
		Format:      item.Format,
		Metadata:    item.Raw,
	}
}

// maxBase64PayloadLength is maxBase64PayloadLength.
func maxBase64PayloadLength(maxBytes int) int {
	return int(math.Ceil(float64(maxBytes)/3)) * 4
}

// estimateBase64DecodedBytes is estimateBase64DecodedBytes: it validates the
// payload alphabet, skips whitespace, counts up to two padding characters and
// returns 0 when the payload is unusable (the NestJS undefined case).
func estimateBase64DecodedBytes(payload string) int {
	effectiveLength := 0
	sawValidChar := false
	for index := 0; index < len(payload); index++ {
		char := payload[index]
		if isMediaWhitespaceChar(char) {
			continue
		}
		sawValidChar = true
		if (char >= 'A' && char <= 'Z') || (char >= 'a' && char <= 'z') ||
			(char >= '0' && char <= '9') || char == '+' || char == '/' || char == '=' {
			effectiveLength++
			continue
		}
		return 0
	}
	if !sawValidChar || effectiveLength == 0 {
		return 0
	}
	padding := 0
	for index := len(payload) - 1; index >= 0; index-- {
		char := payload[index]
		if isMediaWhitespaceChar(char) {
			continue
		}
		if char == '=' && padding < 2 {
			padding++
			continue
		}
		break
	}
	decoded := effectiveLength*3/4 - padding
	if decoded > 0 {
		return decoded
	}
	return 0
}

// isMediaWhitespaceChar is isWhitespaceCharCode: tab, line feed, carriage
// return and space.
func isMediaWhitespaceChar(char byte) bool {
	return char == '\t' || char == '\n' || char == '\r' || char == ' '
}

// decodeBase64Payload mirrors Buffer.from(payload, "base64"): whitespace is
// ignored and unpadded payloads are accepted.
func decodeBase64Payload(payload string) ([]byte, error) {
	var builder strings.Builder
	builder.Grow(len(payload))
	for index := 0; index < len(payload); index++ {
		char := payload[index]
		if isMediaWhitespaceChar(char) {
			continue
		}
		builder.WriteByte(char)
	}
	compact := builder.String()
	if decoded, err := base64.StdEncoding.DecodeString(compact); err == nil {
		return decoded, nil
	}
	return base64.RawStdEncoding.DecodeString(compact)
}

// fetchMediaAsset is fetchMediaAsset. The abort timer of the NestJS fetch call
// becomes the request context deadline; the response body is read through a
// limit of maxBytes+1 so an oversized body is rejected without buffering it
// entirely (the observable outcome is the same skip).
func fetchMediaAsset(
	ctx context.Context,
	client *http.Client,
	config mediaConfig,
	rawURL, kind string,
	item mediaItem,
) *downloadedMediaAsset {
	if client == nil {
		client = &http.Client{}
	}
	fetchCtx, cancel := context.WithTimeout(ctx, time.Duration(config.FetchTimeoutMs)*time.Millisecond)
	defer cancel()
	request, err := http.NewRequestWithContext(fetchCtx, http.MethodGet, rawURL, nil)
	if err != nil {
		log.Printf("crawlexecution: failed to download crawl media asset url=%s: %v", rawURL, err)
		return nil
	}
	response, err := client.Do(request)
	if err != nil {
		log.Printf("crawlexecution: failed to download crawl media asset url=%s: %v", rawURL, err)
		return nil
	}
	defer func() { _ = response.Body.Close() }()
	if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
		log.Printf("crawlexecution: failed to download crawl media asset url=%s status=%d", rawURL, response.StatusCode)
		return nil
	}
	if contentLengthHeader := response.Header.Get("Content-Length"); contentLengthHeader != "" {
		if contentLength, parseErr := strconv.ParseFloat(strings.TrimSpace(contentLengthHeader), 64); parseErr == nil &&
			!math.IsNaN(contentLength) && contentLength > float64(config.MaxBytes) {
			log.Printf("crawlexecution: skipped crawl media asset exceeding max bytes url=%s contentLength=%s maxBytes=%d",
				rawURL, contentLengthHeader, config.MaxBytes)
			return nil
		}
	}
	limit := int64(config.MaxBytes) + 1
	if limit < 1 {
		limit = 1
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, limit))
	if err != nil {
		log.Printf("crawlexecution: failed to download crawl media asset url=%s: %v", rawURL, err)
		return nil
	}
	if len(body) > config.MaxBytes {
		log.Printf("crawlexecution: skipped crawl media asset exceeding max bytes url=%s size=%d maxBytes=%d",
			rawURL, len(body), config.MaxBytes)
		return nil
	}
	var contentType *string
	if headerValue := response.Header.Get("Content-Type"); headerValue != "" {
		contentType = &headerValue
	} else if item.Format != nil {
		format := *item.Format
		contentType = &format
	}
	return &downloadedMediaAsset{
		Kind:        kind,
		SourceURL:   rawURL,
		Bytes:       len(body),
		Data:        body,
		ContentType: contentType,
		Width:       item.Width,
		Height:      item.Height,
		Alt:         item.Alt,
		Title:       item.Title,
		Desc:        item.Desc,
		Poster:      item.Poster,
		Format:      item.Format,
		Metadata:    item.Raw,
	}
}

// isHTTPMediaURL is isHttpUrl: only absolute http(s) URLs are fetched.
func isHTTPMediaURL(value string) bool {
	parsed, err := url.Parse(value)
	if err != nil {
		return false
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return false
	}
	return parsed.Host != ""
}

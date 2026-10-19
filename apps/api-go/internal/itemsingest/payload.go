package itemsingest

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strconv"
	"strings"
	"time"
)

// NormalizedNewsPayload is the output of NormalizedNewsPayloadSchema. Optional
// keys stay absent from the JSON exactly like the Zod output: language and
// crawlOptions disappear when the transform returns undefined, while an
// explicit sourceName null is preserved.
type NormalizedNewsPayload struct {
	URL              string
	Language         *string
	SourceName       *string
	SourceNameIsNull bool
	Keywords         []string
	Tags             []string
	SummaryHints     []string
	Metadata         json.RawMessage
	CrawlOptions     json.RawMessage
	Prefetched       *PrefetchedArticle
	ForceRefresh     bool
}

// PrefetchedArticle is the schema's optional prefetched article. The field is
// kept for the outbox envelope; RawItem's Mongoose schema does not declare it,
// so it is never written to the raw document.
type PrefetchedArticle struct {
	Title             *string
	Description       *string
	Author            *string
	Markdown          *string
	PublishedAt       *string
	PublishedAtIsNull bool
	Metadata          json.RawMessage
}

// MarshalJSON renders the outbox payload shape.
func (p NormalizedNewsPayload) MarshalJSON() ([]byte, error) {
	var buffer bytes.Buffer
	buffer.WriteString(`{"url":`)
	writeJSONString(&buffer, p.URL)
	if p.Language != nil {
		buffer.WriteString(`,"language":`)
		writeJSONString(&buffer, *p.Language)
	}
	if p.SourceName != nil {
		buffer.WriteString(`,"sourceName":`)
		writeJSONString(&buffer, *p.SourceName)
	} else if p.SourceNameIsNull {
		buffer.WriteString(`,"sourceName":null`)
	}
	buffer.WriteString(`,"keywords":`)
	writeJSONArray(&buffer, p.Keywords)
	buffer.WriteString(`,"tags":`)
	writeJSONArray(&buffer, p.Tags)
	buffer.WriteString(`,"summaryHints":`)
	writeJSONArray(&buffer, p.SummaryHints)
	buffer.WriteString(`,"metadata":`)
	if len(p.Metadata) == 0 {
		buffer.WriteString(`{}`)
	} else {
		buffer.Write(p.Metadata)
	}
	if len(p.CrawlOptions) > 0 {
		buffer.WriteString(`,"crawlOptions":`)
		buffer.Write(p.CrawlOptions)
	}
	if p.Prefetched != nil {
		buffer.WriteString(`,"prefetchedArticle":`)
		encoded, err := json.Marshal(p.Prefetched)
		if err != nil {
			return nil, err
		}
		buffer.Write(encoded)
	}
	buffer.WriteString(`,"forceRefresh":`)
	if p.ForceRefresh {
		buffer.WriteString(`true`)
	} else {
		buffer.WriteString(`false`)
	}
	buffer.WriteString(`}`)
	return buffer.Bytes(), nil
}

// MarshalJSON renders the schema subset stored in RawItem. Mongoose's strict
// payload schema drops prefetchedArticle, and unknown keys never enter this
// type in the first place.
func (p PrefetchedArticle) MarshalJSON() ([]byte, error) {
	var buffer bytes.Buffer
	buffer.WriteString(`{`)
	wrote := false
	writeOptional := func(name string, value *string) {
		if value == nil {
			return
		}
		if wrote {
			buffer.WriteString(`,`)
		}
		wrote = true
		writeJSONString(&buffer, name)
		buffer.WriteString(`:`)
		writeJSONString(&buffer, *value)
	}
	writeOptional("title", p.Title)
	writeOptional("description", p.Description)
	writeOptional("author", p.Author)
	writeOptional("markdown", p.Markdown)
	if p.PublishedAt != nil {
		if wrote {
			buffer.WriteString(`,`)
		}
		wrote = true
		buffer.WriteString(`"publishedAt":`)
		writeJSONString(&buffer, *p.PublishedAt)
	} else if p.PublishedAtIsNull {
		if wrote {
			buffer.WriteString(`,`)
		}
		wrote = true
		buffer.WriteString(`"publishedAt":null`)
	}
	if len(p.Metadata) > 0 {
		if wrote {
			buffer.WriteString(`,`)
		}
		wrote = true
		buffer.WriteString(`"metadata":`)
		buffer.Write(p.Metadata)
	}
	buffer.WriteString(`}`)
	return buffer.Bytes(), nil
}

func writeJSONString(buffer *bytes.Buffer, value string) {
	encoded, _ := json.Marshal(value)
	buffer.Write(encoded)
}

func writeJSONArray(buffer *bytes.Buffer, values []string) {
	if values == nil {
		values = []string{}
	}
	encoded, _ := json.Marshal(values)
	buffer.Write(encoded)
}

// NormalizeNewsPayload ports NormalizedNewsPayloadSchema and returns its first
// schema failure with the "Invalid payload: " prefix applied by parsePayload.
func NormalizeNewsPayload(raw []byte) (NormalizedNewsPayload, error) {
	object, err := decodeJSONObject(raw)
	if err != nil {
		return NormalizedNewsPayload{}, invalidPayload(err.Error())
	}
	payload := NormalizedNewsPayload{
		Keywords:     []string{},
		Tags:         []string{},
		SummaryHints: []string{},
		Metadata:     json.RawMessage(`{}`),
		ForceRefresh: false,
	}

	urlRaw, hasURL := object["url"]
	if !hasURL {
		return NormalizedNewsPayload{}, invalidPayload("Required")
	}
	urlValue, kind := jsonValueKind(urlRaw)
	if kind != "string" {
		return NormalizedNewsPayload{}, invalidPayload(expectedString(kind))
	}
	payload.URL = strings.TrimSpace(urlValue.(string))
	if payload.URL == "" {
		return NormalizedNewsPayload{}, invalidPayload("url is required")
	}

	if rawLanguage, ok := object["language"]; ok {
		value, kind := jsonValueKind(rawLanguage)
		if kind != "string" {
			return NormalizedNewsPayload{}, invalidPayload(expectedString(kind))
		}
		trimmed := strings.TrimSpace(value.(string))
		if trimmed != "" {
			payload.Language = &trimmed
		}
	}

	if rawSourceName, ok := object["sourceName"]; ok {
		value, kind := jsonValueKind(rawSourceName)
		switch kind {
		case "null":
			payload.SourceNameIsNull = true
		case "string":
			trimmed := strings.TrimSpace(value.(string))
			if trimmed != "" {
				payload.SourceName = &trimmed
			}
		default:
			return NormalizedNewsPayload{}, invalidPayload("Invalid input")
		}
	}

	stringLists := []struct {
		name   string
		target *[]string
	}{
		{name: "keywords", target: &payload.Keywords},
		{name: "tags", target: &payload.Tags},
		{name: "summaryHints", target: &payload.SummaryHints},
	}
	for _, list := range stringLists {
		values, failure := normalizeStringList(object[list.name])
		if failure != "" {
			return NormalizedNewsPayload{}, invalidPayload(failure)
		}
		*list.target = values
	}

	if rawMetadata, ok := object["metadata"]; ok {
		value, kind := jsonValueKind(rawMetadata)
		if kind == "object" {
			payload.Metadata = append(json.RawMessage(nil), bytes.TrimSpace(rawMetadata)...)
		} else {
			_ = value
			payload.Metadata = json.RawMessage(`{}`)
		}
	}

	if rawCrawlOptions, ok := object["crawlOptions"]; ok {
		if _, kind := jsonValueKind(rawCrawlOptions); kind == "object" {
			payload.CrawlOptions = append(json.RawMessage(nil), bytes.TrimSpace(rawCrawlOptions)...)
		}
	}

	if rawPrefetched, ok := object["prefetchedArticle"]; ok {
		value, kind := jsonValueKind(rawPrefetched)
		if kind != "object" {
			return NormalizedNewsPayload{}, invalidPayload("Expected object, received " + kind)
		}
		prefetched, failure := normalizePrefetchedArticle(value.(map[string]json.RawMessage))
		if failure != "" {
			return NormalizedNewsPayload{}, invalidPayload(failure)
		}
		payload.Prefetched = prefetched
	}

	if rawForceRefresh, ok := object["forceRefresh"]; ok {
		value, _ := jsonValueKind(rawForceRefresh)
		payload.ForceRefresh = jsBoolean(value)
	}

	return payload, nil
}

func normalizeStringList(raw json.RawMessage) ([]string, string) {
	if len(raw) == 0 {
		return []string{}, ""
	}
	value, kind := jsonValueKind(raw)
	if kind != "array" {
		return []string{}, ""
	}
	entries := value.([]any)
	out := make([]string, 0, len(entries))
	for _, entry := range entries {
		text, ok := entry.(string)
		if !ok {
			return nil, expectedString(jsonKindOf(entry))
		}
		trimmed := strings.TrimSpace(text)
		if trimmed != "" {
			out = append(out, trimmed)
		}
	}
	return out, ""
}

func normalizePrefetchedArticle(object map[string]json.RawMessage) (*PrefetchedArticle, string) {
	article := &PrefetchedArticle{}
	for _, field := range []string{"title", "description", "author", "markdown"} {
		raw, ok := object[field]
		if !ok {
			continue
		}
		value, kind := jsonValueKind(raw)
		if kind != "string" {
			return nil, expectedString(kind)
		}
		trimmed := strings.TrimSpace(value.(string))
		if trimmed == "" {
			continue
		}
		copied := trimmed
		switch field {
		case "title":
			article.Title = &copied
		case "description":
			article.Description = &copied
		case "author":
			article.Author = &copied
		case "markdown":
			article.Markdown = &copied
		}
	}
	if raw, ok := object["publishedAt"]; ok {
		value, kind := jsonValueKind(raw)
		switch kind {
		case "null":
			article.PublishedAtIsNull = true
		case "string":
			trimmed := strings.TrimSpace(value.(string))
			if trimmed == "" {
				article.PublishedAtIsNull = true
			} else if parsed, ok := parseDateTime(trimmed); ok {
				formatted := parsed.UTC().Format("2006-01-02T15:04:05.000Z")
				article.PublishedAt = &formatted
			} else {
				article.PublishedAtIsNull = true
			}
		default:
			return nil, "Invalid input"
		}
	}
	if raw, ok := object["metadata"]; ok {
		if value, kind := jsonValueKind(raw); kind == "object" {
			_ = value
			article.Metadata = append(json.RawMessage(nil), bytes.TrimSpace(raw)...)
		}
	}
	return article, ""
}

// decodeJSONObject returns the raw members of a JSON object or the Zod-shaped
// type failure for scalar, array and null inputs.
func decodeJSONObject(raw []byte) (map[string]json.RawMessage, error) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 {
		return nil, fmt.Errorf("Expected object, received undefined")
	}
	value, kind := jsonValueKind(trimmed)
	if kind != "object" {
		return nil, fmt.Errorf("Expected object, received %s", kind)
	}
	_ = value
	var object map[string]json.RawMessage
	if err := json.Unmarshal(trimmed, &object); err != nil {
		return nil, err
	}
	if object == nil {
		object = map[string]json.RawMessage{}
	}
	return object, nil
}

// jsonValueKind decodes a raw JSON value once and returns both the value and
// its Zod-compatible type name.
func jsonValueKind(raw json.RawMessage) (any, string) {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	var value any
	if err := decoder.Decode(&value); err != nil {
		return nil, "undefined"
	}
	return value, jsonKindOf(value)
}

func jsonKindOf(value any) string {
	switch typed := value.(type) {
	case nil:
		return "null"
	case string:
		return "string"
	case bool:
		return "boolean"
	case json.Number, float64:
		return "number"
	case []any:
		return "array"
	case map[string]any:
		return "object"
	default:
		_ = typed
		return "unknown"
	}
}

func expectedString(kind string) string {
	return "Expected string, received " + kind
}

// jsBoolean is JavaScript Boolean(value) for the JSON domain: null, false, 0
// and "" are falsy; arrays and objects (including empty ones) are truthy.
func jsBoolean(value any) bool {
	switch typed := value.(type) {
	case nil:
		return false
	case bool:
		return typed
	case string:
		return typed != ""
	case json.Number:
		number, err := typed.Float64()
		return err != nil || number != 0
	case float64:
		return typed != 0
	default:
		return true
	}
}

// parseDateTime covers the ISO date/time forms parseDateTime accepts. Invalid
// strings yield false and the schema stores null.
func parseDateTime(value string) (time.Time, bool) {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return time.Time{}, false
	}
	for _, layout := range []string{
		time.RFC3339Nano,
		"2006-01-02T15:04:05",
		"2006-01-02 15:04:05",
		"2006-01-02",
	} {
		if parsed, err := time.Parse(layout, trimmed); err == nil {
			return parsed, true
		}
	}
	if number, err := strconv.ParseInt(trimmed, 10, 64); err == nil {
		if number < 1e12 {
			number *= 1000
		}
		return time.UnixMilli(number), true
	}
	return time.Time{}, false
}

// DecodePayloadString ports JSON.parse for the GraphQL payload string. The
// returned bytes are the exact parsed JSON value, so "null", false and 0 keep
// their falsy meaning in the update service branch.
func DecodePayloadString(value string) ([]byte, error) {
	var parsed any
	decoder := json.NewDecoder(strings.NewReader(value))
	decoder.UseNumber()
	if err := decoder.Decode(&parsed); err != nil {
		return nil, NewFailure(400, "payload must be valid JSON")
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return nil, NewFailure(400, "payload must be valid JSON")
	}
	return json.Marshal(parsed)
}

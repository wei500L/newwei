package contentsubscriptions

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"mime"
	"net/http"
	"net/url"
	"strconv"
	"strings"
)

const maxJSONBodyBytes = 10 << 20

type bodyKind int

const (
	bodyAbsent bodyKind = iota
	bodyOK
	bodyInvalidJSON
	bodyTooLarge
)

type inputError struct {
	Message string
}

func (e *inputError) Error() string { return e.Message }

type subscriptionInput struct {
	Kind      string
	Value     string
	Source    string
	HasSource bool
}

type queryValues struct {
	order  []string
	values map[string][]string
}

func readBody(r *http.Request) ([]byte, bodyKind) {
	if !isJSONContentType(r.Header.Get("Content-Type")) {
		return nil, bodyAbsent
	}
	limited := http.MaxBytesReader(nil, r.Body, maxJSONBodyBytes)
	defer limited.Close()
	data, err := io.ReadAll(limited)
	if err != nil {
		var maxBytes *http.MaxBytesError
		if errors.As(err, &maxBytes) {
			return nil, bodyTooLarge
		}
		return data, bodyInvalidJSON
	}
	if len(bytes.TrimSpace(data)) == 0 || !json.Valid(bytes.TrimSpace(data)) {
		return data, bodyInvalidJSON
	}
	return data, bodyOK
}

func isJSONContentType(header string) bool {
	if strings.TrimSpace(header) == "" {
		return false
	}
	media, _, err := mime.ParseMediaType(header)
	if err != nil {
		return false
	}
	return media == "application/json"
}

func invalidJSONMessage(body []byte) string {
	trimmed := bytes.TrimSpace(body)
	if bytes.Equal(trimmed, []byte("{")) {
		return "Expected property name or '}' in JSON at position 1"
	}
	if len(body) == 0 {
		return "Unexpected end of JSON input"
	}
	token := body[0]
	snippet := body
	ellipsis := ""
	if len(snippet) > 10 {
		snippet = snippet[:10]
		ellipsis = "..."
	}
	return fmt.Sprintf("Unexpected token '%c', \"%s\"%s is not valid JSON", token, string(snippet), ellipsis)
}

// validateSubscriptionBody 对齐 Batch* DTO + ValidationPipe
// （whitelist、forbidNonWhitelisted、transform）。field 是 subscriptions 或 entries。
func validateSubscriptionBody(body []byte, field string, maxItems int) ([]subscriptionInput, error) {
	fields, nonObject, err := decodeObject(body)
	if err != nil {
		return nil, err
	}
	if nonObject {
		return nil, &inputError{Message: "an unknown value was passed to the validate function"}
	}
	return validateSubscriptionField(fields, field, maxItems)
}

func validateSubscriptionField(fields []jsonField, field string, maxItems int) ([]subscriptionInput, error) {
	var messages []string
	var raw json.RawMessage
	present := false
	for _, item := range fields {
		if item.key == field {
			raw = item.raw
			present = true
			break
		}
	}
	if !present || jsonKind(raw) != "array" {
		messages = append(messages,
			"each value in nested property "+field+" must be either object or array",
			field+" must contain not more than "+strconv.Itoa(maxItems)+" elements",
			field+" must be an array",
		)
	} else {
		items, ok := decodeArray(raw)
		if !ok {
			messages = append(messages, field+" must be an array")
		} else {
			var child []string
			for index, item := range items {
				child = append(child, validateSubscriptionItem(field, index, item)...)
			}
			if len(child) > 0 {
				messages = append(messages, child...)
			} else if len(items) > maxItems {
				messages = append(messages, field+" must contain not more than "+strconv.Itoa(maxItems)+" elements")
			}
		}
	}
	for _, item := range fields {
		if item.key == field {
			continue
		}
		messages = append(messages, "property "+item.key+" should not exist")
	}
	if len(messages) > 0 {
		return nil, &inputError{Message: strings.Join(messages, "; ")}
	}
	items, _ := decodeArray(raw)
	out := make([]subscriptionInput, 0, len(items))
	for _, item := range items {
		out = append(out, decodeSubscriptionItem(item))
	}
	return out, nil
}

func validateSubscriptionItem(field string, index int, raw json.RawMessage) []string {
	prefix := field + "." + strconv.Itoa(index) + "."
	if jsonKind(raw) != "object" {
		return []string{"each value in nested property " + field + " must be either object or array"}
	}
	fields, _, err := decodeObject(raw)
	if err != nil {
		return []string{"each value in nested property " + field + " must be either object or array"}
	}
	allowed := map[string]struct{}{"kind": {}, "value": {}, "source": {}}
	var messages []string
	kindRaw, hasKind := fieldRaw(fields, "kind")
	if !hasKind || !kindAllowed(kindRaw) {
		messages = append(messages, prefix+"kind must be one of the following values: "+kindList())
	}
	valueRaw, hasValue := fieldRaw(fields, "value")
	if !hasValue || jsonKind(valueRaw) != "string" {
		messages = append(messages,
			prefix+"value must be shorter than or equal to 128 characters",
			prefix+"value must be a string",
		)
	} else if text, ok := decodeJSONString(valueRaw); !ok || utf16Len(text) > maxValueLen {
		messages = append(messages, prefix+"value must be shorter than or equal to 128 characters")
	}
	sourceRaw, hasSource := fieldRaw(fields, "source")
	if hasSource && jsonKind(sourceRaw) != "null" && !sourceAllowed(sourceRaw) {
		messages = append(messages, prefix+"source must be one of the following values: "+sourceList())
	}
	for _, item := range fields {
		if _, ok := allowed[item.key]; ok {
			continue
		}
		messages = append(messages, prefix+"property "+item.key+" should not exist")
	}
	return messages
}

func decodeSubscriptionItem(raw json.RawMessage) subscriptionInput {
	fields, _, _ := decodeObject(raw)
	var input subscriptionInput
	if kindRaw, ok := fieldRaw(fields, "kind"); ok {
		input.Kind, _ = decodeJSONString(kindRaw)
	}
	if valueRaw, ok := fieldRaw(fields, "value"); ok {
		input.Value, _ = decodeJSONString(valueRaw)
	}
	if sourceRaw, ok := fieldRaw(fields, "source"); ok && jsonKind(sourceRaw) != "null" {
		input.Source, _ = decodeJSONString(sourceRaw)
		input.HasSource = true
	}
	return input
}

func kindAllowed(raw json.RawMessage) bool {
	text, ok := decodeJSONString(raw)
	return ok && knownKind(text)
}

func sourceAllowed(raw json.RawMessage) bool {
	text, ok := decodeJSONString(raw)
	return ok && knownSource(text)
}

type catalogQuery struct {
	Kind         string
	KindSet      bool
	Query        string
	QuerySet     bool
	TaxonomyPath string
	TaxonomySet  bool
	Limit        *float64
}

func validateCatalogQuery(raw string) (catalogQuery, error) {
	bag := parseQuery(raw)
	var messages []string
	var query catalogQuery
	if values, ok := bag.values["kind"]; ok {
		query.KindSet = true
		if len(values) != 1 || !knownKind(values[0]) {
			messages = append(messages, "kind must be one of the following values: "+kindList())
		} else {
			query.Kind = values[0]
		}
	}
	if values, ok := bag.values["query"]; ok {
		query.QuerySet = true
		if len(values) != 1 {
			messages = append(messages,
				"query must be shorter than or equal to 128 characters",
				"query must be a string",
			)
		} else if utf16Len(values[0]) > maxValueLen {
			messages = append(messages, "query must be shorter than or equal to 128 characters")
		} else {
			query.Query = values[0]
		}
	}
	if values, ok := bag.values["taxonomyPath"]; ok {
		query.TaxonomySet = true
		if len(values) != 1 {
			messages = append(messages,
				"taxonomyPath must be shorter than or equal to 160 characters",
				"taxonomyPath must be a string",
			)
		} else if utf16Len(values[0]) > 160 {
			messages = append(messages, "taxonomyPath must be shorter than or equal to 160 characters")
		} else {
			query.TaxonomyPath = values[0]
		}
	}
	if values, ok := bag.values["limit"]; ok {
		query.Limit = jsQueryNumber(values)
	}
	for _, key := range bag.order {
		switch key {
		case "kind", "query", "taxonomyPath", "limit":
			continue
		default:
			messages = append(messages, "property "+key+" should not exist")
		}
	}
	if len(messages) > 0 {
		return catalogQuery{}, &inputError{Message: strings.Join(messages, "; ")}
	}
	return query, nil
}

func validateLimitQuery(raw string) (*float64, error) {
	bag := parseQuery(raw)
	var messages []string
	var limit *float64
	if values, ok := bag.values["limit"]; ok {
		limit = jsQueryNumber(values)
	}
	for _, key := range bag.order {
		if key == "limit" {
			continue
		}
		messages = append(messages, "property "+key+" should not exist")
	}
	if len(messages) > 0 {
		return nil, &inputError{Message: strings.Join(messages, "; ")}
	}
	return limit, nil
}

type relatedQuery struct {
	Topic string
	Limit *float64
}

func validateRelatedQuery(raw string) (relatedQuery, error) {
	bag := parseQuery(raw)
	var messages []string
	var query relatedQuery
	values, ok := bag.values["topic"]
	if !ok || len(values) != 1 {
		messages = append(messages,
			"topic must be shorter than or equal to 128 characters",
			"topic must be a string",
		)
	} else if utf16Len(values[0]) > maxValueLen {
		messages = append(messages, "topic must be shorter than or equal to 128 characters")
	} else {
		query.Topic = values[0]
	}
	if limitValues, ok := bag.values["limit"]; ok {
		query.Limit = jsQueryNumber(limitValues)
	}
	for _, key := range bag.order {
		switch key {
		case "topic", "limit":
			continue
		default:
			messages = append(messages, "property "+key+" should not exist")
		}
	}
	if len(messages) > 0 {
		return relatedQuery{}, &inputError{Message: strings.Join(messages, "; ")}
	}
	return query, nil
}

func parseQuery(raw string) queryValues {
	bag := queryValues{values: map[string][]string{}}
	if raw == "" {
		return bag
	}
	for _, part := range strings.Split(raw, "&") {
		if part == "" {
			continue
		}
		keyPart, valuePart, hasValue := strings.Cut(part, "=")
		key := decodeQueryComponent(keyPart)
		if key == "" {
			continue
		}
		value := ""
		if hasValue {
			value = decodeQueryComponent(valuePart)
		}
		if _, ok := bag.values[key]; !ok {
			bag.order = append(bag.order, key)
		}
		bag.values[key] = append(bag.values[key], value)
	}
	return bag
}

func decodeQueryComponent(value string) string {
	decoded, err := url.QueryUnescape(strings.ReplaceAll(value, "+", " "))
	if err != nil {
		return value
	}
	return decoded
}

func jsQueryNumber(values []string) *float64 {
	if len(values) != 1 {
		nan := math.NaN()
		return &nan
	}
	number, ok := jsNumber(values[0])
	if !ok {
		nan := math.NaN()
		return &nan
	}
	return &number
}

func jsNumber(value string) (float64, bool) {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return 0, true
	}
	if len(trimmed) > 1 && (trimmed[0] == '+' || trimmed[0] == '-') && len(trimmed) > 2 && (trimmed[1] == 'x' || trimmed[1] == 'X') {
		return 0, false
	}
	if strings.HasPrefix(trimmed, "0x") || strings.HasPrefix(trimmed, "0X") {
		parsed, err := strconv.ParseUint(trimmed, 0, 64)
		if err != nil {
			return 0, false
		}
		return float64(parsed), true
	}
	parsed, err := strconv.ParseFloat(trimmed, 64)
	if err != nil {
		return 0, false
	}
	return parsed, true
}

func normalizeCatalogLimit(value *float64) int {
	if value == nil || math.IsNaN(*value) || math.IsInf(*value, 0) {
		return catalogListLimit
	}
	floored := math.Floor(*value)
	if floored < 1 {
		return 1
	}
	if floored > catalogListLimit {
		return catalogListLimit
	}
	return int(floored)
}

func boundedServiceLimit(value *float64, fallback int) int {
	if value == nil {
		return fallback
	}
	if math.IsNaN(*value) || math.IsInf(*value, 0) {
		return 0
	}
	return int(math.Trunc(*value))
}

type jsonField struct {
	key string
	raw json.RawMessage
}

func decodeObject(body []byte) ([]jsonField, bool, error) {
	dec := json.NewDecoder(bytes.NewReader(body))
	dec.UseNumber()
	var raw json.RawMessage
	if err := dec.Decode(&raw); err != nil {
		return nil, false, &inputError{Message: invalidJSONMessage(body)}
	}
	var extra json.RawMessage
	if err := dec.Decode(&extra); err != io.EOF {
		return nil, false, &inputError{Message: invalidJSONMessage(body)}
	}
	trimmed := bytes.TrimSpace(raw)
	if bytes.Equal(trimmed, []byte("null")) {
		return nil, false, nil
	}
	if len(trimmed) == 0 || trimmed[0] != '{' {
		return nil, true, nil
	}
	obj := json.NewDecoder(bytes.NewReader(trimmed))
	tok, err := obj.Token()
	if err != nil || tok != json.Delim('{') {
		return nil, false, &inputError{Message: invalidJSONMessage(body)}
	}
	index := map[string]int{}
	var fields []jsonField
	for obj.More() {
		keyTok, err := obj.Token()
		if err != nil {
			return nil, false, &inputError{Message: invalidJSONMessage(body)}
		}
		key, ok := keyTok.(string)
		if !ok {
			return nil, false, &inputError{Message: invalidJSONMessage(body)}
		}
		var value json.RawMessage
		if err := obj.Decode(&value); err != nil {
			return nil, false, &inputError{Message: invalidJSONMessage(body)}
		}
		if pos, exists := index[key]; exists {
			fields[pos].raw = value
			continue
		}
		index[key] = len(fields)
		fields = append(fields, jsonField{key: key, raw: value})
	}
	return fields, false, nil
}

func decodeArray(raw json.RawMessage) ([]json.RawMessage, bool) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || trimmed[0] != '[' {
		return nil, false
	}
	dec := json.NewDecoder(bytes.NewReader(trimmed))
	tok, err := dec.Token()
	if err != nil || tok != json.Delim('[') {
		return nil, false
	}
	var items []json.RawMessage
	for dec.More() {
		var item json.RawMessage
		if err := dec.Decode(&item); err != nil {
			return nil, false
		}
		items = append(items, item)
	}
	return items, true
}

func fieldRaw(fields []jsonField, key string) (json.RawMessage, bool) {
	for _, field := range fields {
		if field.key == key {
			return field.raw, true
		}
	}
	return nil, false
}

func jsonKind(raw json.RawMessage) string {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 {
		return "invalid"
	}
	switch trimmed[0] {
	case '{':
		return "object"
	case '[':
		return "array"
	case '"':
		return "string"
	case 't', 'f':
		return "bool"
	case 'n':
		return "null"
	default:
		return "number"
	}
}

func decodeJSONString(raw json.RawMessage) (string, bool) {
	if jsonKind(raw) != "string" {
		return "", false
	}
	var text string
	if err := json.Unmarshal(raw, &text); err != nil {
		return "", false
	}
	return text, true
}

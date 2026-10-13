package situationmonitors

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"strconv"
	"strings"
)

const maxJSONBodyBytes = 10 << 20

type bodyKind int

const (
	bodyOK bodyKind = iota
	bodyAbsent
	bodyInvalidJSON
	bodyTooLarge
)

type inputError struct{ Message string }

func (e *inputError) Error() string { return e.Message }

type locationInput struct {
	Name    string
	Country string
	Lat     float64
	Lng     float64
	HasLat  bool
	HasLng  bool
}

type monitorWrite struct {
	Name             string
	RawKeywords      []string
	ApprovedTopics   []string
	ApprovedEntities []string
	ApprovedSources  []string
	ApprovedGeos     []string
	ApprovedLexical  []string
	RejectedTopics   []string
	RejectedEntities []string
	RejectedLexical  []string
	Color            string
	Location         *locationInput
	Enabled          *bool
}

type optionalString struct {
	set   bool
	value string
}

type optionalStrings struct {
	set   bool
	value []string
}

type optionalBool struct {
	set   bool
	value bool
}

type optionalLocation struct {
	set   bool
	value *locationInput
}

type monitorPatch struct {
	Name             optionalString
	RawKeywords      optionalStrings
	ApprovedTopics   optionalStrings
	ApprovedEntities optionalStrings
	ApprovedLexical  optionalStrings
	RejectedTopics   optionalStrings
	RejectedEntities optionalStrings
	RejectedLexical  optionalStrings
	Color            optionalString
	Location         optionalLocation
	Enabled          optionalBool
}

func (p monitorPatch) rejectsSystemSync() bool {
	return p.Name.set || p.RawKeywords.set || p.ApprovedTopics.set || p.ApprovedEntities.set ||
		p.ApprovedLexical.set || p.RejectedTopics.set || p.RejectedEntities.set ||
		p.RejectedLexical.set || p.Location.set
}

func mergePatch(row monitorRow, patch monitorPatch) monitorWrite {
	rejected := parseRejected(row.Rejected)
	write := monitorWrite{
		Name:             row.Name,
		RawKeywords:      parseStringArray(row.RawKeywords, maxKeywords),
		ApprovedTopics:   parseStringArray(row.ApprovedTopics, maxApprovedSuggestions),
		ApprovedEntities: parseStringArray(row.ApprovedEntities, maxApprovedSuggestions),
		ApprovedSources:  parseStringArray(row.ApprovedSources, maxApprovedSuggestions),
		ApprovedGeos:     parseStringArray(row.ApprovedGeos, maxApprovedSuggestions),
		ApprovedLexical:  parseStringArray(row.ApprovedLexical, maxApprovedTerms),
		RejectedTopics:   rejected.Topics,
		RejectedEntities: rejected.Entities,
		RejectedLexical:  rejected.LexicalTerms,
		Enabled:          boolPtr(row.Enabled),
	}
	if row.Color.Valid {
		write.Color = row.Color.String
	}
	if row.LocationName.Valid && row.LocationLat.Valid && row.LocationLng.Valid {
		write.Location = &locationInput{
			Name:    row.LocationName.String,
			Lat:     row.LocationLat.Float64,
			Lng:     row.LocationLng.Float64,
			HasLat:  true,
			HasLng:  true,
			Country: row.LocationCountry.String,
		}
	}
	if patch.Name.set {
		write.Name = patch.Name.value
	}
	if patch.RawKeywords.set {
		write.RawKeywords = patch.RawKeywords.value
	}
	if patch.ApprovedTopics.set {
		write.ApprovedTopics = patch.ApprovedTopics.value
	}
	if patch.ApprovedEntities.set {
		write.ApprovedEntities = patch.ApprovedEntities.value
	}
	if patch.ApprovedLexical.set {
		write.ApprovedLexical = patch.ApprovedLexical.value
	}
	if patch.RejectedTopics.set {
		write.RejectedTopics = patch.RejectedTopics.value
	}
	if patch.RejectedEntities.set {
		write.RejectedEntities = patch.RejectedEntities.value
	}
	if patch.RejectedLexical.set {
		write.RejectedLexical = patch.RejectedLexical.value
	}
	if patch.Color.set {
		write.Color = patch.Color.value
	}
	if patch.Location.set {
		write.Location = patch.Location.value
	}
	if patch.Enabled.set {
		write.Enabled = boolPtr(patch.Enabled.value)
	}
	return write
}

func boolPtr(value bool) *bool {
	return &value
}

func readBody(r *http.Request) ([]byte, bodyKind) {
	if r.Body == nil || !isJSONContentType(r.Header.Get("Content-Type")) {
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

func validateCreate(body []byte, preview bool) (monitorWrite, error) {
	fields, err := decodeObject(body)
	if err != nil {
		return monitorWrite{}, err
	}
	allowed := map[string]bool{
		"name": true, "rawKeywords": true, "color": true, "location": true,
		"approvedTopics": true, "approvedEntities": true, "approvedLexicalTerms": true,
		"rejectedTopics": true, "rejectedEntities": true, "rejectedLexicalTerms": true,
	}
	if !preview {
		allowed["enabled"] = true
	}
	var messages []string
	write := monitorWrite{}
	if message := requireString(fields, "name", 64, &write.Name); message != "" {
		messages = append(messages, message)
	}
	keywords, keywordMessages := requireStringArray(fields.values, "rawKeywords", maxKeywords, true)
	messages = append(messages, keywordMessages...)
	write.RawKeywords = keywords
	write.ApprovedTopics, messages = takeOptionalStrings(fields, "approvedTopics", maxApprovedSuggestions, messages)
	write.ApprovedEntities, messages = takeOptionalStrings(fields, "approvedEntities", maxApprovedSuggestions, messages)
	if raw, ok := fields.values["approvedLexicalTerms"]; ok {
		values, extra := requireStringArray(map[string]json.RawMessage{"approvedLexicalTerms": raw}, "approvedLexicalTerms", maxApprovedTerms, true)
		messages = append(messages, extra...)
		write.ApprovedLexical = values
	}
	write.RejectedTopics, messages = takeOptionalStrings(fields, "rejectedTopics", maxApprovedSuggestions, messages)
	write.RejectedEntities, messages = takeOptionalStrings(fields, "rejectedEntities", maxApprovedSuggestions, messages)
	write.RejectedLexical, messages = takeOptionalStrings(fields, "rejectedLexicalTerms", maxApprovedTerms, messages)
	if message := optionalBoundedString(fields, "color", 16, &write.Color); message != "" {
		messages = append(messages, message)
	}
	if loc, message := decodeOptionalLocation(fields, "location"); message != "" {
		messages = append(messages, message)
	} else {
		write.Location = loc
	}
	if !preview {
		if enabled, message := optionalBoolField(fields, "enabled"); message != "" {
			messages = append(messages, message)
		} else {
			write.Enabled = enabled
		}
	}
	messages = append(messages, unknownMessages(fields, allowed)...)
	if len(messages) > 0 {
		return monitorWrite{}, &inputError{Message: strings.Join(messages, "; ")}
	}
	return write, nil
}

func validateUpdate(body []byte) (monitorPatch, error) {
	fields, err := decodeObject(body)
	if err != nil {
		return monitorPatch{}, err
	}
	allowed := map[string]bool{
		"name": true, "rawKeywords": true, "enabled": true, "color": true, "location": true,
		"approvedTopics": true, "approvedEntities": true, "approvedLexicalTerms": true,
		"rejectedTopics": true, "rejectedEntities": true, "rejectedLexicalTerms": true,
	}
	var patch monitorPatch
	var messages []string
	if raw, ok := fields.values["name"]; ok {
		patch.Name.set = true
		if message := stringValue("name", raw, 64, true, &patch.Name.value); message != "" {
			messages = append(messages, message)
		}
	}
	if raw, ok := fields.values["rawKeywords"]; ok {
		patch.RawKeywords.set = true
		values, extra := stringArrayValue("rawKeywords", raw, maxKeywords)
		messages = append(messages, extra...)
		patch.RawKeywords.value = values
	}
	patch.ApprovedTopics, messages = takePatchStrings(fields, "approvedTopics", maxApprovedSuggestions, messages)
	patch.ApprovedEntities, messages = takePatchStrings(fields, "approvedEntities", maxApprovedSuggestions, messages)
	patch.ApprovedLexical, messages = takePatchStrings(fields, "approvedLexicalTerms", maxApprovedTerms, messages)
	patch.RejectedTopics, messages = takePatchStrings(fields, "rejectedTopics", maxApprovedSuggestions, messages)
	patch.RejectedEntities, messages = takePatchStrings(fields, "rejectedEntities", maxApprovedSuggestions, messages)
	patch.RejectedLexical, messages = takePatchStrings(fields, "rejectedLexicalTerms", maxApprovedTerms, messages)
	if raw, ok := fields.values["enabled"]; ok {
		patch.Enabled.set = true
		value, message := boolValue("enabled", raw)
		if message != "" {
			messages = append(messages, message)
		}
		patch.Enabled.value = value
	}
	if raw, ok := fields.values["color"]; ok {
		patch.Color.set = true
		if string(bytes.TrimSpace(raw)) != "null" {
			if message := stringValue("color", raw, 16, true, &patch.Color.value); message != "" {
				messages = append(messages, message)
			}
		}
	}
	if raw, ok := fields.values["location"]; ok {
		patch.Location.set = true
		if string(bytes.TrimSpace(raw)) != "null" {
			loc, message := locationValue(raw)
			if message != "" {
				messages = append(messages, message)
			}
			patch.Location.value = loc
		}
	}
	messages = append(messages, unknownMessages(fields, allowed)...)
	if len(messages) > 0 {
		return monitorPatch{}, &inputError{Message: strings.Join(messages, "; ")}
	}
	return patch, nil
}

type objectFields struct {
	values map[string]json.RawMessage
	order  []string
}

func decodeObject(body []byte) (objectFields, error) {
	dec := json.NewDecoder(bytes.NewReader(bytes.TrimSpace(body)))
	dec.UseNumber()
	token, err := dec.Token()
	if err != nil {
		return objectFields{}, &inputError{Message: invalidJSONMessage(body)}
	}
	delim, ok := token.(json.Delim)
	if !ok || delim != '{' {
		return objectFields{}, &inputError{Message: "an unknown value was passed to the validate function"}
	}
	fields := objectFields{values: map[string]json.RawMessage{}}
	for dec.More() {
		keyToken, err := dec.Token()
		if err != nil {
			return objectFields{}, &inputError{Message: invalidJSONMessage(body)}
		}
		key, ok := keyToken.(string)
		if !ok {
			return objectFields{}, &inputError{Message: invalidJSONMessage(body)}
		}
		var raw json.RawMessage
		if err := dec.Decode(&raw); err != nil {
			return objectFields{}, &inputError{Message: invalidJSONMessage(body)}
		}
		if _, exists := fields.values[key]; !exists {
			fields.order = append(fields.order, key)
		}
		fields.values[key] = raw
	}
	return fields, nil
}

func unknownMessages(fields objectFields, allowed map[string]bool) []string {
	var messages []string
	for _, key := range fields.order {
		if !allowed[key] {
			messages = append(messages, "property "+key+" should not exist")
		}
	}
	return messages
}

func requireString(fields objectFields, name string, max int, dest *string) string {
	raw, ok := fields.values[name]
	if !ok {
		return name + " must be a string"
	}
	return stringValue(name, raw, max, false, dest)
}

func stringValue(name string, raw json.RawMessage, max int, optionalNull bool, dest *string) string {
	if optionalNull && string(bytes.TrimSpace(raw)) == "null" {
		return ""
	}
	var text string
	if err := json.Unmarshal(raw, &text); err != nil {
		return name + " must be a string"
	}
	if utf16Len(text) > max {
		return fmt.Sprintf("%s must be shorter than or equal to %d characters", name, max)
	}
	if dest != nil {
		*dest = text
	}
	return ""
}

func optionalBoundedString(fields objectFields, name string, max int, dest *string) string {
	raw, ok := fields.values[name]
	if !ok || string(bytes.TrimSpace(raw)) == "null" {
		return ""
	}
	return stringValue(name, raw, max, true, dest)
}

func requireStringArray(fields map[string]json.RawMessage, name string, max int, required bool) ([]string, []string) {
	raw, ok := fields[name]
	if !ok {
		if required {
			return nil, []string{name + " must be an array"}
		}
		return nil, nil
	}
	return stringArrayValue(name, raw, max)
}

func stringArrayValue(name string, raw json.RawMessage, max int) ([]string, []string) {
	if string(bytes.TrimSpace(raw)) == "null" {
		return nil, []string{name + " must be an array"}
	}
	var parsed []json.RawMessage
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return nil, []string{name + " must be an array"}
	}
	if len(parsed) > max {
		return nil, []string{fmt.Sprintf("%s must contain no more than %d elements", name, max)}
	}
	out := make([]string, 0, len(parsed))
	for _, item := range parsed {
		var text string
		if err := json.Unmarshal(item, &text); err != nil {
			return nil, []string{"each value in " + name + " must be a string"}
		}
		out = append(out, text)
	}
	return out, nil
}

func takeOptionalStrings(fields objectFields, name string, max int, messages []string) ([]string, []string) {
	raw, ok := fields.values[name]
	if !ok || string(bytes.TrimSpace(raw)) == "null" {
		return nil, messages
	}
	values, extra := stringArrayValue(name, raw, max)
	return values, append(messages, extra...)
}

func takePatchStrings(fields objectFields, name string, max int, messages []string) (optionalStrings, []string) {
	raw, ok := fields.values[name]
	if !ok {
		return optionalStrings{}, messages
	}
	if string(bytes.TrimSpace(raw)) == "null" {
		return optionalStrings{set: true}, append(messages, name+" must be an array")
	}
	values, extra := stringArrayValue(name, raw, max)
	return optionalStrings{set: true, value: values}, append(messages, extra...)
}

func optionalBoolField(fields objectFields, name string) (*bool, string) {
	raw, ok := fields.values[name]
	if !ok || string(bytes.TrimSpace(raw)) == "null" {
		return nil, ""
	}
	value, message := boolValue(name, raw)
	if message != "" {
		return nil, message
	}
	return boolPtr(value), ""
}

func boolValue(name string, raw json.RawMessage) (bool, string) {
	var value bool
	if err := json.Unmarshal(raw, &value); err != nil {
		return false, name + " must be a boolean value"
	}
	if string(bytes.TrimSpace(raw)) != "true" && string(bytes.TrimSpace(raw)) != "false" {
		return false, name + " must be a boolean value"
	}
	return value, ""
}

func decodeOptionalLocation(fields objectFields, name string) (*locationInput, string) {
	raw, ok := fields.values[name]
	if !ok || string(bytes.TrimSpace(raw)) == "null" {
		return nil, ""
	}
	return locationValue(raw)
}

func locationValue(raw json.RawMessage) (*locationInput, string) {
	var probe any
	if err := json.Unmarshal(raw, &probe); err != nil {
		return nil, "nested property location must be either object or array"
	}
	if _, ok := probe.(map[string]any); !ok {
		return nil, "nested property location must be either object or array"
	}
	fields, err := decodeObject(raw)
	if err != nil {
		return nil, "nested property location must be either object or array"
	}
	loc := &locationInput{}
	var messages []string
	if message := requireString(fields, "name", 64, &loc.Name); message != "" {
		messages = append(messages, "location."+message)
	}
	if rawLat, ok := fields.values["lat"]; ok && string(bytes.TrimSpace(rawLat)) != "null" {
		number, message := numberValue("lat", rawLat, -90, 90)
		if message != "" {
			messages = append(messages, "location."+message)
		} else {
			loc.Lat = number
			loc.HasLat = true
		}
	}
	if rawLng, ok := fields.values["lng"]; ok && string(bytes.TrimSpace(rawLng)) != "null" {
		number, message := numberValue("lng", rawLng, -180, 180)
		if message != "" {
			messages = append(messages, "location."+message)
		} else {
			loc.Lng = number
			loc.HasLng = true
		}
	}
	if message := optionalBoundedString(fields, "countryCodeAlpha2", 8, &loc.Country); message != "" {
		messages = append(messages, "location."+message)
	}
	messages = append(messages, prefixMessages("location", unknownMessages(fields, map[string]bool{
		"name": true, "lat": true, "lng": true, "countryCodeAlpha2": true,
	}))...)
	if len(messages) > 0 {
		return nil, strings.Join(messages, "; ")
	}
	return loc, ""
}

func prefixMessages(prefix string, messages []string) []string {
	out := make([]string, 0, len(messages))
	for _, message := range messages {
		out = append(out, prefix+"."+message)
	}
	return out
}

func numberValue(name string, raw json.RawMessage, min, max float64) (float64, string) {
	text := strings.TrimSpace(string(raw))
	if len(text) > 0 && text[0] == '"' {
		var asText string
		if err := json.Unmarshal(raw, &asText); err != nil {
			return 0, name + " must be a number conforming to the specified constraints"
		}
		text = strings.TrimSpace(asText)
	}
	number, err := strconv.ParseFloat(text, 64)
	if err != nil || !finite(number) {
		return 0, name + " must be a number conforming to the specified constraints"
	}
	if number < min {
		return 0, fmt.Sprintf("%s must not be less than %g", name, min)
	}
	if number > max {
		return 0, fmt.Sprintf("%s must not be greater than %g", name, max)
	}
	return number, ""
}

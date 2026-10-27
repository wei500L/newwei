package newssources

import (
	"bytes"
	"context"
	"encoding/json"
	"strings"
	"time"
)

type inputError struct{ Message string }

func (e *inputError) Error() string { return e.Message }

type listQuery struct {
	Page     int
	PageSize int
	Search   string
	Group    *string
	GroupSet bool
}

type createInput struct {
	Name                string
	URL                 string
	SiteType            string
	Language            *string
	CrawlTemplateID     *string
	WorkflowID          *string
	WorkflowVersionID   *string
	WorkflowBindingMode string
	FrequencySeconds    int
	Priority            int
	IsActive            bool
	Config              []byte
	Group               *string
}

type updateInput struct {
	Name                string
	NameSet             bool
	URL                 string
	URLSet              bool
	SiteType            string
	SiteTypeSet         bool
	Language            *string
	LanguageSet         bool
	CrawlTemplateID     *string
	CrawlTemplateSet    bool
	WorkflowID          *string
	WorkflowSet         bool
	WorkflowVersionID   *string
	WorkflowVersionSet  bool
	WorkflowBindingMode string
	BindingSet          bool
	FrequencySeconds    int
	FrequencySet        bool
	Priority            int
	PrioritySet         bool
	IsActive            bool
	ActiveSet           bool
	Config              []byte
	ConfigSet           bool
	Group               *string
	GroupSet            bool
}

var siteTypes = map[string]bool{
	"general": true, "finance": true, "technology": true, "politics": true, "regulatory": true, "other": true,
}

var bindingModes = map[string]bool{"published": true, "pinned": true}

func parseListQuery(values map[string][]string) (listQuery, error) {
	query := listQuery{Page: 1, PageSize: 10}
	var messages []string
	if raw, ok := values["page"]; ok {
		page, ok := intIn(raw[0], 1, 1<<30)
		if !ok {
			messages = append(messages, "page must be an integer number")
		} else {
			query.Page = page
		}
	}
	if raw, ok := values["pageSize"]; ok {
		size, ok := intIn(raw[0], 1, 50)
		if !ok {
			messages = append(messages, "pageSize must not be greater than 50")
		} else {
			query.PageSize = size
		}
	}
	if raw, ok := values["search"]; ok {
		if utf16Length(raw[0]) > 200 {
			messages = append(messages, "search must be shorter than or equal to 200 characters")
		}
		query.Search = strings.TrimSpace(raw[0])
	}
	if raw, ok := values["group"]; ok {
		if utf16Length(raw[0]) > 191 {
			messages = append(messages, "group must be shorter than or equal to 191 characters")
		}
		query.GroupSet = true
		trimmed := strings.TrimSpace(raw[0])
		if trimmed != "" {
			query.Group = &trimmed
		}
	}
	for key := range values {
		switch key {
		case "page", "pageSize", "search", "group":
		default:
			messages = append(messages, "property "+key+" should not exist")
		}
	}
	if len(messages) > 0 {
		return listQuery{}, &inputError{Message: strings.Join(messages, "; ")}
	}
	return query, nil
}

func parseCreate(ctx context.Context, body []byte) (createInput, error) {
	fields, err := objectFields(body)
	if err != nil {
		return createInput{}, err
	}
	allowed := map[string]bool{
		"name": true, "url": true, "siteType": true, "language": true, "crawlTemplateId": true,
		"workflowId": true, "workflowVersionId": true, "workflowBindingMode": true,
		"frequencySeconds": true, "priority": true, "isActive": true, "config": true, "group": true,
	}
	if err := rejectUnknown(fields, allowed); err != nil {
		return createInput{}, err
	}
	var messages []string
	name, nameOK := requiredString(fields, "name", 200, &messages)
	rawURL, urlOK := requiredString(fields, "url", 2048, &messages)
	input := createInput{
		Name:                strings.TrimSpace(name),
		SiteType:            "general",
		WorkflowBindingMode: "published",
		FrequencySeconds:    3600,
		IsActive:            true,
	}
	if nameOK && input.Name == "" {
		messages = append(messages, "name is required")
	}
	if urlOK {
		input.URL = strings.TrimSpace(rawURL)
		if reason := validateSSRFSync(input.URL); reason != "" {
			messages = append(messages, reason)
		}
	}
	if raw, ok := fields["siteType"]; ok {
		text, ok := jsonString(raw)
		if !ok || !siteTypes[text] {
			messages = append(messages, "siteType must be one of the following values: general, finance, technology, politics, regulatory, other")
		} else {
			input.SiteType = text
		}
	}
	if text, ok, valid := optionalString(fields, "language", 12, &messages); ok {
		if valid {
			input.Language = trimmedOrNil(text)
		}
	}
	if text, ok, valid := optionalString(fields, "crawlTemplateId", 191, &messages); ok && valid {
		input.CrawlTemplateID = trimmedOrNil(text)
	}
	if text, ok, valid := optionalString(fields, "workflowId", 191, &messages); ok && valid {
		input.WorkflowID = trimmedOrNil(text)
	}
	if text, ok, valid := optionalString(fields, "workflowVersionId", 191, &messages); ok && valid {
		input.WorkflowVersionID = trimmedOrNil(text)
	}
	if raw, ok := fields["workflowBindingMode"]; ok {
		text, ok := jsonString(raw)
		if !ok || !bindingModes[text] {
			messages = append(messages, "workflowBindingMode must be one of the following values: published, pinned")
		} else {
			input.WorkflowBindingMode = text
		}
	}
	if raw, ok := fields["frequencySeconds"]; ok {
		value, ok := jsonInt(raw, 60, 2_592_000)
		if !ok {
			messages = append(messages, "frequencySeconds must not be less than 60")
		} else {
			input.FrequencySeconds = value
		}
	}
	if raw, ok := fields["priority"]; ok {
		value, ok := jsonInt(raw, -100, 100)
		if !ok {
			messages = append(messages, "priority must not be less than -100")
		} else {
			input.Priority = value
		}
	}
	if raw, ok := fields["isActive"]; ok {
		value, ok := jsonBool(raw)
		if !ok {
			messages = append(messages, "isActive must be a boolean value")
		} else {
			input.IsActive = value
		}
	}
	if raw, ok := fields["config"]; ok {
		encoded, err := normalizeConfig(raw)
		if err != nil {
			messages = append(messages, err.Error())
		} else {
			input.Config = encoded
		}
	}
	if text, ok, valid := optionalString(fields, "group", 191, &messages); ok && valid {
		input.Group = trimmedOrNil(text)
	}
	if len(messages) > 0 {
		return createInput{}, &inputError{Message: strings.Join(messages, "; ")}
	}
	if reason, ok := validateSourceURL(ctx, input.URL); !ok {
		return createInput{}, &inputError{Message: reason}
	}
	return input, nil
}

func parseUpdate(ctx context.Context, body []byte) (updateInput, error) {
	fields, err := objectFields(body)
	if err != nil {
		return updateInput{}, err
	}
	allowed := map[string]bool{
		"name": true, "url": true, "siteType": true, "language": true, "crawlTemplateId": true,
		"workflowId": true, "workflowVersionId": true, "workflowBindingMode": true,
		"frequencySeconds": true, "priority": true, "isActive": true, "config": true, "group": true,
	}
	if err := rejectUnknown(fields, allowed); err != nil {
		return updateInput{}, err
	}
	var input updateInput
	var messages []string
	if raw, ok := fields["name"]; ok {
		text, ok := jsonString(raw)
		input.NameSet = true
		input.Name = strings.TrimSpace(text)
		if !ok || strings.TrimSpace(text) == "" {
			messages = append(messages, "name should not be empty")
		} else if utf16Length(text) > 200 {
			messages = append(messages, "name must be shorter than or equal to 200 characters")
		} else if input.Name == "" {
			messages = append(messages, "name is required")
		}
	}
	if raw, ok := fields["url"]; ok {
		text, ok := jsonString(raw)
		input.URLSet = true
		if !ok || utf16Length(text) > 2048 {
			messages = append(messages, "url must be a URL address")
		} else if reason := validateSSRFSync(strings.TrimSpace(text)); reason != "" {
			messages = append(messages, reason)
		} else if reason, safe := validateSourceURL(ctx, strings.TrimSpace(text)); !safe {
			messages = append(messages, reason)
		} else {
			input.URL = strings.TrimSpace(text)
		}
	}
	if raw, ok := fields["siteType"]; ok {
		text, ok := jsonString(raw)
		if !ok || !siteTypes[text] {
			messages = append(messages, "siteType must be one of the following values: general, finance, technology, politics, regulatory, other")
		} else {
			input.SiteTypeSet = true
			input.SiteType = text
		}
	}
	if text, ok, valid := optionalString(fields, "language", 12, &messages); ok {
		input.LanguageSet = true
		if valid {
			input.Language = trimmedOrNil(text)
		}
	}
	if text, ok, valid := optionalString(fields, "crawlTemplateId", 191, &messages); ok {
		input.CrawlTemplateSet = true
		if valid {
			input.CrawlTemplateID = trimmedOrNil(text)
		}
	}
	if text, ok, valid := optionalString(fields, "workflowId", 191, &messages); ok {
		input.WorkflowSet = true
		if valid {
			input.WorkflowID = trimmedOrNil(text)
		}
	}
	if text, ok, valid := optionalString(fields, "workflowVersionId", 191, &messages); ok {
		input.WorkflowVersionSet = true
		if valid {
			input.WorkflowVersionID = trimmedOrNil(text)
		}
	}
	if raw, ok := fields["workflowBindingMode"]; ok {
		text, ok := jsonString(raw)
		if !ok || !bindingModes[text] {
			messages = append(messages, "workflowBindingMode must be one of the following values: published, pinned")
		} else {
			input.BindingSet = true
			input.WorkflowBindingMode = text
		}
	}
	if raw, ok := fields["frequencySeconds"]; ok {
		value, ok := jsonInt(raw, 60, 2_592_000)
		if !ok {
			messages = append(messages, "frequencySeconds must not be less than 60")
		} else {
			input.FrequencySet = true
			input.FrequencySeconds = value
		}
	}
	if raw, ok := fields["priority"]; ok {
		value, ok := jsonInt(raw, -100, 100)
		if !ok {
			messages = append(messages, "priority must not be less than -100")
		} else {
			input.PrioritySet = true
			input.Priority = value
		}
	}
	if raw, ok := fields["isActive"]; ok {
		value, ok := jsonBool(raw)
		if !ok {
			messages = append(messages, "isActive must be a boolean value")
		} else {
			input.ActiveSet = true
			input.IsActive = value
		}
	}
	if raw, ok := fields["config"]; ok {
		input.ConfigSet = true
		encoded, err := normalizeConfig(raw)
		if err != nil {
			messages = append(messages, err.Error())
		} else {
			input.Config = encoded
		}
	}
	if text, ok, valid := optionalString(fields, "group", 191, &messages); ok {
		input.GroupSet = true
		if valid {
			input.Group = trimmedOrNil(text)
		}
	}
	if len(messages) > 0 {
		return updateInput{}, &inputError{Message: strings.Join(messages, "; ")}
	}
	return input, nil
}

func parseSchedule(body []byte) (time.Time, error) {
	fields, err := objectFields(body)
	if err != nil {
		return time.Time{}, err
	}
	if err := rejectUnknown(fields, map[string]bool{"nextRunAt": true}); err != nil {
		return time.Time{}, err
	}
	raw, ok := fields["nextRunAt"]
	text, isString := jsonString(raw)
	if !ok || !isString {
		return time.Time{}, &inputError{Message: "nextRunAt must be a valid ISO 8601 date string"}
	}
	parsed, ok := parseISO(text)
	if !ok {
		return time.Time{}, &inputError{Message: "nextRunAt must be a valid ISO date string"}
	}
	return parsed, nil
}

func parseISO(value string) (time.Time, bool) {
	for _, layout := range []string{time.RFC3339Nano, time.RFC3339, "2006-01-02T15:04:05.000Z07:00", "2006-01-02"} {
		if parsed, err := time.Parse(layout, value); err == nil {
			return parsed, true
		}
	}
	return time.Time{}, false
}

func parseIDs(body []byte, group bool, active bool) (ids []string, groupValue *string, groupSet bool, isActive bool, err error) {
	fields, err := objectFields(body)
	if err != nil {
		return nil, nil, false, false, err
	}
	allowed := map[string]bool{"ids": true}
	if group {
		allowed["group"] = true
	}
	if active {
		allowed["isActive"] = true
	}
	if err := rejectUnknown(fields, allowed); err != nil {
		return nil, nil, false, false, err
	}
	raw, ok := fields["ids"]
	if !ok {
		return nil, nil, false, false, &inputError{Message: "ids must contain at least 1 elements"}
	}
	var parsed []any
	if json.Unmarshal(raw, &parsed) != nil {
		return nil, nil, false, false, &inputError{Message: "ids must be an array"}
	}
	if len(parsed) < 1 || len(parsed) > 500 {
		return nil, nil, false, false, &inputError{Message: "ids must contain at least 1 elements"}
	}
	ids = make([]string, 0, len(parsed))
	for _, item := range parsed {
		text, ok := item.(string)
		if !ok || utf16Length(text) > 191 {
			return nil, nil, false, false, &inputError{Message: "each value in ids must be a string"}
		}
		ids = append(ids, text)
	}
	if group {
		raw, ok := fields["group"]
		if !ok {
			return nil, nil, false, false, &inputError{Message: "group is required; pass null to clear"}
		}
		if string(bytes.TrimSpace(raw)) == "null" {
			return ids, nil, true, false, nil
		}
		text, ok := jsonString(raw)
		if !ok || utf16Length(text) > 191 {
			return nil, nil, false, false, &inputError{Message: "group must be shorter than or equal to 191 characters"}
		}
		return ids, trimmedOrNil(text), true, false, nil
	}
	if active {
		value, ok := jsonBool(fields["isActive"])
		if !ok {
			return nil, nil, false, false, &inputError{Message: "isActive must be a boolean value"}
		}
		return ids, nil, false, value, nil
	}
	return ids, nil, false, false, nil
}

func parseFrequency(body []byte) (int, error) {
	fields, err := objectFields(body)
	if err != nil {
		return 0, err
	}
	if err := rejectUnknown(fields, map[string]bool{"frequencySeconds": true}); err != nil {
		return 0, err
	}
	value, ok := jsonInt(fields["frequencySeconds"], 60, 2_592_000)
	if !ok {
		return 0, &inputError{Message: "frequencySeconds must not be less than 60"}
	}
	return value, nil
}

func objectFields(body []byte) (map[string]json.RawMessage, error) {
	if len(bytes.TrimSpace(body)) == 0 {
		body = []byte("{}")
	}
	var fields map[string]json.RawMessage
	if json.Unmarshal(body, &fields) != nil || fields == nil {
		return nil, &inputError{Message: "Expected property name or '}' in JSON at position 1"}
	}
	return fields, nil
}

func rejectUnknown(fields map[string]json.RawMessage, allowed map[string]bool) error {
	var messages []string
	for key := range fields {
		if !allowed[key] {
			messages = append(messages, "property "+key+" should not exist")
		}
	}
	if len(messages) > 0 {
		return &inputError{Message: strings.Join(messages, "; ")}
	}
	return nil
}

func requiredString(fields map[string]json.RawMessage, key string, max int, messages *[]string) (string, bool) {
	raw, ok := fields[key]
	if !ok {
		*messages = append(*messages, key+" should not be empty")
		return "", false
	}
	text, ok := jsonString(raw)
	if !ok {
		*messages = append(*messages, key+" must be a string")
		return "", false
	}
	if strings.TrimSpace(text) == "" && key == "name" {
		*messages = append(*messages, "name should not be empty")
		return "", false
	}
	if utf16Length(text) > max {
		*messages = append(*messages, key+" must be shorter than or equal to "+itoa(max)+" characters")
		return "", false
	}
	return text, true
}

func optionalString(fields map[string]json.RawMessage, key string, max int, messages *[]string) (string, bool, bool) {
	raw, ok := fields[key]
	if !ok {
		return "", false, false
	}
	if string(bytes.TrimSpace(raw)) == "null" {
		return "", true, true
	}
	text, ok := jsonString(raw)
	if !ok || utf16Length(text) > max {
		*messages = append(*messages, key+" must be shorter than or equal to "+itoa(max)+" characters")
		return "", true, false
	}
	return text, true, true
}

func trimmedOrNil(value string) *string {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return nil
	}
	return &trimmed
}

func jsonString(raw json.RawMessage) (string, bool) {
	var text string
	if json.Unmarshal(raw, &text) != nil {
		return "", false
	}
	return text, true
}

func jsonBool(raw json.RawMessage) (bool, bool) {
	var value bool
	if json.Unmarshal(raw, &value) != nil {
		return false, false
	}
	if string(bytes.TrimSpace(raw)) != "true" && string(bytes.TrimSpace(raw)) != "false" {
		return false, false
	}
	return value, true
}

func jsonInt(raw json.RawMessage, min, max int) (int, bool) {
	var value int
	if json.Unmarshal(raw, &value) != nil {
		return 0, false
	}
	if strings.Contains(string(raw), ".") || value < min || value > max {
		return 0, false
	}
	return value, true
}

func intIn(raw string, min, max int) (int, bool) {
	value, ok := jsonInt(json.RawMessage(raw), min, max)
	if ok {
		return value, true
	}
	quoted, err := json.Marshal(raw)
	if err != nil {
		return 0, false
	}
	return jsonInt(quoted, min, max)
}

func itoa(value int) string {
	if value == 0 {
		return "0"
	}
	var buf [16]byte
	i := len(buf)
	for value > 0 {
		i--
		buf[i] = byte('0' + value%10)
		value /= 10
	}
	return string(buf[i:])
}

// utf16Length is the JavaScript string length class-validator's MaxLength
// compares against: UTF-16 code units, not UTF-8 bytes. A name or group made of
// CJK characters is three bytes per rune but one code unit, so a byte length
// would reject values NestJS accepted.
func utf16Length(value string) int {
	length := 0
	for _, char := range value {
		if char > 0xFFFF {
			length += 2
			continue
		}
		length++
	}
	return length
}

package situationsignals

import (
	"strings"
)

// This file reproduces the class-validator behaviour of
// SituationMonitorSignalFeedbackDto
// (apps/api/src/modules/situation-monitor/dto/situation-monitor.dto.ts) under
// the global ValidationPipe configuration in apps/api/src/main.ts:
// whitelist + forbidNonWhitelisted + transform.
//
// Message order is property declaration order, unknown-property messages last,
// and within one property the decorators apply bottom-up, so `@IsString()`
// declared above `@IsIn(...)` yields the enum message first. Both facts are
// already encoded in the sibling Go domains and were confirmed against NestJS
// by their real-stack smokes.

// feedbackSignalTypes is the @IsIn list for signalType.
var feedbackSignalTypes = []string{"narrative", "correlation"}

// feedbackLabels is the @IsIn list for label.
var feedbackLabels = []string{"false_positive", "false_negative"}

// feedbackAllowedFields is the whitelist for the feedback body.
var feedbackAllowedFields = map[string]bool{
	"signalType": true,
	"signalId":   true,
	"label":      true,
	"itemMetaId": true,
	"itemLink":   true,
	"itemTitle":  true,
	"itemSource": true,
	"note":       true,
}

// feedbackInput is the validated feedback body. Strings are kept untrimmed: the
// service trims them, exactly like recordFeedback does.
type feedbackInput struct {
	SignalType string
	SignalID   string
	Label      string
	ItemMetaID string
	ItemLink   string
	ItemTitle  string
	ItemSource string
	Note       string
}

// validateFeedbackBody validates a request body and reports the class-validator
// message. A non-object body yields the ValidationPipe "unknown value" message.
func validateFeedbackBody(body []byte) (feedbackInput, error) {
	fields, ok := decodeObjectFields(body)
	if !ok {
		return feedbackInput{}, newStatus(400, "an unknown value was passed to the validate function")
	}
	var messages []string
	input := feedbackInput{}

	input.SignalType, messages = enumStringField(fields, "signalType", feedbackSignalTypes, messages, false)
	input.SignalID, messages = stringField(fields, "signalId", messages, false)
	input.Label, messages = enumStringField(fields, "label", feedbackLabels, messages, false)
	input.ItemMetaID, messages = stringField(fields, "itemMetaId", messages, true)
	input.ItemLink, messages = stringField(fields, "itemLink", messages, true)
	input.ItemTitle, messages = stringField(fields, "itemTitle", messages, true)
	input.ItemSource, messages = stringField(fields, "itemSource", messages, true)
	input.Note, messages = stringField(fields, "note", messages, true)

	// forbidNonWhitelisted runs after the per-property validators, in body key
	// order (usersettingswrite/plan_test.go pins the same ordering for NestJS).
	for _, key := range fields.order {
		if !feedbackAllowedFields[key] {
			messages = append(messages, "property "+key+" should not exist")
		}
	}
	if len(messages) > 0 {
		return feedbackInput{}, newStatus(400, strings.Join(messages, "; "))
	}
	return input, nil
}

// stringField validates a single @IsString() / @IsOptional() @IsString()
// property. A missing key or a JSON null passes when optional.
func stringField(fields jsonObjectFields, name string, messages []string, optional bool) (string, []string) {
	raw, exists := fields.values[name]
	if !exists {
		if optional {
			return "", messages
		}
		return "", append(messages, name+" must be a string")
	}
	if optional && isJSONNull(raw) {
		// @IsOptional() skips every other validator for null and undefined.
		return "", messages
	}
	value := rawJSON{raw: raw}
	if text, ok := value.asString(); ok {
		return text, messages
	}
	return "", append(messages, name+" must be a string")
}

// enumStringField validates a required `@IsString() @IsIn(values)` property or
// an optional `@IsOptional() @IsString() @IsIn(values)` one. The enum message is
// emitted before the type message because decorators apply bottom-up.
func enumStringField(fields jsonObjectFields, name string, values []string, messages []string, optional bool) (string, []string) {
	raw, exists := fields.values[name]
	if !exists {
		if optional {
			return "", messages
		}
		return "", append(messages, enumMessage(name, values), name+" must be a string")
	}
	if optional && isJSONNull(raw) {
		return "", messages
	}
	text, ok := rawJSON{raw: raw}.asString()
	if !ok {
		return "", append(messages, enumMessage(name, values), name+" must be a string")
	}
	for _, candidate := range values {
		if candidate == text {
			return text, messages
		}
	}
	return "", append(messages, enumMessage(name, values))
}

// enumMessage mirrors @IsIn's default message.
func enumMessage(name string, values []string) string {
	return name + " must be one of the following values: " + strings.Join(values, ", ")
}

// isJSONNull reports whether a raw JSON value is literally null.
func isJSONNull(raw []byte) bool {
	return strings.TrimSpace(string(raw)) == "null"
}

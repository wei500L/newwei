package exceptioningest

import (
	"encoding/json"
	"math"
	"strconv"
	"strings"
	"time"
)

// Length limits copied from ClientExceptionEventsController; the internal
// endpoint intentionally has no per-field limits and only caps the stack trace
// at 8000 UTF-16 code units (ExceptionEventsService.record).
const (
	messageMaxLength       = 1000
	traceIDMaxLength       = 128
	timestampMaxLength     = 64
	pathMaxLength          = 512
	methodMaxLength        = 16
	operationMaxLength     = 120
	operationNameMaxLength = 160
	errorNameMaxLength     = 120
	stackMaxLength         = 8000
)

// invalidJSONMessage is the 400 body used when the request body cannot be
// decoded as a JSON object.
const invalidJSONMessage = "Unexpected end of JSON input"

// normalizeClientReport mirrors ClientExceptionEventsController.report field
// by field, including the error order: message, x-trace-id, body traceId,
// timestamp, statusCode, path, method, operation, operationName, errorName.
// The returned string is the 400 message ("" means the payload is valid).
func normalizeClientReport(body []byte, incomingTraceID string) (ExceptionEvent, string) {
	var fields clientBody
	if err := json.Unmarshal(body, &fields); err != nil {
		return ExceptionEvent{}, invalidJSONMessage
	}

	message, messageErr := normalizeLimitedString(fields.Message, "message", messageMaxLength)
	if messageErr != "" {
		return ExceptionEvent{}, messageErr
	}
	if message == "" {
		return ExceptionEvent{}, "message is required"
	}

	traceID, traceErr := normalizePlainString(incomingTraceID, "x-trace-id", traceIDMaxLength)
	if traceErr != "" {
		return ExceptionEvent{}, traceErr
	}
	if traceID == "" {
		bodyTraceID, bodyTraceErr := normalizeLimitedString(fields.TraceID, "traceId", traceIDMaxLength)
		if bodyTraceErr != "" {
			return ExceptionEvent{}, bodyTraceErr
		}
		traceID = bodyTraceID
	}

	timestampText, timestampErr := normalizeLimitedString(fields.Timestamp, "timestamp", timestampMaxLength)
	if timestampErr != "" {
		return ExceptionEvent{}, timestampErr
	}
	path, pathErr := normalizeLimitedString(fields.Path, "path", pathMaxLength)
	if pathErr != "" {
		return ExceptionEvent{}, pathErr
	}
	method, methodErr := normalizeLimitedString(fields.Method, "method", methodMaxLength)
	if methodErr != "" {
		return ExceptionEvent{}, methodErr
	}
	operation, operationErr := normalizeLimitedString(fields.Operation, "operation", operationMaxLength)
	if operationErr != "" {
		return ExceptionEvent{}, operationErr
	}
	operationName, operationNameErr := normalizeLimitedString(
		fields.OperationName, "operationName", operationNameMaxLength)
	if operationNameErr != "" {
		return ExceptionEvent{}, operationNameErr
	}
	errorName, errorNameErr := normalizeLimitedString(fields.ErrorName, "errorName", errorNameMaxLength)
	if errorNameErr != "" {
		return ExceptionEvent{}, errorNameErr
	}

	return ExceptionEvent{
		Kind:          normalizeKind(fields.Kind),
		TraceID:       traceID,
		Timestamp:     resolveTimestamp(timestampText),
		StatusCode:    normalizeStatusCode(fields.StatusCode),
		Message:       message,
		Path:          path,
		Method:        upperMethod(method),
		Operation:     operation,
		OperationName: operationName,
		ErrorName:     errorName,
		// Client stacks are never persisted (the controller passes
		// stack: undefined).
		Stack: "",
	}, ""
}

// normalizeInternalReport mirrors InternalExceptionEventsController.report.
// The internal endpoint keeps its own string handling: no length limits and no
// trimming beyond trim-and-empty-to-absent; only the stack trace is sliced to
// 8000 characters by ExceptionEventsService.record.
func normalizeInternalReport(body []byte, incomingTraceID string) (ExceptionEvent, string) {
	var fields internalBody
	if err := json.Unmarshal(body, &fields); err != nil {
		return ExceptionEvent{}, invalidJSONMessage
	}

	message := normalizeInternalString(fields.Message)
	if message == "" {
		return ExceptionEvent{}, "message is required"
	}

	traceID := normalizeInternalString(fields.TraceID)
	if traceID == "" {
		traceID = normalizeInternalString(rawStringValue(incomingTraceID))
	}

	return ExceptionEvent{
		Kind:          normalizeKind(fields.Kind),
		TraceID:       traceID,
		Timestamp:     resolveTimestamp(normalizeInternalString(fields.Timestamp)),
		StatusCode:    normalizeStatusCode(fields.StatusCode),
		Message:       message,
		Path:          normalizeInternalString(fields.Path),
		Method:        upperMethod(normalizeInternalString(fields.Method)),
		Operation:     normalizeInternalString(fields.Operation),
		OperationName: normalizeInternalString(fields.OperationName),
		ErrorName:     normalizeInternalString(fields.ErrorName),
		Stack:         normalizeStack(fields.Stack),
		OrgID:         normalizeInternalString(fields.OrgID),
		UserID:        normalizeInternalString(fields.UserID),
	}, ""
}

// rawStringValue adapts a plain header string to the json.RawMessage leaf
// normalizers expect, so an undefined header stays absent and a real header is
// treated exactly like a JSON string.
func rawStringValue(value string) json.RawMessage {
	if value == "" {
		return nil
	}
	encoded, err := json.Marshal(value)
	if err != nil {
		return nil
	}
	return encoded
}

// normalizeLimitedString mirrors ClientExceptionEventsController.normalizeString:
// non-strings and blank strings are absent; a trimmed value longer than max is a
// 400.
func normalizeLimitedString(raw json.RawMessage, fieldName string, maxLength int) (string, string) {
	text, ok := jsonString(raw)
	if !ok {
		return "", ""
	}
	trimmed := strings.TrimSpace(text)
	if trimmed == "" {
		return "", ""
	}
	if jsStringLength(trimmed) > maxLength {
		return "", fieldName + " is too long (max " + strconv.Itoa(maxLength) + " characters)"
	}
	return trimmed, ""
}

// normalizePlainString applies the same normalization to the x-trace-id header.
func normalizePlainString(value, fieldName string, maxLength int) (string, string) {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return "", ""
	}
	if jsStringLength(trimmed) > maxLength {
		return "", fieldName + " is too long (max " + strconv.Itoa(maxLength) + " characters)"
	}
	return trimmed, ""
}

// normalizeInternalString mirrors the internal controller's normalizeString:
// trim, and an empty result is absent. No length limit.
func normalizeInternalString(raw json.RawMessage) string {
	text, ok := jsonString(raw)
	if !ok {
		return ""
	}
	return strings.TrimSpace(text)
}

// normalizeMethod upper-cases a normalized method (both controllers do
// method.toUpperCase()).
func upperMethod(method string) string {
	if method == "" {
		return ""
	}
	return strings.ToUpper(method)
}

// normalizeKind maps anything outside the enum to "unknown" without trimming.
func normalizeKind(raw json.RawMessage) exceptionEventKind {
	text, ok := jsonString(raw)
	if !ok {
		return kindUnknown
	}
	switch exceptionEventKind(text) {
	case kindHTTP:
		return kindHTTP
	case kindGraphQL:
		return kindGraphQL
	case kindUnknown:
		return kindUnknown
	default:
		return kindUnknown
	}
}

// normalizeStatusCode mirrors the controllers: coerce like JavaScript Number,
// require a finite value, floor it and keep only 100..599.
func normalizeStatusCode(raw json.RawMessage) *int {
	numeric := jsNumberFromJSON(raw)
	if math.IsNaN(numeric) || math.IsInf(numeric, 0) {
		return nil
	}
	floored := math.Floor(numeric)
	if floored < 100 || floored > 599 {
		return nil
	}
	code := int(floored)
	return &code
}

// resolveTimestamp parses a normalized timestamp string in UTC; a missing or
// invalid value falls back to the current time (ExceptionEventsService.record).
func resolveTimestamp(value string) time.Time {
	if value != "" {
		if parsed, ok := parseLooseTime(value); ok {
			return parsed.UTC()
		}
	}
	return time.Now().UTC()
}

// normalizeStack trims the internal stack and slices it to the record limit.
func normalizeStack(raw json.RawMessage) string {
	stack := normalizeInternalString(raw)
	if stack == "" {
		return ""
	}
	return jsSliceUTF16(stack, stackMaxLength)
}

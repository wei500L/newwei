package itempipeline

// Port of @modular/utils sanitizeError for the two places QueueProcessor stores
// an error: ProcessedItem.error {message, name, stack?} and the read model
// processed.error {message, name}. NODE_ENV=production removes the stack; the Go
// implementation never has a JavaScript stack, so it writes message + name only
// (the Mongo schema has no status member, and the message redaction patterns are
// preserved because they can hide credentials from operators).

import "regexp"

const redactedValue = "[REDACTED]"

// sanitizedError is the stored error shape.
type sanitizedError struct {
	Message string  `json:"message" bson:"message"`
	Name    *string `json:"name,omitempty" bson:"name,omitempty"`
}

var sensitivePatterns = []*regexp.Regexp{
	regexp.MustCompile(`(?i)password\s*[=:]\s*['"]?[^'"\s,}]+['"]?`),
	regexp.MustCompile(`(?i)token\s*[=:]\s*['"]?[^'"\s,}]+['"]?`),
	regexp.MustCompile(`(?i)apiKey\s*[=:]\s*['"]?[^'"\s,}]+['"]?`),
	regexp.MustCompile(`(?i)api_key\s*[=:]\s*['"]?[^'"\s,}]+['"]?`),
	regexp.MustCompile(`(?i)secret\s*[=:]\s*['"]?[^'"\s,}]+['"]?`),
	regexp.MustCompile(`(?i)credential\s*[=:]\s*['"]?[^'"\s,}]+['"]?`),
	regexp.MustCompile(`(?i)auth\s*[=:]\s*['"]?[^'"\s,}]+['"]?`),
	regexp.MustCompile(`(?i)bearer\s+[a-zA-Z0-9._-]+`),
	regexp.MustCompile(`(?i)basic\s+[a-zA-Z0-9+/=]+`),
}

// redactSensitiveFields is redactSensitiveFields.
func redactSensitiveFields(input string) string {
	if input == "" {
		return input
	}
	result := input
	for _, pattern := range sensitivePatterns {
		result = pattern.ReplaceAllStringFunc(result, redactMatch)
	}
	return result
}

func redactMatch(match string) string {
	separatorIndex := -1
	for index := 0; index < len(match); index++ {
		if match[index] == '=' || match[index] == ':' {
			separatorIndex = index
			break
		}
	}
	if separatorIndex >= 0 {
		return match[:separatorIndex+1] + redactedValue
	}
	lower := toLowerASCII(match)
	if len(lower) >= 6 && lower[:6] == "bearer" {
		return "Bearer " + redactedValue
	}
	if len(lower) >= 5 && lower[:5] == "basic" {
		return "Basic " + redactedValue
	}
	return redactedValue
}

func toLowerASCII(value string) string {
	bytes := []byte(value)
	for index := range bytes {
		if bytes[index] >= 'A' && bytes[index] <= 'Z' {
			bytes[index] += 'a' - 'A'
		}
	}
	return string(bytes)
}

// sanitizeError is sanitizeError with the default options.
func sanitizeError(err error) sanitizedError {
	message := "Unknown error"
	name := "Error"
	if err != nil {
		if text := err.Error(); text != "" {
			message = text
		} else {
			message = "Unknown error"
		}
		name = errorName(err)
	}
	return sanitizedError{Message: redactSensitiveFields(message), Name: &name}
}

// sanitizedErrorFromValue mirrors the non-Error input branch (`String(error)`).
func sanitizedErrorFromValue(value any) sanitizedError {
	message := "Unknown error"
	if value != nil {
		message = redactSensitiveFields(toStringValue(value))
	}
	return sanitizedError{Message: message}
}

func toStringValue(value any) string {
	switch typed := value.(type) {
	case string:
		return typed
	case error:
		return typed.Error()
	default:
		// JavaScript String(value) for a non-Error object.
		return "[object Object]"
	}
}

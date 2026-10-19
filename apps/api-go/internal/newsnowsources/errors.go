package newsnowsources

import (
	"fmt"
	"net/http"
	"strings"
)

// Error codes preserved from news-aggregator.errors.ts and the service.
const (
	// CodeRuntimeSecretRequired is the 424 code for a provider that needs a
	// runtime credential which is not configured.
	CodeRuntimeSecretRequired = "NEWS_SOURCE_RUNTIME_SECRET_REQUIRED"
	// CodeSourceFetchFailed is the 502 code for a generic upstream/parse error.
	CodeSourceFetchFailed = "NEWS_SOURCE_FETCH_FAILED"
)

// APIError is a typed HTTP error. Message is the value batch responses surface
// through `error.message`; Code/Detail only appear on the single-source HTTP
// response.
type APIError struct {
	Status  int
	Message string
	Code    string
	Detail  string
}

// Error implements error.
func (e *APIError) Error() string { return e.Message }

// UnknownSourceError mirrors NotFoundException(`Unknown source: ${id}`).
func UnknownSourceError(id string) *APIError {
	return &APIError{Status: http.StatusNotFound, Message: "Unknown source: " + id}
}

// MissingGetterError mirrors NotFoundException(`Source getter not found: ${id}`).
func MissingGetterError(id string) *APIError {
	return &APIError{Status: http.StatusNotFound, Message: "Source getter not found: " + id}
}

// BadRequestError mirrors BadRequestException(message).
func BadRequestError(message string) *APIError {
	return &APIError{Status: http.StatusBadRequest, Message: message}
}

// SecretRequiredError is raised by providers that cannot run without a runtime
// credential. It carries the suggested key names for the 424 detail.
type SecretRequiredError struct {
	SourceID     string
	RequiredKeys []string
	Message      string
}

// Error implements error.
func (e *SecretRequiredError) Error() string {
	if e.Message != "" {
		return e.Message
	}
	return "Runtime secret required for news source: " + e.SourceID
}

// RuntimeSecretAPIError mirrors buildSourceFetchException's 424 branch,
// including de-duplicated non-empty key names and the two detail variants.
func RuntimeSecretAPIError(sourceID string, requiredKeys []string) *APIError {
	keys := make([]string, 0, len(requiredKeys))
	seen := make(map[string]struct{}, len(requiredKeys))
	for _, key := range requiredKeys {
		trimmed := strings.TrimSpace(key)
		if trimmed == "" {
			continue
		}
		if _, ok := seen[trimmed]; ok {
			continue
		}
		seen[trimmed] = struct{}{}
		keys = append(keys, trimmed)
	}
	detail := "Configure the required runtime secret in system settings."
	if len(keys) > 0 {
		detail = "Configure at least one runtime secret: " + strings.Join(keys, ", ")
	}
	return &APIError{
		Status:  http.StatusFailedDependency,
		Message: "Runtime secret required for news source: " + sourceID,
		Code:    CodeRuntimeSecretRequired,
		Detail:  detail,
	}
}

// FetchFailedAPIError mirrors buildSourceFetchException's generic 502 branch:
// the detail is the underlying message truncated to 240 UTF-16 code units.
func FetchFailedAPIError(sourceID string, cause error) *APIError {
	detail := ""
	if cause != nil {
		detail = cause.Error()
	}
	return &APIError{
		Status:  http.StatusBadGateway,
		Message: "Failed to fetch news source: " + sourceID,
		Code:    CodeSourceFetchFailed,
		Detail:  truncateUTF16(detail, 240),
	}
}

// truncateUTF16 mirrors `value.length > limit ? value.slice(0, limit-3) + "..."`
// because JavaScript string length counts UTF-16 code units.
func truncateUTF16(value string, limit int) string {
	if utf16Length(value) <= limit {
		return value
	}
	return sliceUTF16(value, limit-3) + "..."
}

// utf16Length counts UTF-16 code units.
func utf16Length(value string) int {
	units := 0
	for _, r := range value {
		if r > 0xFFFF {
			units += 2
			continue
		}
		units++
	}
	return units
}

// sliceUTF16 keeps the first n UTF-16 code units, never splitting a surrogate
// pair.
func sliceUTF16(value string, n int) string {
	if n <= 0 {
		return ""
	}
	units := 0
	for index, r := range value {
		width := 1
		if r > 0xFFFF {
			width = 2
		}
		if units+width > n {
			return value[:index]
		}
		units += width
	}
	return value
}

// errorName mirrors HttpStatus[status] formatting used by the global exception
// filter ("Failed Dependency", "Bad Gateway", ...).
func errorName(status int) string {
	switch status {
	case http.StatusBadRequest:
		return "Bad Request"
	case http.StatusNotFound:
		return "Not Found"
	case http.StatusFailedDependency:
		return "Failed Dependency"
	case http.StatusBadGateway:
		return "Bad Gateway"
	case http.StatusInternalServerError:
		return "Internal Server Error"
	default:
		if text := http.StatusText(status); text != "" {
			return text
		}
		return fmt.Sprintf("Error %d", status)
	}
}

package litellmcompat

import (
	"errors"
	"fmt"
	"regexp"
	"strings"
)

// GuardrailViolationError is a content-safety refusal. Nest stops the fallback
// chain on this error instead of trying the next model.
type GuardrailViolationError struct {
	Message           string
	Code              string
	UpstreamStatus    int
	AppliedGuardrails []string
}

func (e *GuardrailViolationError) Error() string {
	if e == nil {
		return ""
	}
	return e.Message
}

// CompatibilityError is an OpenAI-compatibility failure detected from the
// upstream message. Nest also stops the fallback chain on it.
type CompatibilityError struct {
	Code              string
	IncompatibleField string
	Hint              string
	UpstreamMessage   string
	Status            int
}

func (e *CompatibilityError) Error() string {
	if e == nil {
		return ""
	}
	return fmt.Sprintf("LLM compatibility error [%s] on %s: %s", e.Code, e.IncompatibleField, e.Hint)
}

var (
	bearerPattern    = regexp.MustCompile(`(?i)Bearer\s+[A-Za-z0-9._-]+`)
	openAIKeyPattern = regexp.MustCompile(`\bsk-[A-Za-z0-9]{10,}\b`)
)

func redactSensitiveText(raw string) string {
	redacted := bearerPattern.ReplaceAllString(raw, "Bearer [REDACTED]")
	return openAIKeyPattern.ReplaceAllString(redacted, "sk-[REDACTED]")
}

func sanitizeUpstreamErrorText(raw string, maxLength int) string {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return ""
	}
	if maxLength < 64 {
		maxLength = 64
	}
	redacted := redactSensitiveText(trimmed)
	if len([]rune(redacted)) <= maxLength {
		return redacted
	}
	runes := []rune(redacted)
	return string(runes[:maxLength]) + "…"
}

func containsAny(input string, candidates []string) bool {
	for _, candidate := range candidates {
		if strings.Contains(input, candidate) {
			return true
		}
	}
	return false
}

// detectCompatibilityIssue is the port of detectOpenAiCompatibilityIssue for
// the error classes the classifier chains can produce.
func detectCompatibilityIssue(status int, errorText string, surface APISurface) *CompatibilityError {
	sanitized := sanitizeUpstreamErrorText(errorText, 500)
	if sanitized == "" {
		return nil
	}
	lower := strings.ToLower(sanitized)
	hasUnsupportedCue := containsAny(lower, []string{
		"unsupported", "not supported", "not allowed", "not permitted", "unrecognized",
		"unknown", "extra fields", "additional properties", "unexpected field", "unexpected parameter",
	})
	hasInvalidArgumentCue := containsAny(lower, []string{
		"invalid request argument", "invalid argument", "invalid parameter",
	})
	hasResponsesReference := containsAny(lower, []string{"/v1/responses", "/responses", "responses api", "responses endpoint"})
	hasResponsesUnsupported := status == 501 || containsAny(lower, []string{
		"method not allowed", "not implemented", "does not support responses",
		"responses is not supported", "route not found", "unknown route", "unknown path",
		"no route", "endpoint not found", "not found",
	})
	if (status == 400 || status == 404 || status == 405 || status == 501) &&
		surface == APISurfaceResponses && hasResponsesReference && hasResponsesUnsupported {
		return &CompatibilityError{
			Code: "RESPONSES_API_UNSUPPORTED", IncompatibleField: "apiSurface",
			Hint:            "Upstream gateway does not support Responses API. Use chat/completions for this profile.",
			UpstreamMessage: sanitized, Status: status,
		}
	}
	if status != 0 && status != 400 && status != 404 && status != 405 && status != 422 && status != 501 {
		return nil
	}
	if strings.Contains(lower, "metadata") && (hasUnsupportedCue || hasInvalidArgumentCue) {
		return &CompatibilityError{
			Code: "UNSUPPORTED_METADATA", IncompatibleField: "metadata",
			Hint:            "Remove metadata from request or switch to a gateway/provider that supports metadata forwarding.",
			UpstreamMessage: sanitized, Status: status,
		}
	}
	if (strings.Contains(lower, "json_schema") || strings.Contains(lower, "json schema") || strings.Contains(lower, "structured output")) &&
		(hasUnsupportedCue || hasInvalidArgumentCue) {
		return &CompatibilityError{
			Code: "UNSUPPORTED_JSON_SCHEMA", IncompatibleField: "response_format.json_schema",
			Hint:            "This gateway does not support JSON schema structured outputs. Use json_object or plain text.",
			UpstreamMessage: sanitized, Status: status,
		}
	}
	if (strings.Contains(lower, "response_format") || strings.Contains(lower, "response format")) &&
		(hasUnsupportedCue || hasInvalidArgumentCue) {
		return &CompatibilityError{
			Code: "UNSUPPORTED_RESPONSE_FORMAT", IncompatibleField: "response_format",
			Hint:            "This gateway does not support response_format on this endpoint/model.",
			UpstreamMessage: sanitized, Status: status,
		}
	}
	if (strings.Contains(lower, "messages") || strings.Contains(lower, "message")) &&
		strings.Contains(lower, "content") &&
		(hasUnsupportedCue || hasInvalidArgumentCue || strings.Contains(lower, "invalid") || strings.Contains(lower, "must be")) {
		return &CompatibilityError{
			Code: "INVALID_MESSAGE_CONTENT", IncompatibleField: "messages[].content",
			Hint:            "Normalize message content to the OpenAI-compatible text format required by the upstream gateway.",
			UpstreamMessage: sanitized, Status: status,
		}
	}
	return nil
}

// guardrailViolationFromStatus reproduces maybeConvertAxiosErrorToGuardrailViolation.
func guardrailViolationFromStatus(status int, detail string, requested []string, applied []string) *GuardrailViolationError {
	lower := strings.ToLower(detail)
	isDefinite := strings.Contains(lower, "violated guardrail") ||
		strings.Contains(lower, "guardrail_intervened") ||
		(strings.Contains(lower, "guardrail") && (strings.Contains(lower, "policy") || strings.Contains(lower, "blocked") || strings.Contains(lower, "reject")))
	isInjection := strings.Contains(lower, "prompt injection") || strings.Contains(lower, "promptinjection") || strings.Contains(lower, "jailbreak")
	isTrustSafety := (strings.Contains(lower, "trust") && strings.Contains(lower, "safety") && strings.Contains(lower, "violation")) ||
		strings.Contains(lower, "trust & safety violation")
	isModeration := strings.Contains(lower, "moderation") &&
		(strings.Contains(lower, "flag") || strings.Contains(lower, "blocked") || strings.Contains(lower, "violate"))
	looksLike := isDefinite || isInjection || isTrustSafety || isModeration
	requestedClientError := len(requested) > 0 && (status == 400 || status == 403 || status == 422)
	shouldConvert := len(applied) > 0 || requestedClientError || (status != 0 && looksLike)
	if !shouldConvert {
		return nil
	}
	message, code := buildUserFacingGuardrailMessage(detail)
	return &GuardrailViolationError{
		Message: message, Code: code, UpstreamStatus: status, AppliedGuardrails: applied,
	}
}

func buildUserFacingGuardrailMessage(detail string) (string, string) {
	raw := strings.TrimSpace(detail)
	lower := strings.ToLower(raw)
	if strings.Contains(lower, "guardrail") && (strings.Contains(lower, "not found") || strings.Contains(lower, "unknown")) {
		return "AI safety checks are misconfigured (guardrail not found). Please contact an administrator.", "GUARDRAIL_MISCONFIG"
	}
	if strings.Contains(lower, "prompt injection") || strings.Contains(lower, "promptinjection") || strings.Contains(lower, "jailbreak") {
		return "Unable to complete request: prompt injection/jailbreak detected.", "PROMPT_INJECTION"
	}
	if strings.Contains(lower, "trust") && strings.Contains(lower, "safety") && strings.Contains(lower, "violation") {
		return "Unable to complete request: trust & safety violation detected.", "TRUST_SAFETY_VIOLATION"
	}
	if strings.Contains(lower, "language") && strings.Contains(lower, "violation") {
		return "Unable to complete request: language policy violation detected.", "LANGUAGE_POLICY_VIOLATION"
	}
	if strings.Contains(lower, "moderation") {
		return "Unable to complete request: blocked by content moderation.", "MODERATION_BLOCKED"
	}
	if strings.Contains(lower, "guardrail") {
		return "Unable to complete request: blocked by content safety guardrails.", "GUARDRAIL_BLOCKED"
	}
	return "Unable to complete request: blocked by content safety policy.", "GUARDRAIL_BLOCKED"
}

func isGuardrailViolation(err error) bool {
	var target *GuardrailViolationError
	return errors.As(err, &target)
}

func isCompatibilityError(err error) bool {
	var target *CompatibilityError
	return errors.As(err, &target)
}

package authfactors

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"strings"
)

// This file decodes the two request bodies this unit accepts and reproduces the
// global ValidationPipe behaviour the NestJS controllers rely on:
//
//   - `whitelist` + `forbidNonWhitelisted`: an undeclared member produces
//     "property <name> should not exist" before any per-property message;
//   - `transform` without implicit conversion: a number is never coerced into a
//     string, and a string is never coerced into a boolean;
//   - class-validator metadata order: the decorator written last in the source
//     is evaluated first, and `@IsOptional()` short-circuits every other
//     decorator on the property when the value is absent or null.
//
// Nothing here carries business data through an untyped container: every
// decoder fills a named struct.

// verifyMfaCodeRequest is the VerifyMfaCodeDto mirror: `code` is required, must
// be a string and must be at least six characters long. There is deliberately
// no maximum length and no numeric pattern.
type verifyMfaCodeRequest struct {
	Code string
}

// oidcConfigRequest is the OidcConfigDto mirror. Scopes keeps the raw array
// elements so the service can filter non-string entries instead of rejecting
// the whole request, exactly like the NestJS service does.
type oidcConfigRequest struct {
	Enabled              bool
	IssuerURL            string
	DiscoveryURL         *string
	ClientID             string
	ClientSecret         *string
	Scopes               []json.RawMessage
	ButtonLabel          *string
	RequireEmailVerified *bool
}

// fieldSetterFunc receives one top-level JSON member. It reports whether the
// member name is a declared DTO property.
type fieldSetterFunc func(name string, value json.RawMessage) bool

// setField implements the strictObjectTarget contract.
func (f fieldSetterFunc) setField(name string, value json.RawMessage) bool {
	return f(name, value)
}

// errInvalidBody reports a body that is not a JSON object at all.
var errInvalidBody = &httpError{status: http.StatusBadRequest, message: "Invalid request body"}

// decodeObject streams a JSON object body and feeds each member to the target,
// returning the undeclared member names in body order. A JSON null body is
// treated as an empty object, exactly like ValidationPipe.toEmptyIfNil.
func decodeObject(body []byte, target fieldSetterFunc) ([]string, error) {
	decoder := json.NewDecoder(bytes.NewReader(body))
	token, err := decoder.Token()
	if err != nil {
		return nil, errInvalidBody
	}
	if token == nil {
		return nil, nil
	}
	delim, ok := token.(json.Delim)
	if !ok || delim != '{' {
		return nil, errInvalidBody
	}
	var unknown []string
	for decoder.More() {
		keyToken, err := decoder.Token()
		if err != nil {
			return nil, errInvalidBody
		}
		name, ok := keyToken.(string)
		if !ok {
			return nil, errInvalidBody
		}
		var raw json.RawMessage
		if err := decoder.Decode(&raw); err != nil {
			return nil, errInvalidBody
		}
		if !target.setField(name, raw) {
			unknown = append(unknown, name)
		}
	}
	if _, err := decoder.Token(); err != nil {
		return nil, errInvalidBody
	}
	return unknown, nil
}

// present reports whether a decoded field holds any JSON at all. An absent key
// leaves json.RawMessage nil; `null` is present with the four bytes "null".
func present(raw json.RawMessage) bool {
	return len(bytes.TrimSpace(raw)) > 0
}

// isNull reports whether the field holds the JSON literal null.
func isNull(raw json.RawMessage) bool {
	return bytes.Equal(bytes.TrimSpace(raw), []byte("null"))
}

// skippedOptional reports whether @IsOptional() short-circuits every decorator
// on the property (absent or null).
func skippedOptional(raw json.RawMessage) bool {
	return !present(raw) || isNull(raw)
}

// rawJSONString reports whether the raw value is a JSON string, returning it.
func rawJSONString(raw json.RawMessage) (string, bool) {
	if skippedOptional(raw) {
		return "", false
	}
	trimmed := bytes.TrimSpace(raw)
	if trimmed[0] != '"' {
		return "", false
	}
	var text string
	if err := json.Unmarshal(trimmed, &text); err != nil {
		return "", false
	}
	return text, true
}

// rawJSONBool reports whether the raw value is exactly the JSON literal true or
// false. A string "true" is not a boolean.
func rawJSONBool(raw json.RawMessage) (bool, bool) {
	if skippedOptional(raw) {
		return false, false
	}
	trimmed := bytes.TrimSpace(raw)
	if bytes.Equal(trimmed, []byte("true")) {
		return true, true
	}
	if bytes.Equal(trimmed, []byte("false")) {
		return false, true
	}
	return false, false
}

// stringConstraint validates @IsString and appends its default message.
func stringConstraint(problems *validationErrors, raw json.RawMessage, field string, required bool) (string, bool) {
	if skippedOptional(raw) {
		if required {
			problems.add(field + " must be a string")
		}
		return "", false
	}
	text, ok := rawJSONString(raw)
	if !ok {
		problems.add(field + " must be a string")
		return "", false
	}
	return text, true
}

// boolConstraint validates @IsBoolean and appends its default message.
func boolConstraint(problems *validationErrors, raw json.RawMessage, field string, required bool) (bool, bool) {
	if skippedOptional(raw) {
		if required {
			problems.add(field + " must be a boolean value")
		}
		return false, false
	}
	value, ok := rawJSONBool(raw)
	if !ok {
		problems.add(field + " must be a boolean value")
		return false, false
	}
	return value, true
}

// minLengthConstraint validates @MinLength on a code point count.
func minLengthConstraint(problems *validationErrors, raw json.RawMessage, field string, min int) bool {
	text, ok := rawJSONString(raw)
	if !ok || len([]rune(text)) < min {
		problems.add(fmt.Sprintf("%s must be longer than or equal to %d characters", field, min))
		return false
	}
	return true
}

// parseVerifyMfaCodeRequest decodes and validates one VerifyMfaCodeDto body.
//
// Decorator order: @MinLength is registered after @IsString, so it is evaluated
// first and its message is appended first.
func parseVerifyMfaCodeRequest(body []byte) (verifyMfaCodeRequest, error) {
	var request verifyMfaCodeRequest
	var codeRaw json.RawMessage
	unknown, err := decodeObject(body, func(name string, value json.RawMessage) bool {
		if name != "code" {
			return false
		}
		codeRaw = value
		return true
	})
	if err != nil {
		return request, err
	}

	var problems validationErrors
	for _, name := range unknown {
		problems.add("property " + name + " should not exist")
	}
	minLengthConstraint(&problems, codeRaw, "code", 6)
	code, ok := stringConstraint(&problems, codeRaw, "code", true)
	if err := problems.err(); err != nil {
		return request, err
	}
	if !ok {
		return request, &httpError{status: http.StatusBadRequest, message: "code must be a string"}
	}
	request.Code = code
	return request, nil
}

// parseOidcConfigRequest decodes and validates one OidcConfigDto body.
//
// Properties are evaluated in declaration order. Optional properties accept an
// absent or null value; anything else must satisfy its own decorator. Scopes
// has no @IsString({ each: true }), so a mixed array is accepted here and
// filtered by the service.
func parseOidcConfigRequest(body []byte) (oidcConfigRequest, error) {
	var request oidcConfigRequest
	var (
		enabledRaw      json.RawMessage
		issuerRaw       json.RawMessage
		discoveryRaw    json.RawMessage
		clientIDRaw     json.RawMessage
		clientSecretRaw json.RawMessage
		scopesRaw       json.RawMessage
		buttonLabelRaw  json.RawMessage
		requireEmailRaw json.RawMessage
	)
	unknown, err := decodeObject(body, func(name string, value json.RawMessage) bool {
		switch name {
		case "enabled":
			enabledRaw = value
		case "issuerUrl":
			issuerRaw = value
		case "discoveryUrl":
			discoveryRaw = value
		case "clientId":
			clientIDRaw = value
		case "clientSecret":
			clientSecretRaw = value
		case "scopes":
			scopesRaw = value
		case "buttonLabel":
			buttonLabelRaw = value
		case "requireEmailVerified":
			requireEmailRaw = value
		default:
			return false
		}
		return true
	})
	if err != nil {
		return request, err
	}

	var problems validationErrors
	for _, name := range unknown {
		problems.add("property " + name + " should not exist")
	}

	enabled, enabledOK := boolConstraint(&problems, enabledRaw, "enabled", true)
	issuerURL, _ := stringConstraint(&problems, issuerRaw, "issuerUrl", true)

	var discoveryURL *string
	if !skippedOptional(discoveryRaw) {
		if text, ok := stringConstraint(&problems, discoveryRaw, "discoveryUrl", false); ok {
			discoveryURL = &text
		}
	}

	clientID, _ := stringConstraint(&problems, clientIDRaw, "clientId", true)

	var clientSecret *string
	if !skippedOptional(clientSecretRaw) {
		if text, ok := stringConstraint(&problems, clientSecretRaw, "clientSecret", false); ok {
			clientSecret = &text
		}
	}

	var scopes []json.RawMessage
	if !skippedOptional(scopesRaw) {
		if trimmed := bytes.TrimSpace(scopesRaw); trimmed[0] != '[' {
			problems.add("scopes must be an array")
		} else if err := json.Unmarshal(trimmed, &scopes); err != nil {
			problems.add("scopes must be an array")
		}
	}

	var buttonLabel *string
	if !skippedOptional(buttonLabelRaw) {
		if text, ok := stringConstraint(&problems, buttonLabelRaw, "buttonLabel", false); ok {
			buttonLabel = &text
		}
	}

	var requireEmailVerified *bool
	if !skippedOptional(requireEmailRaw) {
		if value, ok := boolConstraint(&problems, requireEmailRaw, "requireEmailVerified", false); ok {
			requireEmailVerified = &value
		}
	}

	if err := problems.err(); err != nil {
		return request, err
	}
	if !enabledOK {
		return request, &httpError{status: http.StatusBadRequest, message: "enabled must be a boolean value"}
	}

	request.Enabled = enabled
	request.IssuerURL = issuerURL
	request.DiscoveryURL = discoveryURL
	request.ClientID = clientID
	request.ClientSecret = clientSecret
	request.Scopes = scopes
	request.ButtonLabel = buttonLabel
	request.RequireEmailVerified = requireEmailVerified
	return request, nil
}

// bodyKind classifies the raw body the way Express body-parser does.
type bodyKind int

const (
	// bodyAbsent means the content type was not JSON; NestJS validates an empty
	// object in that case.
	bodyAbsent bodyKind = iota
	// bodyOK means the body decoded as JSON.
	bodyOK
	// bodyInvalidJSON means the body was not valid JSON.
	bodyInvalidJSON
	// bodyTooLarge means the body exceeded the configured limit.
	bodyTooLarge
)

// maxBodyBytes mirrors apps/api/src/main.ts json({limit:"10mb"}).
const maxBodyBytes = 10 << 20

// readRequestBody reads a JSON body with a hard size limit.
func readRequestBody(r *http.Request) ([]byte, bodyKind) {
	if !isJSONContentType(r.Header.Get("Content-Type")) {
		return nil, bodyAbsent
	}
	limited := http.MaxBytesReader(nil, r.Body, maxBodyBytes)
	defer limited.Close()
	data, err := io.ReadAll(limited)
	if err != nil {
		var maxBytes *http.MaxBytesError
		if errors.As(err, &maxBytes) {
			return nil, bodyTooLarge
		}
		return data, bodyInvalidJSON
	}
	trimmed := bytes.TrimSpace(data)
	if len(trimmed) == 0 || !json.Valid(trimmed) {
		return data, bodyInvalidJSON
	}
	return data, bodyOK
}

// isJSONContentType reports whether the header selects the JSON body parser.
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

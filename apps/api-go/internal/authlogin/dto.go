package authlogin

import (
	"bytes"
	"encoding/json"
	"net/http"
	"regexp"
	"strings"
)

// This file reproduces the global ValidationPipe (whitelist + forbidNonWhitelisted
// + transform) for the eleven request DTOs. The messages, their order and the
// treatment of absent / null / empty members are the contract: a client that
// switches between Go and NestJS must not be able to observe which one answered.
//
// Ordering rule copied from the existing ports: a property's decorators are
// registered bottom-up, so the last-declared decorator is evaluated (and reports)
// first. Properties themselves follow declaration order, and unknown members are
// reported before any field problem.

// validationErrors accumulates class-validator style messages.
type validationErrors struct {
	messages []string
}

func (v *validationErrors) add(message string) { v.messages = append(v.messages, message) }

func (v *validationErrors) empty() bool { return len(v.messages) == 0 }

func (v *validationErrors) err() error {
	if v.empty() {
		return nil
	}
	return badRequest(joinValidationMessages(v.messages))
}

func joinValidationMessages(messages []string) string {
	return strings.Join(messages, "; ")
}

// errInvalidBody reports a body that is not a JSON object at all. NestJS maps a
// malformed body onto the same BadRequestException shape.
var errInvalidBody = &httpError{status: http.StatusBadRequest, message: "Invalid request body"}

// decodeObject streams a JSON object body and feeds each member to the target,
// returning the undeclared member names in body order. A JSON null body is
// treated as an empty object, exactly like ValidationPipe.toEmptyIfNil.
func decodeObject(body []byte, target func(name string, value json.RawMessage) bool) ([]string, error) {
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
		if !target(name, raw) {
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
func present(raw json.RawMessage) bool { return len(bytes.TrimSpace(raw)) > 0 }

func isNull(raw json.RawMessage) bool {
	return bytes.Equal(bytes.TrimSpace(raw), []byte("null"))
}

// skippedOptional reports whether @IsOptional() short-circuits every decorator on
// the property (absent or null).
func skippedOptional(raw json.RawMessage) bool { return !present(raw) || isNull(raw) }

// decodeJSONString decodes a JSON string member. A non-string member reports
// ok=false without an error; the callers add the class-validator message.
func decodeJSONString(raw json.RawMessage) (string, bool) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || trimmed[0] != '"' {
		return "", false
	}
	var text string
	if err := json.Unmarshal(trimmed, &text); err != nil {
		return "", false
	}
	return text, true
}

// stringConstraint validates @IsString and appends its default message.
func stringConstraint(v *validationErrors, raw json.RawMessage, field string) (string, bool) {
	text, ok := decodeJSONString(raw)
	if !ok {
		v.add(field + " must be a string")
		return "", false
	}
	return text, true
}

// minLengthConstraint validates @MinLength on a code point count. class-validator
// guards the call with `typeof value === "string"`, so a non-string fails here
// too without ever reaching validator.js.
func minLengthConstraint(v *validationErrors, raw json.RawMessage, field string, min int) bool {
	text, ok := decodeJSONString(raw)
	if !ok || len([]rune(text)) < min {
		v.add(field + " must be longer than or equal to " + itoa(min) + " characters")
		return false
	}
	return true
}

// matchesDigitsConstraint validates @Matches(/^\d{8}$/) on the raw string.
func matchesDigitsConstraint(v *validationErrors, raw json.RawMessage, field string) (string, bool) {
	text, ok := decodeJSONString(raw)
	if !ok || !emailCodeDigitsRe.MatchString(text) {
		v.add(field + " must match /^\\d{8}$/ regular expression")
		return "", false
	}
	return text, true
}

// emailConstraint validates @IsEmail and appends its default message.
func emailConstraint(v *validationErrors, raw json.RawMessage, field string) (string, bool) {
	text, ok := decodeJSONString(raw)
	if !ok || !validatorIsEmail(text) {
		v.add(field + " must be an email")
		return "", false
	}
	return text, true
}

// optionalStringConstraint validates @IsOptional() @IsString(). The returned
// pointer distinguishes an absent/null member (nil) from an explicit empty string
// (non-nil, ""), which refresh depends on.
func optionalStringConstraint(v *validationErrors, raw json.RawMessage, field string) (*string, bool) {
	if skippedOptional(raw) {
		return nil, true
	}
	text, ok := decodeJSONString(raw)
	if !ok {
		v.add(field + " must be a string")
		return nil, false
	}
	return &text, true
}

var emailCodeDigitsRe = regexp.MustCompile(`^\d{8}$`)

// ---- LoginDto ----

// loginRequest is the validated POST /api/auth/login body.
type loginRequest struct {
	Email    string
	Password string
	OrgID    *string
}

func parseLoginRequest(body []byte) (loginRequest, error) {
	var request loginRequest
	var emailRaw, passwordRaw, orgRaw json.RawMessage
	unknown, err := decodeObject(body, func(name string, value json.RawMessage) bool {
		switch name {
		case "email":
			emailRaw = value
		case "password":
			passwordRaw = value
		case "orgId":
			orgRaw = value
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
	email, _ := emailConstraint(&problems, emailRaw, "email")
	minLengthConstraint(&problems, passwordRaw, "password", minPasswordLength)
	password, _ := stringConstraint(&problems, passwordRaw, "password")
	orgID, _ := optionalStringConstraint(&problems, orgRaw, "orgId")
	if err := problems.err(); err != nil {
		return request, err
	}
	request.Email = email
	request.Password = password
	request.OrgID = orgID
	return request, nil
}

// ---- RefreshDto ----

type refreshRequest struct {
	RefreshToken string
	OrgID        *string
}

func parseRefreshRequest(body []byte) (refreshRequest, error) {
	var request refreshRequest
	var tokenRaw, orgRaw json.RawMessage
	unknown, err := decodeObject(body, func(name string, value json.RawMessage) bool {
		switch name {
		case "refreshToken":
			tokenRaw = value
		case "orgId":
			orgRaw = value
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
	minLengthConstraint(&problems, tokenRaw, "refreshToken", minRefreshTokenLength)
	token, _ := stringConstraint(&problems, tokenRaw, "refreshToken")
	orgID, _ := optionalStringConstraint(&problems, orgRaw, "orgId")
	if err := problems.err(); err != nil {
		return request, err
	}
	request.RefreshToken = token
	request.OrgID = orgID
	return request, nil
}

// ---- SendLoginCodeDto / SendVerificationDto / RequestPasswordResetDto ----

// emailOnlyRequest is the validated body of the three single-email DTOs.
type emailOnlyRequest struct {
	Email string
}

func parseEmailOnlyRequest(body []byte) (emailOnlyRequest, error) {
	var request emailOnlyRequest
	var emailRaw json.RawMessage
	unknown, err := decodeObject(body, func(name string, value json.RawMessage) bool {
		if name != "email" {
			return false
		}
		emailRaw = value
		return true
	})
	if err != nil {
		return request, err
	}
	var problems validationErrors
	for _, name := range unknown {
		problems.add("property " + name + " should not exist")
	}
	email, _ := emailConstraint(&problems, emailRaw, "email")
	if err := problems.err(); err != nil {
		return request, err
	}
	request.Email = email
	return request, nil
}

// ---- LoginWithCodeDto ----

type loginWithCodeRequest struct {
	Email string
	Code  string
	OrgID *string
}

func parseLoginWithCodeRequest(body []byte) (loginWithCodeRequest, error) {
	var request loginWithCodeRequest
	var emailRaw, codeRaw, orgRaw json.RawMessage
	unknown, err := decodeObject(body, func(name string, value json.RawMessage) bool {
		switch name {
		case "email":
			emailRaw = value
		case "code":
			codeRaw = value
		case "orgId":
			orgRaw = value
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
	email, _ := emailConstraint(&problems, emailRaw, "email")
	code, _ := matchesDigitsConstraint(&problems, codeRaw, "code")
	stringConstraint(&problems, codeRaw, "code")
	orgID, _ := optionalStringConstraint(&problems, orgRaw, "orgId")
	if err := problems.err(); err != nil {
		return request, err
	}
	request.Email = email
	request.Code = code
	request.OrgID = orgID
	return request, nil
}

// ---- VerifyEmailDto ----

type verifyEmailRequest struct {
	Code string
}

func parseVerifyEmailRequest(body []byte) (verifyEmailRequest, error) {
	var request verifyEmailRequest
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
	code, _ := matchesDigitsConstraint(&problems, codeRaw, "code")
	stringConstraint(&problems, codeRaw, "code")
	if err := problems.err(); err != nil {
		return request, err
	}
	request.Code = code
	return request, nil
}

// ---- ResetPasswordDto ----

type resetPasswordRequest struct {
	Token    string
	Password string
}

func parseResetPasswordRequest(body []byte) (resetPasswordRequest, error) {
	var request resetPasswordRequest
	var tokenRaw, passwordRaw json.RawMessage
	unknown, err := decodeObject(body, func(name string, value json.RawMessage) bool {
		switch name {
		case "token":
			tokenRaw = value
		case "password":
			passwordRaw = value
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
	token, _ := stringConstraint(&problems, tokenRaw, "token")
	minLengthConstraint(&problems, passwordRaw, "password", minPasswordLength)
	password, _ := stringConstraint(&problems, passwordRaw, "password")
	if err := problems.err(); err != nil {
		return request, err
	}
	request.Token = token
	request.Password = password
	return request, nil
}

// ---- MFA DTOs ----

// mfaCodeRequest is the shared base of CompleteMfaLoginDto and
// CompleteMfaEnrollmentChallengeDto (VerifyMfaCodeDto plus challengeId). The
// inherited `code` property keeps its inherited order, so its messages are
// reported before challengeId's.
type mfaCodeRequest struct {
	Code        string
	ChallengeID string
}

func parseMfaCodeRequest(body []byte) (mfaCodeRequest, error) {
	var request mfaCodeRequest
	var codeRaw, challengeRaw json.RawMessage
	unknown, err := decodeObject(body, func(name string, value json.RawMessage) bool {
		switch name {
		case "code":
			codeRaw = value
		case "challengeId":
			challengeRaw = value
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
	minLengthConstraint(&problems, codeRaw, "code", 6)
	code, _ := stringConstraint(&problems, codeRaw, "code")
	challengeID, _ := stringConstraint(&problems, challengeRaw, "challengeId")
	if err := problems.err(); err != nil {
		return request, err
	}
	request.Code = code
	request.ChallengeID = challengeID
	return request, nil
}

// mfaEnrollmentStartRequest is BeginMfaEnrollmentChallengeDto: challengeId only.
type mfaEnrollmentStartRequest struct {
	ChallengeID string
}

func parseMfaEnrollmentStartRequest(body []byte) (mfaEnrollmentStartRequest, error) {
	var request mfaEnrollmentStartRequest
	var challengeRaw json.RawMessage
	unknown, err := decodeObject(body, func(name string, value json.RawMessage) bool {
		if name != "challengeId" {
			return false
		}
		challengeRaw = value
		return true
	})
	if err != nil {
		return request, err
	}
	var problems validationErrors
	for _, name := range unknown {
		problems.add("property " + name + " should not exist")
	}
	challengeID, _ := stringConstraint(&problems, challengeRaw, "challengeId")
	if err := problems.err(); err != nil {
		return request, err
	}
	request.ChallengeID = challengeID
	return request, nil
}

// ---- helpers ----

// itoa renders a small non-negative integer without pulling strconv into the
// message path.
func itoa(value int) string {
	if value == 0 {
		return "0"
	}
	digits := make([]byte, 0, 4)
	for value > 0 {
		digits = append([]byte{byte('0' + value%10)}, digits...)
		value /= 10
	}
	return string(digits)
}

// ---- validator.js isEmail port ----

// The following mirrors validator.js `isEmail` with the default options
// (require_tld=true, allow_utf8_local_part=true, allow_ip_domain=false,
// allow_display_name=false, ignore_max_length=false, domain_specific_validation
// =false). It is the same algorithm the data-runtime-settings batch already
// ported; it is duplicated here rather than exported from another migration
// unit, because each unit owns its own contract copy.
var (
	quotedEmailUserRe = regexp.MustCompile("(?i)^([\\s\\x01-\\x08\\x0b\\x0c\\x0e-\\x1f\\x7f\\x21-\\x5b\\x5d-\\x7e\\x{00A0}-\\x{D7FF}\\x{F900}-\\x{FDCF}\\x{FDF0}-\\x{FFEF}]|(\\\\[\\x01-\\x09\\x0b\\x0c\\x0d-\\x7f\\x{00A0}-\\x{D7FF}\\x{F900}-\\x{FDCF}\\x{FDF0}-\\x{FFEF}]))*$")
	emailUserUTF8Part = regexp.MustCompile("(?i)^[a-z\\d!#$%&'*+\\-/=?^_`{|}~\\x{00A1}-\\x{D7FF}\\x{F900}-\\x{FDCF}\\x{FDF0}-\\x{FFEF}]+$")
	fqdnTLDRe         = regexp.MustCompile("(?i)^([a-z\\x{00A1}-\\x{00A8}\\x{00AA}-\\x{D7FF}\\x{F900}-\\x{FDCF}\\x{FDF0}-\\x{FFEF}]{2,}|xn[a-z0-9-]{2,})$")
	fqdnPartRe        = regexp.MustCompile("(?i)^[a-z_\\x{00A1}-\\x{FFFF}0-9-]+$")
	fullWidthRe       = regexp.MustCompile("[\\x{FF01}-\\x{FF5E}]")
)

func validatorIsEmail(value string) bool {
	if len(value) > 254 {
		return false
	}
	at := strings.LastIndex(value, "@")
	if at < 0 {
		return validatorIsFQDN(value)
	}
	user := value[:at]
	domain := value[at+1:]
	if len(user) == 0 || len(user) > 64 {
		return false
	}
	if len(domain) == 0 || len(domain) > 254 {
		return false
	}
	if !validatorIsFQDN(domain) {
		return false
	}
	if strings.HasPrefix(user, `"`) && strings.HasSuffix(user, `"`) && len(user) >= 2 {
		return quotedEmailUserRe.MatchString(user[1 : len(user)-1])
	}
	for _, part := range strings.Split(user, ".") {
		if part == "" || !emailUserUTF8Part.MatchString(part) {
			return false
		}
	}
	return true
}

// validatorIsFQDN mirrors validator.js isFQDN with require_tld=true,
// allow_underscores=false, allow_numeric_tld=false, allow_trailing_dot=false.
func validatorIsFQDN(value string) bool {
	parts := strings.Split(value, ".")
	if len(parts) < 2 {
		return false
	}
	tld := parts[len(parts)-1]
	if !fqdnTLDRe.MatchString(tld) {
		return false
	}
	if strings.ContainsAny(tld, " \t\n\r\f\v") {
		return false
	}
	for _, part := range parts {
		if part == "" || len(part) > 63 {
			return false
		}
		if !fqdnPartRe.MatchString(part) {
			return false
		}
		if fullWidthRe.MatchString(part) {
			return false
		}
		if strings.HasPrefix(part, "-") || strings.HasSuffix(part, "-") {
			return false
		}
		if strings.Contains(part, "_") {
			return false
		}
	}
	return true
}

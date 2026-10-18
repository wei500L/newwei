package accountsecurity

import (
	"bytes"
	"encoding/json"
	"fmt"
	"strings"
	"time"
)

// This file reproduces the four DTO contracts after nest's global ValidationPipe
// (whitelist, forbidNonWhitelisted, forbidUnknownValues, transform). Nothing
// here coerces types or trims values: trimming is a service-layer rule.

// strictObjectTarget receives one top-level JSON member at a time. setField
// reports whether the member name is a declared DTO property; unknown members
// are collected by decodeStrictObject.
type strictObjectTarget interface {
	setField(name string, value json.RawMessage) bool
}

// decodeStrictObject streams a JSON object body and feeds each member to the
// target. It returns the undeclared member names in body order.
//
// A JSON null body is treated as an empty object, exactly like NestJS's
// ValidationPipe.toEmptyIfNil. Any non-object body is errInvalidBody.
func decodeStrictObject(body []byte, target strictObjectTarget) ([]string, error) {
	decoder := json.NewDecoder(bytes.NewReader(body))
	token, err := decoder.Token()
	if err != nil {
		return nil, errInvalidBody
	}
	if token == nil {
		// JSON null: NestJS replaces the value with {} before validation.
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

// whitelistMessages renders the forbidNonWhitelisted errors in body order.
func whitelistMessages(names []string) []string {
	if len(names) == 0 {
		return nil
	}
	messages := make([]string, 0, len(names))
	for _, name := range names {
		messages = append(messages, "property "+name+" should not exist")
	}
	return messages
}

// ---- PATCH /api/auth/profile ----

// updateProfileRequest mirrors UpdateProfileDto's declared members.
type updateProfileRequest struct {
	FirstName json.RawMessage
	LastName  json.RawMessage
	AvatarURL json.RawMessage
}

// setField implements strictObjectTarget.
func (r *updateProfileRequest) setField(name string, value json.RawMessage) bool {
	switch name {
	case "firstName":
		r.FirstName = value
	case "lastName":
		r.LastName = value
	case "avatarUrl":
		r.AvatarURL = value
	default:
		return false
	}
	return true
}

// parseUpdateProfileRequest validates the body with the DTO's decorator
// semantics. Defined properties are validated in class-validator's reverse
// metadata order (@MaxLength then @IsString; @MaxLength then @IsUrl then
// @IsString for avatarUrl); an explicit null is skipped by @IsOptional and is
// therefore handled by the service layer (AS3).
func parseUpdateProfileRequest(body []byte) (updateProfileRequest, error) {
	var dto updateProfileRequest
	unknown, err := decodeStrictObject(body, &dto)
	if err != nil {
		return updateProfileRequest{}, err
	}
	problems := validationErrors{}
	for _, message := range whitelistMessages(unknown) {
		problems.add(message)
	}
	stringMaxConstraint(&problems, dto.FirstName, "firstName", 80)
	stringMaxConstraint(&problems, dto.LastName, "lastName", 80)
	avatarURLConstraint(&problems, dto.AvatarURL)
	if err := problems.err(); err != nil {
		return updateProfileRequest{}, err
	}
	return dto, nil
}

// stringMaxConstraint validates @MaxLength then @IsString for an optional
// string field.
func stringMaxConstraint(v *validationErrors, raw json.RawMessage, field string, max int) {
	if skippedOptional(raw) {
		return
	}
	text, isString := jsonString(raw)
	if !isString || runeLength(text) > max {
		v.add(fmt.Sprintf("%s must be shorter than or equal to %d characters", field, max))
	}
	if !isString {
		v.add(field + " must be a string")
	}
}

// avatarURLConstraint validates @MaxLength(2048), @IsUrl({require_protocol:true})
// then @IsString for the optional avatar field.
func avatarURLConstraint(v *validationErrors, raw json.RawMessage) {
	if skippedOptional(raw) {
		return
	}
	text, isString := jsonString(raw)
	if !isString || runeLength(text) > 2048 {
		v.add("avatarUrl must be shorter than or equal to 2048 characters")
	}
	if !isString || !isURL(text) {
		v.add("avatarUrl must be a URL address")
	}
	if !isString {
		v.add("avatarUrl must be a string")
	}
}

// ---- POST /api/auth/change-password ----

// changePasswordRequest mirrors ChangePasswordDto.
type changePasswordRequest struct {
	CurrentPassword json.RawMessage
	NewPassword     json.RawMessage
}

// setField implements strictObjectTarget.
func (r *changePasswordRequest) setField(name string, value json.RawMessage) bool {
	switch name {
	case "currentPassword":
		r.CurrentPassword = value
	case "newPassword":
		r.NewPassword = value
	default:
		return false
	}
	return true
}

// parseChangePasswordRequest validates the required 8..256 character strings.
// Passwords are never trimmed and a JSON number is never coerced to a string.
func parseChangePasswordRequest(body []byte) (changePasswordRequest, error) {
	var dto changePasswordRequest
	unknown, err := decodeStrictObject(body, &dto)
	if err != nil {
		return changePasswordRequest{}, err
	}
	problems := validationErrors{}
	for _, message := range whitelistMessages(unknown) {
		problems.add(message)
	}
	stringMinMaxConstraint(&problems, dto.CurrentPassword, "currentPassword", 8, 256)
	stringMinMaxConstraint(&problems, dto.NewPassword, "newPassword", 8, 256)
	if err := problems.err(); err != nil {
		return changePasswordRequest{}, err
	}
	return dto, nil
}

// stringMinMaxConstraint validates a required @IsString/@MinLength/@MaxLength
// field in class-validator's reverse metadata order.
func stringMinMaxConstraint(v *validationErrors, raw json.RawMessage, field string, min, max int) {
	text, isString := jsonString(raw)
	if !isString || runeLength(text) > max {
		v.add(fmt.Sprintf("%s must be shorter than or equal to %d characters", field, max))
	}
	if !isString || runeLength(text) < min {
		v.add(fmt.Sprintf("%s must be longer than or equal to %d characters", field, min))
	}
	if !isString {
		v.add(field + " must be a string")
	}
}

// ---- POST /api/auth/logout ----

// logoutRequest mirrors LogoutDto. refreshToken and logoutAll are both optional.
type logoutRequest struct {
	RefreshToken json.RawMessage
	LogoutAll    json.RawMessage
}

// setField implements strictObjectTarget.
func (r *logoutRequest) setField(name string, value json.RawMessage) bool {
	switch name {
	case "refreshToken":
		r.RefreshToken = value
	case "logoutAll":
		r.LogoutAll = value
	default:
		return false
	}
	return true
}

// parseLogoutRequest validates the optional refreshToken (string, min 20) and
// logoutAll (boolean, never the string "true").
func parseLogoutRequest(body []byte) (logoutRequest, error) {
	var dto logoutRequest
	unknown, err := decodeStrictObject(body, &dto)
	if err != nil {
		return logoutRequest{}, err
	}
	problems := validationErrors{}
	for _, message := range whitelistMessages(unknown) {
		problems.add(message)
	}
	if !skippedOptional(dto.RefreshToken) {
		text, isString := jsonString(dto.RefreshToken)
		if !isString || runeLength(text) < 20 {
			problems.add("refreshToken must be longer than or equal to 20 characters")
		}
		if !isString {
			problems.add("refreshToken must be a string")
		}
	}
	if !skippedOptional(dto.LogoutAll) {
		trimmed := bytes.TrimSpace(dto.LogoutAll)
		if !bytes.Equal(trimmed, []byte("true")) && !bytes.Equal(trimmed, []byte("false")) {
			problems.add("logoutAll must be a boolean value")
		}
	}
	if err := problems.err(); err != nil {
		return logoutRequest{}, err
	}
	return dto, nil
}

// logoutValues extracts the service inputs after validation. The booleans
// distinguish "absent" from "explicitly false": NestJS passes `body?.logoutAll`
// which is undefined when absent.
func logoutValues(dto logoutRequest) (refreshToken *string, logoutAll bool) {
	if !skippedOptional(dto.RefreshToken) {
		if text, ok := jsonString(dto.RefreshToken); ok {
			refreshToken = &text
		}
	}
	if !skippedOptional(dto.LogoutAll) {
		logoutAll = bytes.Equal(bytes.TrimSpace(dto.LogoutAll), []byte("true"))
	}
	return refreshToken, logoutAll
}

// ---- POST /api/auth/machine-tokens ----

// createMachineTokenRequest mirrors CreateMachineTokenDto.
type createMachineTokenRequest struct {
	Name        json.RawMessage
	Permissions json.RawMessage
	ExpiresAt   json.RawMessage
}

// setField implements strictObjectTarget.
func (r *createMachineTokenRequest) setField(name string, value json.RawMessage) bool {
	switch name {
	case "name":
		r.Name = value
	case "permissions":
		r.Permissions = value
	case "expiresAt":
		r.ExpiresAt = value
	default:
		return false
	}
	return true
}

// createMachineTokenValues is the validated service input.
type createMachineTokenValues struct {
	Name        string
	Permissions []string
	ExpiresAt   *time.Time
}

// parseCreateMachineTokenRequest validates name (1..120), permissions (array of
// at most 20 strings; the non-empty check is a service rule) and the optional
// ISO 8601 expiresAt.
func parseCreateMachineTokenRequest(body []byte) (createMachineTokenValues, error) {
	var dto createMachineTokenRequest
	unknown, err := decodeStrictObject(body, &dto)
	if err != nil {
		return createMachineTokenValues{}, err
	}
	problems := validationErrors{}
	for _, message := range whitelistMessages(unknown) {
		problems.add(message)
	}

	name, nameOK := machineTokenNameConstraint(&problems, dto.Name)
	permissions, permissionsOK := machineTokenPermissionsConstraint(&problems, dto.Permissions)
	expiresAt, expiresOK := machineTokenExpiresAtConstraint(&problems, dto.ExpiresAt)
	if err := problems.err(); err != nil {
		return createMachineTokenValues{}, err
	}
	if !nameOK || !permissionsOK || !expiresOK {
		return createMachineTokenValues{}, badRequest("Invalid request body")
	}
	return createMachineTokenValues{Name: name, Permissions: permissions, ExpiresAt: expiresAt}, nil
}

// machineTokenNameConstraint validates @MaxLength(120)/@MinLength(1)/@IsString.
func machineTokenNameConstraint(v *validationErrors, raw json.RawMessage) (string, bool) {
	text, isString := jsonString(raw)
	ok := true
	if !isString || runeLength(text) > 120 {
		v.add("name must be shorter than or equal to 120 characters")
		ok = false
	}
	if !isString || runeLength(text) < 1 {
		v.add("name must be longer than or equal to 1 characters")
		ok = false
	}
	if !isString {
		v.add("name must be a string")
		ok = false
	}
	return text, ok
}

// machineTokenPermissionsConstraint validates the required array, its 20 element
// cap and the per-element string requirement. An empty array is allowed here:
// the create-time whitelist check lives in the service, exactly like NestJS.
func machineTokenPermissionsConstraint(v *validationErrors, raw json.RawMessage) ([]string, bool) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || trimmed[0] != '[' {
		v.add("permissions must be an array")
		return nil, false
	}
	var items []json.RawMessage
	if err := json.Unmarshal(trimmed, &items); err != nil {
		v.add("permissions must be an array")
		return nil, false
	}
	ok := true
	if len(items) > 20 {
		v.add("permissions must contain not more than 20 elements")
		ok = false
	}
	values := make([]string, 0, len(items))
	for _, item := range items {
		text, isString := jsonString(item)
		if !isString {
			v.add("each value in permissions must be a string")
			ok = false
			continue
		}
		values = append(values, text)
	}
	return values, ok
}

// machineTokenExpiresAtConstraint validates @IsDateString and converts the value
// to a millisecond-precision UTC instant.
func machineTokenExpiresAtConstraint(v *validationErrors, raw json.RawMessage) (*time.Time, bool) {
	if skippedOptional(raw) {
		return nil, true
	}
	text, isString := jsonString(raw)
	if !isString || !isISODateString(text) {
		v.add("expiresAt must be a valid ISO 8601 date string")
		return nil, false
	}
	parsed, err := parseISODateString(text)
	if err != nil {
		v.add("expiresAt must be a valid ISO 8601 date string")
		return nil, false
	}
	value := parsed.UTC().Truncate(time.Millisecond)
	return &value, true
}

// parseISODateString accepts the same extended ISO 8601 forms isISODateString
// validated. Fractional seconds are accepted even when the layout omits them,
// matching Go's time.Parse behaviour and JavaScript's Date parser.
func parseISODateString(value string) (time.Time, error) {
	layouts := []string{
		time.RFC3339Nano,
		time.RFC3339,
		"2006-01-02T15:04:05",
		"2006-01-02T15:04",
		"2006-01-02 15:04:05",
		"2006-01-02 15:04",
		"2006-01-02",
	}
	var lastErr error
	for _, layout := range layouts {
		parsed, err := time.Parse(layout, value)
		if err == nil {
			return parsed, nil
		}
		lastErr = err
	}
	return time.Time{}, lastErr
}

// normalizePermissions applies the create-time whitelist: every entry is
// trimmed, unsupported entries are dropped, duplicates keep their first
// occurrence and order is preserved.
func normalizePermissions(permissions []string) []string {
	allowed := map[string]bool{"metrics.read": true}
	seen := map[string]bool{}
	out := make([]string, 0, len(permissions))
	for _, permission := range permissions {
		trimmed := strings.TrimSpace(permission)
		if !allowed[trimmed] || seen[trimmed] {
			continue
		}
		seen[trimmed] = true
		out = append(out, trimmed)
	}
	return out
}

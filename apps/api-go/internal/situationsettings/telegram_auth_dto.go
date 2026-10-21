package situationsettings

import (
	"encoding/json"
	"regexp"
)

// This file validates the two telegram-auth request bodies exactly like the
// global ValidationPipe (whitelist, forbidNonWhitelisted, transform) does for
// StartSituationMonitorTelegramAuthDto and
// CompleteSituationMonitorTelegramAuthDto
// (apps/api/src/modules/system-settings/dto/situation-monitor-telegram-auth.dto.ts,
// global pipe config in apps/api/src/main.ts line 69).
//
// The collection order is the one documented in dto.go: unknown-property errors
// in body key order first (ValidationPipe with forbidNonWhitelisted), then the
// declared properties in DTO order, and within one property the constraints in
// reverse decorator order (class-validator registers them bottom-up).
//
// A phoneNumber that is not a string fails both @Matches and @IsString, so the
// joined message is "TELEGRAM_AUTH_PHONE_FORMAT_INVALID; phoneNumber must be a
// string"; a missing phoneNumber produces the same pair because @IsString is
// required (no @IsOptional).

// telegramAuthE164PhonePattern is E164_PHONE_NUMBER_PATTERN from the NestJS DTO
// and service (both use /^\+[1-9]\d{6,14}$/).
var telegramAuthE164PhonePattern = regexp.MustCompile(`^\+[1-9]\d{6,14}$`)

// telegramAuthStartAllowedFields is the Start DTO whitelist.
var telegramAuthStartAllowedFields = map[string]bool{
	"telegramApiId":   true,
	"telegramApiHash": true,
	"phoneNumber":     true,
}

// telegramAuthCompleteAllowedFields is the Complete DTO whitelist.
var telegramAuthCompleteAllowedFields = map[string]bool{
	"requestId":      true,
	"phoneCode":      true,
	"password":       true,
	"enableTelegram": true,
}

// StartTelegramAuthInput is the validated Start DTO body. The two credential
// members keep their tri-state so the service can apply
// `input.telegramApiId ?? stored.telegramApiId` exactly (absent and null both
// fall back to the stored value; NestJS normalizeString(null) is undefined).
type StartTelegramAuthInput struct {
	TelegramAPIID   optionalString
	TelegramAPIHash optionalString
	PhoneNumber     string
}

// CompleteTelegramAuthInput is the validated Complete DTO body. Password and
// EnableTelegram keep the tri-state because NestJS distinguishes absent/null
// from a concrete value.
type CompleteTelegramAuthInput struct {
	RequestID      string
	PhoneCode      string
	Password       optionalString
	EnableTelegram optionalBool
}

// parseStartTelegramAuth validates a Start body with ValidationPipe semantics.
func parseStartTelegramAuth(body []byte) (StartTelegramAuthInput, error) {
	members, err := decodeBodyMembers(body)
	if err != nil {
		return StartTelegramAuthInput{}, err
	}
	var v validationErrors
	rejectUnknown(&v, members, telegramAuthStartAllowedFields)

	var input StartTelegramAuthInput
	input.TelegramAPIID = optionalStringField(&v, members.last("telegramApiId"), "telegramApiId")
	input.TelegramAPIHash = optionalStringField(&v, members.last("telegramApiHash"), "telegramApiHash")
	input.PhoneNumber = requiredE164PhoneField(&v, members.last("phoneNumber"), "phoneNumber")

	if err := v.err(); err != nil {
		return StartTelegramAuthInput{}, err
	}
	return input, nil
}

// parseCompleteTelegramAuth validates a Complete body with ValidationPipe
// semantics.
func parseCompleteTelegramAuth(body []byte) (CompleteTelegramAuthInput, error) {
	members, err := decodeBodyMembers(body)
	if err != nil {
		return CompleteTelegramAuthInput{}, err
	}
	var v validationErrors
	rejectUnknown(&v, members, telegramAuthCompleteAllowedFields)

	var input CompleteTelegramAuthInput
	input.RequestID = requiredStringField(&v, members.last("requestId"), "requestId")
	input.PhoneCode = requiredStringField(&v, members.last("phoneCode"), "phoneCode")
	input.Password = optionalStringField(&v, members.last("password"), "password")
	input.EnableTelegram = optionalBoolField(&v, members.last("enableTelegram"), "enableTelegram")

	if err := v.err(); err != nil {
		return CompleteTelegramAuthInput{}, err
	}
	return input, nil
}

// requiredStringField validates @IsString() (default message $property must be
// a string). null and a missing member both fail; unlike the optional variant
// there is no presenceNull shortcut.
func requiredStringField(v *validationErrors, raw json.RawMessage, field string) string {
	text, ok := decodeJSONString(raw)
	if !ok {
		v.add(field + " must be a string")
		return ""
	}
	return text
}

// requiredE164PhoneField validates @IsString() @Matches(E164, {message:
// "TELEGRAM_AUTH_PHONE_FORMAT_INVALID"}). The constraint order is Matches then
// IsString (reverse decorator order), matching class-validator.
func requiredE164PhoneField(v *validationErrors, raw json.RawMessage, field string) string {
	text, isString := decodeJSONString(raw)
	matches := isString && telegramAuthE164PhonePattern.MatchString(text)
	if !matches {
		v.add("TELEGRAM_AUTH_PHONE_FORMAT_INVALID")
	}
	if !isString {
		v.add(field + " must be a string")
	}
	if !isString || !matches {
		return ""
	}
	return text
}

package situationsettings

import (
	"bytes"
	"encoding/json"
	"fmt"
	"math"
	"strconv"
	"strings"
)

// This file holds the PUT body model and the class-validator equivalent for
// UpdateSituationMonitorSettingsDto.
//
// The global ValidationPipe is configured with `whitelist`,
// `forbidNonWhitelisted` and `transform`. The collection order is therefore:
// unknown-property errors in body key order, then properties in DTO
// declaration order, and within one property the constraints in REVERSE
// decorator order (class-validator applies them bottom-up). The joined message
// is exactly what GlobalExceptionFilter produces (`"; "` separated).
//
// Every member is decoded as json.RawMessage so one wrong type never aborts the
// decode; the validators below return concrete Go types and never any/map.

// validationErrors accumulates class-validator style messages.
type validationErrors struct {
	messages []string
}

func (v *validationErrors) add(message string) { v.messages = append(v.messages, message) }

func (v *validationErrors) empty() bool { return len(v.messages) == 0 }

// err converts the collected messages into the 400 the client sees.
func (v *validationErrors) err() error {
	if v.empty() {
		return nil
	}
	return badRequest(strings.Join(v.messages, "; "))
}

// presence is the tri-state a JSON member can have. NestJS distinguishes an
// absent key (undefined) from JSON null in every @IsOptional path.
type presence uint8

const (
	presenceMissing presence = iota
	presenceNull
	presenceValue
)

type optionalBool struct {
	state presence
	value bool
}

type optionalNumber struct {
	state presence
	value float64
}

type optionalString struct {
	state presence
	value string
}

// provided reports whether the member was present at all (null counts).
func provided(state presence) bool { return state != presenceMissing }

// bodyField is one member of the request body in source order.
type bodyField struct {
	Key string
	Raw json.RawMessage
}

type bodyMembers []bodyField

// decodeBodyMembers decodes the body into ordered members.
func decodeBodyMembers(body []byte) (bodyMembers, error) {
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.UseNumber()
	token, err := decoder.Token()
	if err != nil {
		return nil, badRequest("Unexpected token in JSON body")
	}
	if delim, ok := token.(json.Delim); !ok || delim != '{' {
		return nil, badRequest("Invalid request body")
	}
	members := bodyMembers{}
	for decoder.More() {
		keyToken, err := decoder.Token()
		if err != nil {
			return nil, badRequest("Invalid request body")
		}
		key, ok := keyToken.(string)
		if !ok {
			return nil, badRequest("Invalid request body")
		}
		var raw json.RawMessage
		if err := decoder.Decode(&raw); err != nil {
			return nil, badRequest("Invalid request body")
		}
		members = append(members, bodyField{Key: key, Raw: raw})
	}
	return members, nil
}

// last returns the member value for key using the LAST occurrence, which is
// what JSON.parse produces for a duplicated key.
func (m bodyMembers) last(key string) json.RawMessage {
	var found json.RawMessage
	for _, member := range m {
		if member.Key == key {
			found = member.Raw
		}
	}
	return found
}

// keys returns the member names in first-occurrence order with duplicates
// removed.
func (m bodyMembers) keys() []string {
	seen := make(map[string]bool, len(m))
	out := make([]string, 0, len(m))
	for _, member := range m {
		if seen[member.Key] {
			continue
		}
		seen[member.Key] = true
		out = append(out, member.Key)
	}
	return out
}

// rejectUnknown appends one "property X should not exist" message per unknown
// member, in body key order.
func rejectUnknown(v *validationErrors, m bodyMembers, allowed map[string]bool) {
	for _, key := range m.keys() {
		if allowed[key] {
			continue
		}
		v.add("property " + key + " should not exist")
	}
}

// isNullRaw reports whether a present member holds the JSON literal null.
func isNullRaw(raw json.RawMessage) bool {
	return raw != nil && bytes.Equal(bytes.TrimSpace(raw), []byte("null"))
}

// optionalBoolField validates @IsOptional() @IsBoolean().
func optionalBoolField(v *validationErrors, raw json.RawMessage, field string) optionalBool {
	if raw == nil {
		return optionalBool{state: presenceMissing}
	}
	if isNullRaw(raw) {
		return optionalBool{state: presenceNull}
	}
	trimmed := bytes.TrimSpace(raw)
	if bytes.Equal(trimmed, []byte("true")) {
		return optionalBool{state: presenceValue, value: true}
	}
	if bytes.Equal(trimmed, []byte("false")) {
		return optionalBool{state: presenceValue, value: false}
	}
	v.add(field + " must be a boolean value")
	return optionalBool{state: presenceValue}
}

// optionalIntField validates @IsOptional() @IsInt() @Min(min) @Max(max).
// Messages follow class-validator registration order: Max, Min, IsInt.
func optionalIntField(v *validationErrors, raw json.RawMessage, field string, min, max int64) optionalNumber {
	if raw == nil {
		return optionalNumber{state: presenceMissing}
	}
	if isNullRaw(raw) {
		// @IsOptional() skips validation; the service turns null into
		// Number(null) === 0 and clamps it to the lower bound.
		return optionalNumber{state: presenceNull}
	}
	value, isNumber := jsonNumberValue(raw)
	maxOK := isNumber && !math.IsNaN(value) && value <= float64(max)
	minOK := isNumber && !math.IsNaN(value) && value >= float64(min)
	intOK := isNumber && jsIsInteger(value)
	if !maxOK {
		v.add(fmt.Sprintf("%s must not be greater than %d", field, max))
	}
	if !minOK {
		v.add(fmt.Sprintf("%s must not be less than %d", field, min))
	}
	if !intOK {
		v.add(field + " must be an integer number")
	}
	if !maxOK || !minOK || !intOK {
		return optionalNumber{state: presenceValue}
	}
	return optionalNumber{state: presenceValue, value: value}
}

// optionalStringField validates @IsOptional() @IsString().
func optionalStringField(v *validationErrors, raw json.RawMessage, field string) optionalString {
	if raw == nil {
		return optionalString{state: presenceMissing}
	}
	if isNullRaw(raw) {
		return optionalString{state: presenceNull}
	}
	text, ok := decodeJSONString(raw)
	if !ok {
		v.add(field + " must be a string")
		return optionalString{state: presenceValue}
	}
	return optionalString{state: presenceValue, value: text}
}

// requiredIntField validates @IsInt() @Min(min) @Max(max).
func requiredIntField(v *validationErrors, raw json.RawMessage, field string, min, max int64) int {
	value, isNumber := jsonNumberValue(raw)
	maxOK := isNumber && !math.IsNaN(value) && value <= float64(max)
	minOK := isNumber && !math.IsNaN(value) && value >= float64(min)
	intOK := isNumber && jsIsInteger(value)
	if !maxOK {
		v.add(fmt.Sprintf("%s must not be greater than %d", field, max))
	}
	if !minOK {
		v.add(fmt.Sprintf("%s must not be less than %d", field, min))
	}
	if !intOK {
		v.add(field + " must be an integer number")
	}
	if !maxOK || !minOK || !intOK {
		return 0
	}
	return int(value)
}

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

// jsonNumberValue parses a raw JSON number token; ok reports whether it is a
// JSON number at all (an out-of-range literal still counts as a number).
func jsonNumberValue(raw json.RawMessage) (float64, bool) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 {
		return 0, false
	}
	if trimmed[0] != '-' && (trimmed[0] < '0' || trimmed[0] > '9') {
		return 0, false
	}
	value, err := strconv.ParseFloat(string(trimmed), 64)
	if err != nil {
		var numErr *strconv.NumError
		if ok := errorsAsRange(err, &numErr); ok {
			return value, true
		}
		return math.NaN(), false
	}
	return value, true
}

// jsIsInteger mirrors Number.isInteger.
func jsIsInteger(value float64) bool {
	return !math.IsNaN(value) && !math.IsInf(value, 0) && value == math.Trunc(value)
}

// updateAllowedFields is the DTO whitelist.
var updateAllowedFields = map[string]bool{
	"translationMaxConcurrency":     true,
	"translationApiEnabled":         true,
	"translationApiBaseUrl":         true,
	"translationApiKey":             true,
	"translationFallbackApiEnabled": true,
	"translationFallbackApiBaseUrl": true,
	"finnhubApiKey":                 true,
	"fredApiKey":                    true,
	"translationApiTimeoutMs":       true,
	"translationApiMaxRetries":      true,
	"telegramEnabled":               true,
	"telegramChannelSet":            true,
	"telegramMaxFeedItems":          true,
	"telegramMaxTextChars":          true,
	"telegramChannelTimeoutMs":      true,
	"telegramPollCycleTimeoutMs":    true,
	"telegramStartupDelayMs":        true,
	"telegramRateLimitMs":           true,
	"telegramPollIntervalMs":        true,
	"liveHlsProxyCnnUpstreamUrl":    true,
	"liveHlsProxyCnnReferer":        true,
	"liveHlsProxyCnnAllowedHosts":   true,
	"liveHlsProxyCnbcUpstreamUrl":   true,
	"liveHlsProxyCnbcReferer":       true,
	"liveHlsProxyCnbcAllowedHosts":  true,
}

// UpdateInput is the validated PUT body. The optional members keep their
// tri-state so the service can distinguish "keep" (missing) from "clear" (null)
// and from a concrete value, exactly like the NestJS `??` merge.
type UpdateInput struct {
	TranslationMaxConcurrency     int
	TranslationAPIEnabled         optionalBool
	TranslationAPIBaseURL         optionalString
	TranslationAPIKey             optionalString
	TranslationFallbackAPIEnabled optionalBool
	TranslationFallbackAPIBaseURL optionalString
	FinnhubAPIKey                 optionalString
	FredAPIKey                    optionalString
	TranslationAPITimeoutMS       optionalNumber
	TranslationAPIMaxRetries      optionalNumber
	TelegramEnabled               optionalBool
	// The three Telegram credential members are not part of the HTTP PUT DTO.
	// completeAuth writes them through the same tri-state merge as the NestJS
	// controller's updateSettings call after a successful login.
	TelegramAPIID                optionalString
	TelegramAPIHash              optionalString
	TelegramSession              optionalString
	TelegramChannelSet           optionalString
	TelegramMaxFeedItems         optionalNumber
	TelegramMaxTextChars         optionalNumber
	TelegramChannelTimeoutMS     optionalNumber
	TelegramPollCycleTimeoutMS   optionalNumber
	TelegramStartupDelayMS       optionalNumber
	TelegramRateLimitMS          optionalNumber
	TelegramPollIntervalMS       optionalNumber
	LiveHLSProxyCnnUpstreamURL   optionalString
	LiveHLSProxyCnnReferer       optionalString
	LiveHLSProxyCnnAllowedHosts  optionalString
	LiveHLSProxyCnbcUpstreamURL  optionalString
	LiveHLSProxyCnbcReferer      optionalString
	LiveHLSProxyCnbcAllowedHosts optionalString
}

// parseUpdateSettings validates the PUT body in the ValidationPipe order.
func parseUpdateSettings(body []byte) (UpdateInput, error) {
	members, err := decodeBodyMembers(body)
	if err != nil {
		return UpdateInput{}, err
	}
	var v validationErrors
	rejectUnknown(&v, members, updateAllowedFields)

	var input UpdateInput
	input.TranslationMaxConcurrency = requiredIntField(&v, members.last("translationMaxConcurrency"),
		"translationMaxConcurrency", minTranslationMaxConcurrency, maxTranslationMaxConcurrency)
	input.TranslationAPIEnabled = optionalBoolField(&v, members.last("translationApiEnabled"), "translationApiEnabled")
	input.TranslationAPIBaseURL = optionalStringField(&v, members.last("translationApiBaseUrl"), "translationApiBaseUrl")
	input.TranslationAPIKey = optionalStringField(&v, members.last("translationApiKey"), "translationApiKey")
	input.TranslationFallbackAPIEnabled = optionalBoolField(&v, members.last("translationFallbackApiEnabled"), "translationFallbackApiEnabled")
	input.TranslationFallbackAPIBaseURL = optionalStringField(&v, members.last("translationFallbackApiBaseUrl"), "translationFallbackApiBaseUrl")
	input.FinnhubAPIKey = optionalStringField(&v, members.last("finnhubApiKey"), "finnhubApiKey")
	input.FredAPIKey = optionalStringField(&v, members.last("fredApiKey"), "fredApiKey")
	input.TranslationAPITimeoutMS = optionalIntField(&v, members.last("translationApiTimeoutMs"), "translationApiTimeoutMs", minTranslationAPITimeoutMS, maxTranslationAPITimeoutMS)
	input.TranslationAPIMaxRetries = optionalIntField(&v, members.last("translationApiMaxRetries"), "translationApiMaxRetries", minTranslationAPIMaxRetries, maxTranslationAPIMaxRetries)
	input.TelegramEnabled = optionalBoolField(&v, members.last("telegramEnabled"), "telegramEnabled")
	input.TelegramChannelSet = optionalStringField(&v, members.last("telegramChannelSet"), "telegramChannelSet")
	input.TelegramMaxFeedItems = optionalIntField(&v, members.last("telegramMaxFeedItems"), "telegramMaxFeedItems", minTelegramMaxFeedItems, maxTelegramMaxFeedItems)
	input.TelegramMaxTextChars = optionalIntField(&v, members.last("telegramMaxTextChars"), "telegramMaxTextChars", minTelegramMaxTextChars, maxTelegramMaxTextChars)
	input.TelegramChannelTimeoutMS = optionalIntField(&v, members.last("telegramChannelTimeoutMs"), "telegramChannelTimeoutMs", minTelegramChannelTimeoutMS, maxTelegramChannelTimeoutMS)
	input.TelegramPollCycleTimeoutMS = optionalIntField(&v, members.last("telegramPollCycleTimeoutMs"), "telegramPollCycleTimeoutMs", minTelegramPollCycleTimeoutMS, maxTelegramPollCycleTimeoutMS)
	input.TelegramStartupDelayMS = optionalIntField(&v, members.last("telegramStartupDelayMs"), "telegramStartupDelayMs", minTelegramStartupDelayMS, maxTelegramStartupDelayMS)
	input.TelegramRateLimitMS = optionalIntField(&v, members.last("telegramRateLimitMs"), "telegramRateLimitMs", minTelegramRateLimitMS, maxTelegramRateLimitMS)
	input.TelegramPollIntervalMS = optionalIntField(&v, members.last("telegramPollIntervalMs"), "telegramPollIntervalMs", minTelegramPollIntervalMS, maxTelegramPollIntervalMS)
	input.LiveHLSProxyCnnUpstreamURL = optionalStringField(&v, members.last("liveHlsProxyCnnUpstreamUrl"), "liveHlsProxyCnnUpstreamUrl")
	input.LiveHLSProxyCnnReferer = optionalStringField(&v, members.last("liveHlsProxyCnnReferer"), "liveHlsProxyCnnReferer")
	input.LiveHLSProxyCnnAllowedHosts = optionalStringField(&v, members.last("liveHlsProxyCnnAllowedHosts"), "liveHlsProxyCnnAllowedHosts")
	input.LiveHLSProxyCnbcUpstreamURL = optionalStringField(&v, members.last("liveHlsProxyCnbcUpstreamUrl"), "liveHlsProxyCnbcUpstreamUrl")
	input.LiveHLSProxyCnbcReferer = optionalStringField(&v, members.last("liveHlsProxyCnbcReferer"), "liveHlsProxyCnbcReferer")
	input.LiveHLSProxyCnbcAllowedHosts = optionalStringField(&v, members.last("liveHlsProxyCnbcAllowedHosts"), "liveHlsProxyCnbcAllowedHosts")

	if err := v.err(); err != nil {
		return UpdateInput{}, err
	}
	return input, nil
}

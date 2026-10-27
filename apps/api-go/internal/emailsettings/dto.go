package emailsettings

import (
	"bytes"
	"encoding/json"
	"math"
	"net/mail"
	"strconv"
	"strings"

	"github.com/wei500L/newwei/apps/api-go/internal/settingshttp"
)

// rawAuthCodeDTO keeps every member raw so the validator sees the exact JSON
// type class-validator would see (there is no @Type(() => Number) on this DTO).
type rawAuthCodeDTO struct {
	TTLSeconds      json.RawMessage `json:"ttlSeconds"`
	CooldownSeconds json.RawMessage `json:"cooldownSeconds"`
	MaxAttempts     json.RawMessage `json:"maxAttempts"`
}

// authCodeDTOFields are the members the DTO declares; every other member is
// rejected by the ValidationPipe's whitelist + forbidNonWhitelisted.
var authCodeDTOFields = []string{"ttlSeconds", "cooldownSeconds", "maxAttempts"}

// testDTOFields are the members EmailTestDto declares.
var testDTOFields = []string{"to", "subject"}

// objectMemberNames returns the top-level members of a JSON object body in
// document order (first occurrence wins, like Object.keys after JSON.parse), or
// nil when the body is not an object.
func objectMemberNames(body []byte) []string {
	trimmed := bytes.TrimSpace(body)
	if len(trimmed) == 0 || trimmed[0] != '{' {
		return nil
	}
	decoder := json.NewDecoder(bytes.NewReader(trimmed))
	if _, err := decoder.Token(); err != nil {
		return nil
	}
	seen := make(map[string]bool, 8)
	names := make([]string, 0, 8)
	for decoder.More() {
		token, err := decoder.Token()
		if err != nil {
			return names
		}
		name, ok := token.(string)
		if !ok {
			return names
		}
		var value json.RawMessage
		if err := decoder.Decode(&value); err != nil {
			return names
		}
		if seen[name] {
			continue
		}
		seen[name] = true
		names = append(names, name)
	}
	return names
}

// unknownPropertyMessages reproduces ValidationExecutor's whitelist error for
// every body member without validation metadata. `__proto__` is skipped because
// the ValidationPipe deletes it before validation.
func unknownPropertyMessages(body []byte, allowed []string) []string {
	allowedSet := make(map[string]bool, len(allowed))
	for _, name := range allowed {
		allowedSet[name] = true
	}
	var messages []string
	for _, name := range objectMemberNames(body) {
		if name == "__proto__" || allowedSet[name] {
			continue
		}
		messages = append(messages, "property "+name+" should not exist")
	}
	return messages
}

// parseAuthCodeDTO validates UpdateAuthEmailCodeSettingsDto. Unknown members are
// reported first (the ordering the sibling settings packages use), then
// class-validator's bottom-up @Max, @Min and @IsInt constraints, so a failing
// number reports in that order.
func parseAuthCodeDTO(body []byte) (AuthCodeSettings, error) {
	var raw rawAuthCodeDTO
	_ = json.Unmarshal(body, &raw)
	var problems settingshttp.ValidationErrors
	for _, message := range unknownPropertyMessages(body, authCodeDTOFields) {
		problems.Add(message)
	}

	ttl := integerField(&problems, raw.TTLSeconds, "ttlSeconds", minTTLSeconds, maxTTLSeconds)
	cooldown := integerField(&problems, raw.CooldownSeconds, "cooldownSeconds", minCooldownSeconds, maxCooldownSeconds)
	attempts := integerField(&problems, raw.MaxAttempts, "maxAttempts", minMaxAttempts, maxMaxAttempts)
	if err := problems.Err(); err != nil {
		return AuthCodeSettings{}, err
	}
	return AuthCodeSettings{TTLSeconds: ttl, CooldownSeconds: cooldown, MaxAttempts: attempts}, nil
}

func integerField(problems *settingshttp.ValidationErrors, raw json.RawMessage, field string, min, max int) int {
	var value float64
	isNumber := len(raw) > 0 && json.Unmarshal(raw, &value) == nil && !math.IsNaN(value) && !math.IsInf(value, 0)
	maxOK := isNumber && value <= float64(max)
	if !maxOK {
		problems.Add(field + " must not be greater than " + strconv.Itoa(max))
	}
	minOK := isNumber && value >= float64(min)
	if !minOK {
		problems.Add(field + " must not be less than " + strconv.Itoa(min))
	}
	integerOK := isNumber && math.Trunc(value) == value
	if !integerOK {
		problems.Add(field + " must be an integer number")
	}
	if !integerOK || !minOK || !maxOK {
		return 0
	}
	return int(value)
}

// rawTestDTO is EmailTestDto. Absent and null are both skipped by @IsOptional.
type rawTestDTO struct {
	To      json.RawMessage `json:"to"`
	Subject json.RawMessage `json:"subject"`
}

// parseTestDTO validates EmailTestDto and returns the raw values; trimming and
// defaulting happen in the controller-equivalent path.
func parseTestDTO(body []byte) (to, subject string, err error) {
	var raw rawTestDTO
	_ = json.Unmarshal(body, &raw)
	var problems settingshttp.ValidationErrors
	for _, message := range unknownPropertyMessages(body, testDTOFields) {
		problems.Add(message)
	}

	if value, present := optionalString(&problems, raw.To, "to", 320, true); present {
		to = value
	}
	if value, present := optionalString(&problems, raw.Subject, "subject", 140, false); present {
		subject = value
	}
	if err := problems.Err(); err != nil {
		return "", "", err
	}
	return to, subject, nil
}

// optionalString applies IsOptional + IsString + MaxLength (+ IsEmail) in the
// bottom-up order class-validator reports.
func optionalString(problems *settingshttp.ValidationErrors, raw json.RawMessage, field string, max int, email bool) (string, bool) {
	if len(raw) == 0 || string(raw) == "null" {
		return "", false
	}
	var value string
	isString := json.Unmarshal(raw, &value) == nil
	if email {
		if !isString || !isEmail(value) {
			problems.Add(field + " must be an email")
		}
	}
	if !isString || len(value) > max {
		problems.Add(field + " must be shorter than or equal to " + strconv.Itoa(max) + " characters")
	}
	if !isString {
		problems.Add(field + " must be a string")
	}
	return value, true
}

// isEmail mirrors the validator.js defaults used by class-validator's isEmail:
// no display name, a dotted domain and at most 254 characters.
func isEmail(value string) bool {
	if value == "" || len(value) > 254 || strings.ContainsAny(value, " \t\r\n") {
		return false
	}
	at := strings.LastIndex(value, "@")
	if at <= 0 || at == len(value)-1 {
		return false
	}
	if strings.Contains(value[:at], "@") {
		return false
	}
	domain := value[at+1:]
	if strings.Contains(domain, "@") || !strings.Contains(domain, ".") {
		return false
	}
	parsed, err := mail.ParseAddress(value)
	return err == nil && parsed.Address == value
}

package emailsettings

import (
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

// parseAuthCodeDTO validates UpdateAuthEmailCodeSettingsDto. class-validator
// applies @Max, @Min and @IsInt bottom-up, so a failing number reports in that
// order; a non-number fails all three and reports three messages.
func parseAuthCodeDTO(body []byte) (AuthCodeSettings, error) {
	var raw rawAuthCodeDTO
	_ = json.Unmarshal(body, &raw)
	var problems settingshttp.ValidationErrors

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

package alertworker

import (
	"regexp"
	"strings"
)

// This file ports EmailService.normalizeEmailTarget / extractEmails for the
// alert delivery path: the email channel target is normalised when the channel
// is written and again when a delivery is sent.
//
// The validator.js isEmail port is the third sibling copy in this module
// (internal/graphqlread/workspacewrite/email.go and
// internal/dataruntimesettings/dto.go carry the other two). The module has no
// shared validator package and this batch moves no other code, so the copy is
// deliberate and should be unified when a shared validator package lands.
var (
	emailExtractRegex = regexp.MustCompile("(?i)[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+")

	emailUserUTF8PartRe = regexp.MustCompile("(?i)^[a-z\\d!#$%&'*+\\-/=?^_`{|}~\\x{00A1}-\\x{D7FF}\\x{F900}-\\x{FDCF}\\x{FDF0}-\\x{FFEF}]+$")
	quotedEmailUserRe   = regexp.MustCompile("(?i)^([\\s\\x01-\\x08\\x0b\\x0c\\x0e-\\x1f\\x7f\\x21-\\x5b\\x5d-\\x7e\\x{00A0}-\\x{D7FF}\\x{F900}-\\x{FDCF}\\x{FDF0}-\\x{FFEF}]|(\\\\[\\x01-\\x09\\x0b\\x0c\\x0d-\\x7f\\x{00A0}-\\x{D7FF}\\x{F900}-\\x{FDCF}\\x{FDF0}-\\x{FFEF}]))*$")
	fqdnTLDRe           = regexp.MustCompile("(?i)^([a-z\\x{00A1}-\\x{00A8}\\x{00AA}-\\x{D7FF}\\x{F900}-\\x{FDCF}\\x{FDF0}-\\x{FFEF}]{2,}|xn[a-z0-9-]{2,})$")
	fqdnPartRe          = regexp.MustCompile("(?i)^[a-z_\\x{00A1}-\\x{FFFF}0-9-]+$")
	fullWidthRe         = regexp.MustCompile("[\\x{FF01}-\\x{FF5E}]")
)

// normalizeEmailTarget mirrors EmailService.normalizeEmailTarget: extract every
// valid email, drop duplicates and join with ", ". An email-less target is an
// error with the same message as the NestJS BadRequestException.
func normalizeEmailTarget(target string) (string, error) {
	emails := extractEmails(target)
	if len(emails) == 0 {
		return "", errInvalidEmailTarget
	}
	return strings.Join(emails, ", "), nil
}

// extractEmails mirrors EmailService.extractEmails: trim, match the extraction
// regex globally, keep the matches that pass isEmail and de-duplicate in match
// order.
func extractEmails(input string) []string {
	normalized := strings.TrimSpace(input)
	if normalized == "" {
		return nil
	}
	matches := emailExtractRegex.FindAllString(normalized, -1)
	seen := make(map[string]struct{}, len(matches))
	result := make([]string, 0, len(matches))
	for _, match := range matches {
		candidate := strings.TrimSpace(match)
		if candidate == "" {
			continue
		}
		if !validatorIsEmail(candidate) {
			continue
		}
		if _, exists := seen[candidate]; exists {
			continue
		}
		seen[candidate] = struct{}{}
		result = append(result, candidate)
	}
	return result
}

// validatorIsEmail mirrors validator.js isEmail with class-validator's defaults.
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
	if len([]byte(user)) == 0 || len([]byte(user)) > 64 {
		return false
	}
	if len([]byte(domain)) == 0 || len([]byte(domain)) > 254 {
		return false
	}
	if !validatorIsFQDN(domain) {
		return false
	}
	if strings.HasPrefix(user, `"`) && strings.HasSuffix(user, `"`) && len(user) >= 2 {
		return quotedEmailUserRe.MatchString(user[1 : len(user)-1])
	}
	for _, part := range strings.Split(user, ".") {
		if part == "" || !emailUserUTF8PartRe.MatchString(part) {
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

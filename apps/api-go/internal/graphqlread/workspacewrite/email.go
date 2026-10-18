package workspacewrite

import (
	"regexp"
	"strings"
)

// This file ports validator.js isEmail / isFQDN to decide an extracted email
// candidate, which is the filter EmailService.extractEmails applies through
// class-validator's isEmail. alert channel targets are the only caller.
//
// apps/api-go/internal/dataruntimesettings/dto.go holds the sibling port for the
// data/runtime settings DTOs. The two are intentionally separate: there is no
// shared validator package in this module, and this batch moves no other code.

var (
	// emailUserUTF8PartRe is validator.js `emailUserUtf8Part` (allow_utf8_local_part
	// defaults to true).
	emailUserUTF8PartRe = regexp.MustCompile("(?i)^[a-z\\d!#$%&'*+\\-/=?^_`{|}~\\x{00A1}-\\x{D7FF}\\x{F900}-\\x{FDCF}\\x{FDF0}-\\x{FFEF}]+$")
	// quotedEmailUserRe is validator.js `quotedEmailUserUtf8`.
	quotedEmailUserRe = regexp.MustCompile("(?i)^([\\s\\x01-\\x08\\x0b\\x0c\\x0e-\\x1f\\x7f\\x21-\\x5b\\x5d-\\x7e\\x{00A0}-\\x{D7FF}\\x{F900}-\\x{FDCF}\\x{FDF0}-\\x{FFEF}]|(\\\\[\\x01-\\x09\\x0b\\x0c\\x0d-\\x7f\\x{00A0}-\\x{D7FF}\\x{F900}-\\x{FDCF}\\x{FDF0}-\\x{FFEF}]))*$")
	// fqdnTLDRe is the TLD branch of validator.js isFQDN with require_tld=true and
	// allow_numeric_tld=false (a numeric TLD never matches).
	fqdnTLDRe = regexp.MustCompile("(?i)^([a-z\\x{00A1}-\\x{00A8}\\x{00AA}-\\x{D7FF}\\x{F900}-\\x{FDCF}\\x{FDF0}-\\x{FFEF}]{2,}|xn[a-z0-9-]{2,})$")
	// fqdnPartRe is validator.js isFQDN's per-label pattern.
	fqdnPartRe = regexp.MustCompile("(?i)^[a-z_\\x{00A1}-\\x{FFFF}0-9-]+$")
	// fullWidthRe rejects the full-width character block.
	fullWidthRe = regexp.MustCompile("[\\x{FF01}-\\x{FF5E}]")
)

// validatorIsEmail mirrors validator.js isEmail with class-validator's default
// options: allow_utf8_local_part=true, require_tld=true,
// allow_underscores=false, ignore_max_length=false, no display names and no
// IP-literal domains.
func validatorIsEmail(value string) bool {
	if len(value) > 254 {
		return false
	}
	at := strings.LastIndex(value, "@")
	if at < 0 {
		// split('@') with no separator leaves domain = value and user = "".
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

package platformgovernance

import (
	"strings"
	"testing"
)

func TestParseUpdateSecurityMessages(t *testing.T) {
	_, err := parseUpdateSecurity([]byte(`{}`))
	want := "secretEncryptionEnabled must be a boolean value; mfaPolicy must be one of the following values: off, admins_only, all_users"
	if err == nil || err.Error() != want {
		t.Fatalf("err = %v, want %q", err, want)
	}

	// @IsBoolean is strict: the string "true" is not a boolean.
	_, err = parseUpdateSecurity([]byte(`{"secretEncryptionEnabled":"true","mfaPolicy":"off"}`))
	if err == nil || err.Error() != "secretEncryptionEnabled must be a boolean value" {
		t.Fatalf("string boolean err = %v", err)
	}

	// @IsIn reports one message, even for a non-string value.
	_, err = parseUpdateSecurity([]byte(`{"secretEncryptionEnabled":true,"mfaPolicy":"nope"}`))
	if err == nil || err.Error() != "mfaPolicy must be one of the following values: off, admins_only, all_users" {
		t.Fatalf("bad enum err = %v", err)
	}

	_, err = parseUpdateSecurity([]byte(`{"secretEncryptionEnabled":true,"mfaPolicy":"off","bogus":1}`))
	if err == nil || err.Error() != "property bogus should not exist" {
		t.Fatalf("unknown property err = %v", err)
	}

	input, err := parseUpdateSecurity([]byte(`{"secretEncryptionEnabled":true,"mfaPolicy":"admins_only"}`))
	if err != nil {
		t.Fatalf("valid body err = %v", err)
	}
	if !input.SecretEncryptionEnabled || input.MfaPolicy != MfaPolicyAdminsOnly {
		t.Fatalf("input = %+v", input)
	}
}

func TestParseUpdateQuotaMessages(t *testing.T) {
	_, err := parseUpdateQuota([]byte(`{}`))
	// Properties stay in declaration order; within one property the constraints
	// report in reverse decorator order (Max, Min, IsInt).
	want := strings.Join([]string{
		"enabled must be a boolean value",
		"submitLimitPerHour must not be greater than 10000",
		"submitLimitPerHour must not be less than 0",
		"submitLimitPerHour must be an integer number",
		"maxInFlightPerOrg must not be greater than 100",
		"maxInFlightPerOrg must not be less than 0",
		"maxInFlightPerOrg must be an integer number",
		"monthlyTokenBudget must not be greater than 1000000000000",
		"monthlyTokenBudget must not be less than 0",
		"monthlyTokenBudget must be an integer number",
	}, "; ")
	if err == nil || err.Error() != want {
		t.Fatalf("err = %v\nwant %q", err, want)
	}
}

func TestParseUpdateQuotaNumberCoercion(t *testing.T) {
	// @Type(() => Number): "50" -> 50, null -> 0, "" -> 0, true -> 1.
	input, err := parseUpdateQuota([]byte(`{"enabled":true,"submitLimitPerHour":"50","maxInFlightPerOrg":null,"monthlyTokenBudget":""}`))
	if err != nil {
		t.Fatalf("coercion err = %v", err)
	}
	if !input.Enabled || input.SubmitLimitPerHour != 50 || input.MaxInFlightPerOrg != 0 || input.MonthlyTokenBudget != 0 {
		t.Fatalf("input = %+v", input)
	}

	// A non-numeric string, an object and an array each fail every constraint.
	_, err = parseUpdateQuota([]byte(`{"enabled":true,"submitLimitPerHour":["50"],"maxInFlightPerOrg":{},"monthlyTokenBudget":"abc"}`))
	if err == nil {
		t.Fatal("invalid numbers must be rejected")
	}
	if got := strings.Count(err.Error(), "submitLimitPerHour must be an integer number"); got != 1 {
		t.Fatalf("submitLimitPerHour messages = %d (%v)", got, err)
	}
	for _, field := range []string{"submitLimitPerHour", "maxInFlightPerOrg", "monthlyTokenBudget"} {
		if !strings.Contains(err.Error(), field+" must be an integer number") ||
			!strings.Contains(err.Error(), field+" must not be less than 0") {
			t.Fatalf("missing messages for %s: %v", field, err)
		}
	}

	_, err = parseUpdateQuota([]byte(`{"enabled":true,"submitLimitPerHour":10001,"maxInFlightPerOrg":-1,"monthlyTokenBudget":1.5}`))
	if err == nil {
		t.Fatal("out-of-range numbers must be rejected")
	}
}

func TestParseUpdateSafetyMessages(t *testing.T) {
	_, err := parseUpdateSafety([]byte(`{}`))
	want := "enabled must be a boolean value; outputModerationEnabled must be a boolean value"
	if err == nil || err.Error() != want {
		t.Fatalf("err = %v, want %q", err, want)
	}
	input, err := parseUpdateSafety([]byte(`{"enabled":false,"outputModerationEnabled":true}`))
	if err != nil {
		t.Fatalf("valid body err = %v", err)
	}
	if input.Enabled || !input.OutputModerationEnabled {
		t.Fatalf("input = %+v", input)
	}
}

func TestParseUpdateTaskLogRejectsNumericString(t *testing.T) {
	// The task-log DTO has no @Type, so a quoted number is a 400 with all three
	// class-validator messages.
	_, err := parseUpdateTaskLog([]byte(`{"retentionDays":"30"}`))
	want := "retentionDays must not be greater than 3650; retentionDays must not be less than 1; retentionDays must be an integer number"
	if err == nil || err.Error() != want {
		t.Fatalf("err = %v, want %q", err, want)
	}
	input, err := parseUpdateTaskLog([]byte(`{"retentionDays":30}`))
	if err != nil || input.RetentionDays != 30 {
		t.Fatalf("valid body = %+v err = %v", input, err)
	}
}

func TestParseUpdateLlmLogOptionalFields(t *testing.T) {
	// All properties are @IsOptional: an empty object and explicit nulls pass
	// the DTO, and the service raises the "at least one" 400 instead.
	if _, err := parseUpdateLlmLog([]byte(`{}`)); err != nil {
		t.Fatalf("empty body err = %v", err)
	}
	if _, err := parseUpdateLlmLog([]byte(`{"retentionDays":null,"metadataAllowedTopLevelKeys":null,"metadataAllowedTopLevelPrefixes":null,"briefErrorRateThreshold":null,"briefInvalidJsonRatioThreshold":null,"briefConsecutiveDaysThreshold":null}`)); err != nil {
		t.Fatalf("null body err = %v", err)
	}

	_, err := parseUpdateLlmLog([]byte(`{"retentionDays":"30"}`))
	want := "retentionDays must not be greater than 3650; retentionDays must not be less than 1; retentionDays must be an integer number"
	if err == nil || err.Error() != want {
		t.Fatalf("quoted retentionDays err = %v, want %q", err, want)
	}

	_, err = parseUpdateLlmLog([]byte(`{"metadataAllowedTopLevelKeys":5}`))
	want = "each value in metadataAllowedTopLevelKeys must be a string; metadataAllowedTopLevelKeys must contain not more than 100 elements; metadataAllowedTopLevelKeys must be an array"
	if err == nil || err.Error() != want {
		t.Fatalf("non-array keys err = %v, want %q", err, want)
	}

	_, err = parseUpdateLlmLog([]byte(`{"metadataAllowedTopLevelKeys":["a","b",3]}`))
	if err == nil || err.Error() != "each value in metadataAllowedTopLevelKeys must be a string" {
		t.Fatalf("mixed array err = %v", err)
	}

	// @IsNumber({maxDecimalPlaces: 4}) rejects a fifth decimal place.
	_, err = parseUpdateLlmLog([]byte(`{"briefErrorRateThreshold":0.12345}`))
	if err == nil || err.Error() != "briefErrorRateThreshold must be a number conforming to the specified constraints" {
		t.Fatalf("too many decimals err = %v", err)
	}
	if _, err := parseUpdateLlmLog([]byte(`{"briefErrorRateThreshold":0.1234}`)); err != nil {
		t.Fatalf("four decimals err = %v", err)
	}

	_, err = parseUpdateLlmLog([]byte(`{"briefConsecutiveDaysThreshold":"7"}`))
	want = "briefConsecutiveDaysThreshold must not be greater than 30; briefConsecutiveDaysThreshold must not be less than 1; briefConsecutiveDaysThreshold must be an integer number"
	if err == nil || err.Error() != want {
		t.Fatalf("consecutive days err = %v, want %q", err, want)
	}
	// A bare out-of-range number fails only the bound it violates.
	_, err = parseUpdateLlmLog([]byte(`{"briefConsecutiveDaysThreshold":0}`))
	if err == nil || err.Error() != "briefConsecutiveDaysThreshold must not be less than 1" {
		t.Fatalf("zero consecutive days err = %v", err)
	}
}

func TestParseUpdateLlmLogUnknownProperty(t *testing.T) {
	_, err := parseUpdateLlmLog([]byte(`{"nope":true}`))
	if err == nil || err.Error() != "property nope should not exist" {
		t.Fatalf("err = %v", err)
	}
}

// TestUndefinedVersusNullInputs verifies the service-visible distinction: an
// absent key yields nil bytes while an explicit null keeps the four bytes
// "null", which is what makes null "provided" in the merge rules.
func TestUndefinedVersusNullInputs(t *testing.T) {
	input, err := parseUpdateLlmLog([]byte(`{"retentionDays":null}`))
	if err != nil {
		t.Fatalf("err = %v", err)
	}
	if !hasValue(input.RetentionDays) || !isNullValue(input.RetentionDays) {
		t.Fatalf("retentionDays = %q", string(input.RetentionDays))
	}
	if hasValue(input.BriefErrorRateThreshold) {
		t.Fatalf("absent field reported present: %q", string(input.BriefErrorRateThreshold))
	}
}

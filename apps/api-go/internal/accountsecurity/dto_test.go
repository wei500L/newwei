package accountsecurity

import (
	"errors"
	"strings"
	"testing"
)

// wantBadRequest asserts the error is a 400 httpError whose message contains
// every expected fragment.
func wantBadRequest(t *testing.T, err error, fragments ...string) {
	t.Helper()
	if err == nil {
		t.Fatalf("expected a 400 error")
	}
	var coded *httpError
	if !errors.As(err, &coded) {
		t.Fatalf("expected *httpError, got %T (%v)", err, err)
	}
	if coded.status != 400 {
		t.Fatalf("status = %d (%v)", coded.status, coded.message)
	}
	for _, fragment := range fragments {
		if !strings.Contains(coded.message, fragment) {
			t.Fatalf("message %q does not contain %q", coded.message, fragment)
		}
	}
}

func TestParseUpdateProfileRequestOptionalNullPassesDTO(t *testing.T) {
	// @IsOptional() short-circuits an explicit null, so the DTO must accept it;
	// the service layer turns it into the per-field empty error (AS3).
	for _, body := range []string{
		`{}`,
		`null`,
		`{"firstName":null}`,
		`{"lastName":null,"avatarUrl":null}`,
	} {
		if _, err := parseUpdateProfileRequest([]byte(body)); err != nil {
			t.Fatalf("body %s: unexpected %v", body, err)
		}
	}
}

func TestParseUpdateProfileRequestConstraints(t *testing.T) {
	_, err := parseUpdateProfileRequest([]byte(`{"firstName":123}`))
	wantBadRequest(t, err,
		"firstName must be shorter than or equal to 80 characters",
		"firstName must be a string")

	_, err = parseUpdateProfileRequest([]byte(`{"lastName":"` + strings.Repeat("a", 81) + `"}`))
	wantBadRequest(t, err, "lastName must be shorter than or equal to 80 characters")

	_, err = parseUpdateProfileRequest([]byte(`{"avatarUrl":"not-a-url"}`))
	wantBadRequest(t, err, "avatarUrl must be a URL address")

	_, err = parseUpdateProfileRequest([]byte(`{"avatarUrl":"https://cdn.example.com/` + strings.Repeat("a", 2048) + `"}`))
	wantBadRequest(t, err, "avatarUrl must be shorter than or equal to 2048 characters")

	_, err = parseUpdateProfileRequest([]byte(`{"avatarUrl":"javascript:alert(1)"}`))
	wantBadRequest(t, err, "avatarUrl must be a URL address")

	// A valid absolute URL passes; the storage base URL check is a service rule.
	if _, err := parseUpdateProfileRequest([]byte(`{"avatarUrl":"https://cdn.example.com/a.png"}`)); err != nil {
		t.Fatalf("valid url: %v", err)
	}

	// MaxLength counts code points, not UTF-8 bytes: 80 two-byte characters fit.
	accented := strings.Repeat("é", 80)
	if _, err := parseUpdateProfileRequest([]byte(`{"firstName":"` + accented + `"}`)); err != nil {
		t.Fatalf("80 accented chars: %v", err)
	}
	_, err = parseUpdateProfileRequest([]byte(`{"firstName":"` + accented + `é"}`))
	wantBadRequest(t, err, "firstName must be shorter than or equal to 80 characters")
}

func TestParseUpdateProfileRequestRejectsUnknownFields(t *testing.T) {
	_, err := parseUpdateProfileRequest([]byte(`{"email":"x@example.com"}`))
	wantBadRequest(t, err, `property email should not exist`)
}

func TestParseChangePasswordRequestConstraints(t *testing.T) {
	if _, err := parseChangePasswordRequest([]byte(`{"currentPassword":"current-password","newPassword":"new-password"}`)); err != nil {
		t.Fatalf("valid: %v", err)
	}

	_, err := parseChangePasswordRequest([]byte(`{}`))
	wantBadRequest(t, err,
		"currentPassword must be a string",
		"newPassword must be a string")

	_, err = parseChangePasswordRequest([]byte(`{"currentPassword":12345678,"newPassword":"new-password"}`))
	wantBadRequest(t, err, "currentPassword must be a string")

	_, err = parseChangePasswordRequest([]byte(`{"currentPassword":"short","newPassword":"new-password"}`))
	wantBadRequest(t, err, "currentPassword must be longer than or equal to 8 characters")

	_, err = parseChangePasswordRequest([]byte(`{"currentPassword":"` + strings.Repeat("a", 257) + `","newPassword":"new-password"}`))
	wantBadRequest(t, err, "currentPassword must be shorter than or equal to 256 characters")

	// Passwords are never trimmed by the DTO.
	parsed, err := parseChangePasswordRequest([]byte(`{"currentPassword":"  spaced  ","newPassword":"new-password"}`))
	if err != nil {
		t.Fatalf("spaced: %v", err)
	}
	if value, _ := jsonString(parsed.CurrentPassword); value != "  spaced  " {
		t.Fatalf("password was mutated: %q", value)
	}
}

func TestParseLogoutRequestConstraints(t *testing.T) {
	// An empty body is legal for logout (all members optional).
	if _, err := parseLogoutRequest([]byte(`{}`)); err != nil {
		t.Fatalf("empty: %v", err)
	}
	if _, err := parseLogoutRequest([]byte(`{"refreshToken":null,"logoutAll":null}`)); err != nil {
		t.Fatalf("null members: %v", err)
	}

	_, err := parseLogoutRequest([]byte(`{"logoutAll":"true"}`))
	wantBadRequest(t, err, "logoutAll must be a boolean value")

	_, err = parseLogoutRequest([]byte(`{"refreshToken":"too-short"}`))
	wantBadRequest(t, err, "refreshToken must be longer than or equal to 20 characters")

	refreshToken, logoutAll := logoutValues(logoutRequest{
		RefreshToken: []byte(`"` + strings.Repeat("a", 20) + `"`),
		LogoutAll:    []byte("true"),
	})
	if refreshToken == nil || *refreshToken != strings.Repeat("a", 20) {
		t.Fatalf("refreshToken = %v", refreshToken)
	}
	if !logoutAll {
		t.Fatalf("logoutAll = false")
	}
	// Absent logoutAll must stay false, not become an explicit true.
	if _, value := logoutValues(logoutRequest{}); value {
		t.Fatalf("absent logoutAll became true")
	}
}

func TestParseCreateMachineTokenRequestConstraints(t *testing.T) {
	parsed, err := parseCreateMachineTokenRequest([]byte(`{"name":"ci","permissions":["metrics.read"],"expiresAt":"2030-01-02T03:04:05.000Z"}`))
	if err != nil {
		t.Fatalf("valid: %v", err)
	}
	if parsed.Name != "ci" || len(parsed.Permissions) != 1 || parsed.ExpiresAt == nil {
		t.Fatalf("parsed = %+v", parsed)
	}

	// An empty permissions array passes the DTO; the service rejects it.
	empty, err := parseCreateMachineTokenRequest([]byte(`{"name":"ci","permissions":[]}`))
	if err != nil {
		t.Fatalf("empty permissions must pass DTO: %v", err)
	}
	if len(empty.Permissions) != 0 {
		t.Fatalf("permissions = %v", empty.Permissions)
	}

	_, err = parseCreateMachineTokenRequest([]byte(`{"name":"ci"}`))
	wantBadRequest(t, err, "permissions must be an array")

	_, err = parseCreateMachineTokenRequest([]byte(`{"name":"ci","permissions":[1]}`))
	wantBadRequest(t, err, "each value in permissions must be a string")

	tooMany := make([]string, 0, 21)
	for index := 0; index < 21; index++ {
		tooMany = append(tooMany, `"metrics.read"`)
	}
	_, err = parseCreateMachineTokenRequest([]byte(`{"name":"ci","permissions":[` + strings.Join(tooMany, ",") + `]}`))
	wantBadRequest(t, err, "permissions must contain not more than 20 elements")

	_, err = parseCreateMachineTokenRequest([]byte(`{"name":"","permissions":["metrics.read"]}`))
	wantBadRequest(t, err, "name must be longer than or equal to 1 characters")

	_, err = parseCreateMachineTokenRequest([]byte(`{"name":"` + strings.Repeat("a", 121) + `","permissions":["metrics.read"]}`))
	wantBadRequest(t, err, "name must be shorter than or equal to 120 characters")

	_, err = parseCreateMachineTokenRequest([]byte(`{"name":"ci","permissions":["metrics.read"],"expiresAt":"not-a-date"}`))
	wantBadRequest(t, err, "expiresAt must be a valid ISO 8601 date string")

	// A date-only ISO string is accepted and parsed as UTC midnight.
	dateOnly, err := parseCreateMachineTokenRequest([]byte(`{"name":"ci","permissions":["metrics.read"],"expiresAt":"2030-01-02"}`))
	if err != nil {
		t.Fatalf("date only: %v", err)
	}
	if dateOnly.ExpiresAt == nil || dateOnly.ExpiresAt.UTC().Format("2006-01-02") != "2030-01-02" {
		t.Fatalf("expiresAt = %v", dateOnly.ExpiresAt)
	}

	// A past-but-valid date is accepted: the contract adds no future bound.
	if _, err := parseCreateMachineTokenRequest([]byte(`{"name":"ci","permissions":["metrics.read"],"expiresAt":"2000-01-01T00:00:00Z"}`)); err != nil {
		t.Fatalf("past date: %v", err)
	}

	_, err = parseCreateMachineTokenRequest([]byte(`{"name":"ci","permissions":["metrics.read"],"extra":1}`))
	wantBadRequest(t, err, "property extra should not exist")
}

func TestParseRejectsNonObjectBody(t *testing.T) {
	for _, body := range []string{`[]`, `12`, `"text"`, `true`} {
		_, err := parseUpdateProfileRequest([]byte(body))
		wantBadRequest(t, err, "an unknown value was passed to the validate function")
	}
}

func TestNormalizePermissions(t *testing.T) {
	cases := []struct {
		name  string
		input []string
		want  []string
	}{
		{"unsupported dropped", []string{"settings.manage", "metrics.read"}, []string{"metrics.read"}},
		{"trim and dedupe keep first order", []string{" metrics.read ", "metrics.read", "other", "metrics.read"}, []string{"metrics.read"}},
		{"all unsupported", []string{"users.write", "settings.manage"}, []string{}},
		{"empty input", []string{}, []string{}},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			got := normalizePermissions(testCase.input)
			if len(got) != len(testCase.want) {
				t.Fatalf("got %v want %v", got, testCase.want)
			}
			for index := range got {
				if got[index] != testCase.want[index] {
					t.Fatalf("got %v want %v", got, testCase.want)
				}
			}
		})
	}
}

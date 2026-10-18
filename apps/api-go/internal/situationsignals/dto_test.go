package situationsignals

import (
	"errors"
	"strings"
	"testing"
)

func TestValidateFeedbackBodyMessages(t *testing.T) {
	cases := []struct {
		name string
		body string
		want string
	}{
		{
			name: "valid",
			body: `{"signalType":"narrative","signalId":"sig-1","label":"false_positive"}`,
			want: "",
		},
		{
			name: "optional strings accepted",
			body: `{"signalType":"correlation","signalId":"sig-1","label":"false_negative","itemMetaId":"m","itemLink":"l","itemTitle":"t","itemSource":"s","note":"n"}`,
			want: "",
		},
		{
			// Decorators apply bottom-up, so the @IsIn message precedes the
			// @IsString message for the same property.
			name: "missing signalType",
			body: `{}`,
			want: "signalType must be one of the following values: narrative, correlation; signalType must be a string; " +
				"signalId must be a string; " +
				"label must be one of the following values: false_positive, false_negative; label must be a string",
		},
		{
			name: "wrong enum value",
			body: `{"signalType":"bogus","signalId":"sig-1","label":"false_positive"}`,
			want: "signalType must be one of the following values: narrative, correlation",
		},
		{
			name: "wrong types",
			body: `{"signalType":1,"signalId":2,"label":3}`,
			want: "signalType must be one of the following values: narrative, correlation; signalType must be a string; " +
				"signalId must be a string; " +
				"label must be one of the following values: false_positive, false_negative; label must be a string",
		},
		{
			name: "null required properties",
			body: `{"signalType":null,"signalId":null,"label":null}`,
			want: "signalType must be one of the following values: narrative, correlation; signalType must be a string; " +
				"signalId must be a string; " +
				"label must be one of the following values: false_positive, false_negative; label must be a string",
		},
		{
			// @IsOptional() lets null through, so only the non-null wrong type
			// reports.
			name: "optional null and wrong type",
			body: `{"signalType":"narrative","signalId":"sig-1","label":"false_positive","itemMetaId":null,"note":7}`,
			want: "note must be a string",
		},
		{
			name: "blank signalId passes the DTO",
			body: `{"signalType":"narrative","signalId":" ","label":"false_positive"}`,
			want: "",
		},
		{
			name: "unknown property last",
			body: `{"signalType":"narrative","signalId":"sig-1","label":"false_positive","extra":1}`,
			want: "property extra should not exist",
		},
		{
			name: "unknown before missing required",
			body: `{"extra":1,"zzz":2}`,
			want: "signalType must be one of the following values: narrative, correlation; signalType must be a string; " +
				"signalId must be a string; " +
				"label must be one of the following values: false_positive, false_negative; label must be a string; " +
				"property extra should not exist; property zzz should not exist",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := validateFeedbackBody([]byte(tc.body))
			if tc.want == "" {
				if err != nil {
					t.Fatalf("unexpected error: %v", err)
				}
				return
			}
			if err == nil {
				t.Fatalf("want error %q", tc.want)
			}
			if err.Error() != tc.want {
				t.Fatalf("message\n got: %s\nwant: %s", err.Error(), tc.want)
			}
			var status *statusError
			if !errors.As(err, &status) || status.status != 400 {
				t.Fatalf("status = %+v, want 400", err)
			}
		})
	}
}

func TestValidateFeedbackBodyRejectsNonObject(t *testing.T) {
	for _, body := range []string{`[]`, `"text"`, `5`, `null`} {
		_, err := validateFeedbackBody([]byte(body))
		if err == nil || err.Error() != "an unknown value was passed to the validate function" {
			t.Fatalf("body %s: %v", body, err)
		}
	}
	if _, err := validateFeedbackBody([]byte("")); err == nil {
		t.Fatal("an empty body must behave like {}", err)
	}
}

func TestValidateFeedbackBodyKeepsRawStrings(t *testing.T) {
	input, err := validateFeedbackBody([]byte(`{"signalType":"narrative","signalId":"  sig  ","label":"false_positive","itemTitle":"  Hello World  "}`))
	if err != nil {
		t.Fatal(err)
	}
	// The service trims; the DTO must not.
	if input.SignalID != "  sig  " || input.ItemTitle != "  Hello World  " {
		t.Fatalf("input = %+v", input)
	}
	if strings.TrimSpace(input.SignalID) != "sig" {
		t.Fatalf("signalId = %q", input.SignalID)
	}
}

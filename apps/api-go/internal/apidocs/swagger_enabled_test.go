package apidocs

import (
	"strings"
	"testing"
)

// stringPointer returns a pointer to value; nil stands for an unset variable.
func stringPointer(value string) *string {
	return &value
}

// valueOrUnset renders a table value for failure messages.
func valueOrUnset(value *string) string {
	if value == nil {
		return "<unset>"
	}
	return *value
}

// TestSwaggerEnabledMatchesTheNestSchema locks the envBoolean grammar and the
// non-production default from apps/api/src/modules/config/env.schema.ts.
func TestSwaggerEnabledMatchesTheNestSchema(t *testing.T) {
	cases := []struct {
		name    string
		value   *string
		nodeEnv string
		want    bool
		wantErr bool
	}{
		{name: "unset outside production", value: nil, nodeEnv: "development", want: true},
		{name: "unset in production", value: nil, nodeEnv: "production", want: false},
		{name: "unset with empty NODE_ENV", value: nil, nodeEnv: "", want: true},
		{name: "empty value outside production", value: stringPointer(""), nodeEnv: "test", want: true},
		{name: "empty value in production", value: stringPointer(""), nodeEnv: "production", want: false},
		{name: "whitespace only is unset", value: stringPointer("  "), nodeEnv: "production", want: false},
		{name: "true in production", value: stringPointer("true"), nodeEnv: "production", want: true},
		{name: "TRUE with spaces", value: stringPointer(" TRUE "), nodeEnv: "production", want: true},
		{name: "1", value: stringPointer("1"), nodeEnv: "production", want: true},
		{name: "yes", value: stringPointer("yes"), nodeEnv: "production", want: true},
		{name: "y", value: stringPointer("y"), nodeEnv: "production", want: true},
		{name: "on", value: stringPointer("ON"), nodeEnv: "production", want: true},
		{name: "false outside production", value: stringPointer("false"), nodeEnv: "development", want: false},
		{name: "FALSE", value: stringPointer("FALSE"), nodeEnv: "development", want: false},
		{name: "0", value: stringPointer("0"), nodeEnv: "development", want: false},
		{name: "no", value: stringPointer("no"), nodeEnv: "development", want: false},
		{name: "n", value: stringPointer("n"), nodeEnv: "development", want: false},
		{name: "off with spaces", value: stringPointer(" off "), nodeEnv: "development", want: false},
		{name: "production with spaces is not production", value: nil, nodeEnv: " production ", want: true},
		{name: "production is case sensitive", value: nil, nodeEnv: "Production", want: true},
		{name: "invalid word", value: stringPointer("maybe"), nodeEnv: "development", wantErr: true},
		{name: "invalid number", value: stringPointer("2"), nodeEnv: "development", wantErr: true},
		{name: "invalid hyphen", value: stringPointer("-"), nodeEnv: "development", wantErr: true},
		{name: "invalid prefix", value: stringPointer("trueish"), nodeEnv: "development", wantErr: true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			getenv := func(key string) string {
				if key != swaggerEnabledEnv {
					t.Fatalf("unexpected getenv(%q)", key)
				}
				if tc.value == nil {
					return ""
				}
				return *tc.value
			}
			got, err := SwaggerEnabled(getenv, tc.nodeEnv)
			if tc.wantErr {
				if err == nil {
					t.Fatalf("SwaggerEnabled(%q, NODE_ENV=%q) = %t, want an error", valueOrUnset(tc.value), tc.nodeEnv, got)
				}
				if !strings.Contains(err.Error(), swaggerEnabledEnv) {
					t.Fatalf("error = %v, want it to name %s", err, swaggerEnabledEnv)
				}
				return
			}
			if err != nil {
				t.Fatalf("SwaggerEnabled(%q, NODE_ENV=%q): %v", valueOrUnset(tc.value), tc.nodeEnv, err)
			}
			if got != tc.want {
				t.Fatalf("SwaggerEnabled(%q, NODE_ENV=%q) = %t, want %t", valueOrUnset(tc.value), tc.nodeEnv, got, tc.want)
			}
		})
	}
}

// TestSwaggerEnabledTreatsANilGetterAsUnset keeps the helper safe when a wiring
// bug passes no getter.
func TestSwaggerEnabledTreatsANilGetterAsUnset(t *testing.T) {
	enabled, err := SwaggerEnabled(nil, "production")
	if err != nil || enabled {
		t.Fatalf("SwaggerEnabled(nil, production) = %t, %v, want false", enabled, err)
	}
	enabled, err = SwaggerEnabled(nil, "development")
	if err != nil || !enabled {
		t.Fatalf("SwaggerEnabled(nil, development) = %t, %v, want true", enabled, err)
	}
}

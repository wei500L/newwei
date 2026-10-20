package situationsettings

import (
	"encoding/json"
	"reflect"
	"strconv"
	"testing"
)

func TestAsBoundedIntRaw(t *testing.T) {
	cases := []struct {
		name     string
		raw      string
		fallback int
		want     int
	}{
		{"absent", ``, 7, 7},
		{"null becomes the minimum", `null`, 7, 1},
		{"number", `42`, 7, 42},
		{"float truncates", `42.9`, 7, 42},
		{"numeric string", `"4"`, 7, 4},
		{"hex string", `"0x10"`, 7, 16},
		{"true is one", `true`, 7, 1},
		{"false is one after clamping", `false`, 7, 1},
		{"single element array", `[9]`, 7, 9},
		{"empty array is zero", `[]`, 7, 1},
		{"unparseable keeps fallback", `"abc"`, 7, 7},
		{"object keeps fallback", `{}`, 7, 7},
		{"clamps high", `999`, 7, 100},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := asBoundedIntRaw(json.RawMessage(tc.raw), tc.fallback, 1, 100); got != tc.want {
				t.Fatalf("got %d want %d", got, tc.want)
			}
		})
	}
}

func TestAsBooleanRawOnlyAcceptsRealBooleans(t *testing.T) {
	if !asBooleanRaw(json.RawMessage(`true`), false) {
		t.Fatal("true should win")
	}
	if asBooleanRaw(json.RawMessage(`false`), true) {
		t.Fatal("false should win")
	}
	for _, raw := range []string{`"true"`, `1`, `null`, ``} {
		if !asBooleanRaw(json.RawMessage(raw), true) {
			t.Fatalf("%s should keep the fallback", raw)
		}
	}
}

func TestNormalizeStringRaw(t *testing.T) {
	cases := map[string]struct {
		want string
		ok   bool
	}{
		`"  value  "`: {"value", true},
		`"   "`:       {"", false},
		`null`:        {"", false},
		`5`:           {"", false},
	}
	for raw, want := range cases {
		got, ok := normalizeStringRaw(json.RawMessage(raw))
		if got != want.want || ok != want.ok {
			t.Fatalf("%s = %q,%v want %q,%v", raw, got, ok, want.want, want.ok)
		}
	}
}

func TestValidateURLErrors(t *testing.T) {
	if _, err := validateURL("ftp://example.test", "translationApiBaseUrl", "http", "https"); err == nil ||
		err.Error() != "translationApiBaseUrl must be a valid http(s) URL" {
		t.Fatalf("protocol error = %v", err)
	}
	if _, err := validateURL("not a url", "liveHlsProxyCnnUpstreamUrl", "https"); err == nil ||
		err.Error() != "liveHlsProxyCnnUpstreamUrl must be a valid https URL" {
		t.Fatalf("https error = %v", err)
	}
	normalized, err := validateURL("HTTPS://Example.Test/Path/", "liveHlsProxyCnnUpstreamUrl", "https")
	if err != nil {
		t.Fatal(err)
	}
	if normalized != "https://example.test/Path" {
		t.Fatalf("normalized = %q", normalized)
	}
}

func TestNormalizeHostListRaw(t *testing.T) {
	raw := json.RawMessage(`[" Example.Test ","example.test","bad:8080","path/test","ok.test"]`)
	want := []string{"example.test", "ok.test"}
	if got := normalizeHostListRaw(raw); !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v want %v", got, want)
	}
	if got := normalizeHostListRaw(json.RawMessage(`"not-an-array"`)); len(got) != 0 {
		t.Fatalf("non-array = %v", got)
	}
}

func TestParseHostCSV(t *testing.T) {
	got, err := parseHostCSV("Example.Test, example.test\ncdn.test", "liveHlsProxyCnnAllowedHosts")
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"example.test", "cdn.test"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v want %v", got, want)
	}

	many := ""
	for index := 0; index < 65; index++ {
		if index > 0 {
			many += ","
		}
		many += "host" + strconv.Itoa(index) + ".test"
	}
	if _, err := parseHostCSV(many, "liveHlsProxyCnnAllowedHosts"); err == nil ||
		err.Error() != "liveHlsProxyCnnAllowedHosts must have at most 64 hosts" {
		t.Fatalf("64-host error = %v", err)
	}
}

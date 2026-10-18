package situationsignals

import (
	"encoding/json"
	"testing"
)

func TestParsePositiveIntQuery(t *testing.T) {
	cases := []struct {
		name   string
		values []string
		valid  bool
		want   int
	}{
		{"absent", nil, false, 0},
		{"empty slice", []string{}, false, 0},
		{"single value", []string{"25"}, true, 25},
		{"padded", []string{" 25 "}, true, 25},
		{"fraction floors", []string{"25.9"}, true, 25},
		{"zero is out of bounds", []string{"0"}, false, 0},
		{"negative is out of bounds", []string{"-3"}, false, 0},
		{"above max is out of bounds", []string{"201"}, false, 0},
		{"max is accepted", []string{"200"}, true, 200},
		{"one is accepted", []string{"1"}, true, 1},
		{"blank is rejected", []string{"   "}, false, 0},
		{"nan string is rejected", []string{"abc"}, false, 0},
		{"hex string is accepted by Number()", []string{"0x10"}, true, 16},
		{"exponent is accepted", []string{"2e2"}, true, 200},
		{"repeated parameter is an array", []string{"10", "20"}, false, 0},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, ok := parsePositiveIntQuery(tc.values, 1, monitorLimit)
			if ok != tc.valid {
				t.Fatalf("valid = %v, want %v (value %d)", ok, tc.valid, got)
			}
			if ok && got != tc.want {
				t.Fatalf("got %d, want %d", got, tc.want)
			}
		})
	}
}

func TestSingleQueryString(t *testing.T) {
	if value, ok := singleQueryString([]string{"cnn"}); !ok || value != "cnn" {
		t.Fatalf("single = %q/%v", value, ok)
	}
	if _, ok := singleQueryString([]string{"cnn", "cnbc"}); ok {
		t.Fatal("a repeated parameter must be ignored")
	}
	if _, ok := singleQueryString(nil); ok {
		t.Fatal("an absent parameter must be ignored")
	}
}

func TestFormatIDTitle(t *testing.T) {
	cases := map[string]string{
		"tariffs":        "Tariffs",
		"fed-rates":      "Fed Rates",
		"china-tensions": "China Tensions",
		"deep-state":     "Deep State",
		"next-pandemic":  "Next Pandemic",
	}
	for input, want := range cases {
		if got := formatIDTitle(input); got != want {
			t.Fatalf("%s: got %q, want %q", input, got, want)
		}
	}
}

func TestCatalogStaticLists(t *testing.T) {
	if len(narrativePatterns) != 16 {
		t.Fatalf("narratives = %d", len(narrativePatterns))
	}
	if len(correlationTopics) != 20 {
		t.Fatalf("correlations = %d", len(correlationTopics))
	}
	response := catalogResponse{}
	for _, entry := range narrativePatterns {
		response.Narratives = append(response.Narratives, catalogNarrative{
			ID: entry.id, Name: formatIDTitle(entry.id), Category: entry.category, Severity: entry.severity,
		})
	}
	raw, err := response.encodeJSON()
	if err != nil {
		t.Fatal(err)
	}
	var decoded struct {
		Narratives []struct {
			ID       string `json:"id"`
			Name     string `json:"name"`
			Category string `json:"category"`
			Severity string `json:"severity"`
		} `json:"narratives"`
	}
	if err := json.Unmarshal(raw, &decoded); err != nil {
		t.Fatal(err)
	}
	if decoded.Narratives[0].ID != "deep-state" || decoded.Narratives[0].Name != "Deep State" ||
		decoded.Narratives[0].Category != "Political" || decoded.Narratives[0].Severity != "watch" {
		t.Fatalf("first narrative = %+v", decoded.Narratives[0])
	}
	if decoded.Narratives[15].ID != "energy-war" || decoded.Narratives[15].Severity != "spreading" {
		t.Fatalf("last narrative = %+v", decoded.Narratives[15])
	}
}

func TestIsLiveHLSProxyChannel(t *testing.T) {
	if !isLiveHLSProxyChannel("cnn") || !isLiveHLSProxyChannel("cnbc") {
		t.Fatal("cnn and cnbc are the legal channels")
	}
	for _, value := range []string{"", "CNN", "cnn ", "fox", "cnbc2"} {
		if isLiveHLSProxyChannel(value) {
			t.Fatalf("%q must not be a legal channel", value)
		}
	}
}

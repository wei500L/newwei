package usersettingswrite

import (
	"strings"
	"testing"

	"github.com/wei500L/newwei/apps/api-go/internal/usersettings"
	"github.com/wei500L/newwei/apps/api-go/internal/usersettingsread"
)

func TestPlanEmptyObjectDoesNotWrite(t *testing.T) {
	for _, path := range usersettingsread.Paths {
		segments, err := Plan(path, []byte(`{}`))
		if err != nil {
			t.Fatalf("%s: %v", path, err)
		}
		if len(segments) != 0 {
			t.Fatalf("%s: segments = %d, want 0（字段缺失不 upsert）", path, len(segments))
		}
	}
}

func TestPlanExplicitNullWritesNormalizedDefault(t *testing.T) {
	segments, err := Plan(usersettingsread.Paths[0], []byte(`{"settings":null}`))
	if err != nil {
		t.Fatal(err)
	}
	if len(segments) != 1 || segments[0].Key != usersettings.OnboardingKey {
		t.Fatalf("segments = %+v, want one onboarding upsert", segments)
	}
	if !strings.Contains(string(segments[0].Value), `"completed":false`) {
		t.Fatalf("stored = %s, want normalized default", segments[0].Value)
	}
}

func TestPlanWrongTypeAndUnknownFieldAreDistinct(t *testing.T) {
	cases := []struct {
		name string
		body string
		want string
	}{
		{"wrong type", `{"settings":[]}`, "settings must be an object"},
		{"unknown field", `{"extra":1}`, "property extra should not exist"},
		{"both, property error then whitelist", `{"settings":"x","extra":1}`, "settings must be an object; property extra should not exist"},
		{"unknown field order", `{"zzz":1,"aaa":2}`, "property zzz should not exist; property aaa should not exist"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := Plan(usersettingsread.Paths[0], []byte(tc.body))
			input, ok := err.(*inputError)
			if !ok {
				t.Fatalf("err = %v, want inputError", err)
			}
			if input.Message != tc.want {
				t.Fatalf("message = %q, want %q", input.Message, tc.want)
			}
		})
	}
}

func TestPlanSituationMonitorWritesOnlyPresentSegments(t *testing.T) {
	segments, err := Plan(usersettingsread.Paths[5], []byte(`{"settings":{"windowHours":6}}`))
	if err != nil {
		t.Fatal(err)
	}
	if len(segments) != 1 || segments[0].Key != usersettings.SituationMonitorSettingsKey {
		t.Fatalf("segments = %+v, want only settings key", segments)
	}

	segments, err = Plan(usersettingsread.Paths[5], []byte(`{"monitors":null,"layout":{}}`))
	if err != nil {
		t.Fatal(err)
	}
	if len(segments) != 2 ||
		segments[0].Key != usersettings.SituationMonitorMonitorsKey ||
		segments[1].Key != usersettings.SituationMonitorLayoutKey {
		t.Fatalf("segments = %+v, want monitors then layout", segments)
	}
	if string(segments[0].Value) != "[]" {
		t.Fatalf("null monitors stored %s, want []", segments[0].Value)
	}
}

func TestPlanSituationMonitorRejectsWrongMonitorsType(t *testing.T) {
	_, err := Plan(usersettingsread.Paths[5], []byte(`{"monitors":{}}`))
	input, ok := err.(*inputError)
	if !ok || input.Message != "monitors must be an array" {
		t.Fatalf("err = %v, want monitors must be an array", err)
	}
}

func TestPlanNonObjectBodyDoesNotWrite(t *testing.T) {
	for _, body := range []string{`null`, `[]`, `"x"`, `1`, `true`} {
		segments, err := Plan(usersettingsread.Paths[1], []byte(body))
		if err != nil {
			t.Fatalf("%s: %v", body, err)
		}
		if len(segments) != 0 {
			t.Fatalf("%s: segments = %d, want 0", body, len(segments))
		}
	}
}

func TestPlanPresentSettingsUsesExistingNormalizer(t *testing.T) {
	segments, err := Plan(usersettingsread.Paths[1], []byte(`{"settings":{"translationProvider":"llm","translationEnabled":true}}`))
	if err != nil {
		t.Fatal(err)
	}
	if len(segments) != 1 || segments[0].Key != usersettings.RSSReaderKey {
		t.Fatalf("segments = %+v", segments)
	}
	stored := string(segments[0].Value)
	if !strings.Contains(stored, `"translationProvider":"llm"`) || !strings.Contains(stored, `"translationEnabled":true`) {
		t.Fatalf("stored = %s", stored)
	}
}

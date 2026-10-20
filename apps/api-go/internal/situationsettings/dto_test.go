package situationsettings

import (
	"strings"
	"testing"
)

func TestParseUpdateSettingsRequiresTranslationMaxConcurrency(t *testing.T) {
	_, err := parseUpdateSettings([]byte(`{}`))
	if err == nil {
		t.Fatal("expected validation error")
	}
	want := "translationMaxConcurrency must not be greater than 5000; " +
		"translationMaxConcurrency must not be less than 1; " +
		"translationMaxConcurrency must be an integer number"
	if err.Error() != want {
		t.Fatalf("message = %q", err.Error())
	}
}

func TestParseUpdateSettingsRejectsUnknownPropertyFirst(t *testing.T) {
	_, err := parseUpdateSettings([]byte(`{"unknown":true,"translationMaxConcurrency":"2"}`))
	if err == nil {
		t.Fatal("expected validation error")
	}
	want := "property unknown should not exist; translationMaxConcurrency must not be greater than 5000; " +
		"translationMaxConcurrency must not be less than 1; " +
		"translationMaxConcurrency must be an integer number"
	if err.Error() != want {
		t.Fatalf("message = %q", err.Error())
	}
}

func TestParseUpdateSettingsOptionalTypesAndRanges(t *testing.T) {
	body := `{
		"translationMaxConcurrency": 2,
		"translationApiEnabled": "true",
		"translationApiBaseUrl": 5,
		"translationApiTimeoutMs": 999,
		"telegramMaxFeedItems": 600,
		"telegramChannelSet": null
	}`
	_, err := parseUpdateSettings([]byte(body))
	if err == nil {
		t.Fatal("expected validation error")
	}
	want := "translationApiEnabled must be a boolean value; translationApiBaseUrl must be a string; " +
		"translationApiTimeoutMs must not be less than 1000; telegramMaxFeedItems must not be greater than 500"
	if err.Error() != want {
		t.Fatalf("message = %q", err.Error())
	}
}

func TestParseUpdateSettingsAcceptsNullOptionalsAndPreservesTriState(t *testing.T) {
	input, err := parseUpdateSettings([]byte(`{
		"translationMaxConcurrency": 3,
		"translationApiKey": null,
		"finnhubApiKey": "",
		"telegramEnabled": false
	}`))
	if err != nil {
		t.Fatal(err)
	}
	if input.TranslationMaxConcurrency != 3 {
		t.Fatalf("max concurrency = %d", input.TranslationMaxConcurrency)
	}
	if input.TranslationAPIKey.state != presenceNull {
		t.Fatalf("translationApiKey state = %d", input.TranslationAPIKey.state)
	}
	if input.FinnhubAPIKey.state != presenceValue || input.FinnhubAPIKey.value != "" {
		t.Fatalf("finnhubApiKey = %+v", input.FinnhubAPIKey)
	}
	if input.FredAPIKey.state != presenceMissing {
		t.Fatalf("fredApiKey state = %d", input.FredAPIKey.state)
	}
	if input.TelegramEnabled.state != presenceValue || input.TelegramEnabled.value {
		t.Fatalf("telegramEnabled = %+v", input.TelegramEnabled)
	}
}

func TestParseUpdateSettingsDuplicateKeyUsesLast(t *testing.T) {
	input, err := parseUpdateSettings([]byte(`{"translationMaxConcurrency":2,"translationMaxConcurrency":4}`))
	if err != nil {
		t.Fatal(err)
	}
	if input.TranslationMaxConcurrency != 4 {
		t.Fatalf("duplicate key = %d", input.TranslationMaxConcurrency)
	}
}

func TestParseUpdateSettingsRejectsNonObject(t *testing.T) {
	_, err := parseUpdateSettings([]byte(`[]`))
	if err == nil || !strings.Contains(err.Error(), "Invalid request body") {
		t.Fatalf("err = %v", err)
	}
}

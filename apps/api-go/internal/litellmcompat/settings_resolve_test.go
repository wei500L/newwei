package litellmcompat

import (
	"encoding/hex"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/settingscrypto"
)

// These tests pin the shared profile resolver that replaced the per-package
// normalizeProfile/decryptSecret/normalizeAPIBase/applyGovernance copies.

func TestResolveProfileFromSettingsDecryptsAndNormalizes(t *testing.T) {
	key := make([]byte, 32)
	for index := range key {
		key[index] = byte(index)
	}
	envelope, err := settingscrypto.Encrypt("sk-live", key)
	if err != nil {
		t.Fatal(err)
	}
	apiKeyJSON, err := json.Marshal(envelope)
	if err != nil {
		t.Fatal(err)
	}
	profiles := []byte(`{"activeId":"p1","profiles":[{"id":"p1","model":"m1","apiBase":"http://gw.example/v1","apiKey":` +
		string(apiKeyJSON) + `,"maxRetries":2,"timeoutMs":1500,"topP":0.7,"temperature":0.3}]}`)

	profile, err := ResolveProfileFromSettings(ProfileCompletion, profiles, nil, Config{EncryptionKey: hex.EncodeToString(key)})
	if err != nil {
		t.Fatal(err)
	}
	if profile.ID != "p1" || profile.Model != "m1" {
		t.Fatalf("profile = %+v", profile)
	}
	if profile.APIKey != "sk-live" {
		t.Fatalf("apiKey = %q", profile.APIKey)
	}
	if profile.APIBase != "http://gw.example" {
		t.Fatalf("apiBase = %q", profile.APIBase)
	}
	if profile.MaxRetries != 2 || profile.Timeout != 1500*time.Millisecond {
		t.Fatalf("retries/timeout = %d/%v", profile.MaxRetries, profile.Timeout)
	}
	if profile.TopP != 0.7 || profile.Temperature != 0.3 {
		t.Fatalf("topP/temperature = %v/%v", profile.TopP, profile.Temperature)
	}
}

func TestResolveProfileFromSettingsAppliesGovernance(t *testing.T) {
	profiles := []byte(`{"activeId":"p1","profiles":[{"id":"p1","model":"m1","apiBase":"http://gw.example","apiKey":"old-key"}]}`)
	governance := []byte(`{"enabled":true,"targetProfileId":"p1","managedRuntimeKey":"Bearer sk-managed"}`)

	profile, err := ResolveProfileFromSettings(ProfileCompletion, profiles, governance, Config{})
	if err != nil {
		t.Fatal(err)
	}
	if !profile.GovernanceApplied || profile.AuthMode != "managed_runtime_key" || profile.GovernanceTargetProfileID != "p1" {
		t.Fatalf("governance = %+v", profile)
	}
	if profile.APIKey != "sk-managed" {
		t.Fatalf("managed apiKey = %q", profile.APIKey)
	}
}

func TestResolveProfileFromSettingsGovernanceUnreadable(t *testing.T) {
	profiles := []byte(`{"activeId":"p1","profiles":[{"id":"p1","model":"m1","apiBase":"http://gw.example","apiKey":"old-key"}]}`)
	governance := []byte(`{"enabled":true,"targetProfileId":"p1","managedRuntimeKey":{"__enc":"system-settings:v1","alg":"aes-256-gcm","iv":"AA==","tag":"AA==","data":"AA=="}}`)

	_, err := ResolveProfileFromSettings(ProfileCompletion, profiles, governance, Config{})
	var governanceErr *GovernanceError
	if !errors.As(err, &governanceErr) {
		t.Fatalf("err = %v", err)
	}
}

func TestResolveProfileFromSettingsRerankAllowsEmptyModel(t *testing.T) {
	profiles := []byte(`{"activeId":"p1","profiles":[` +
		`{"id":"p1","model":"","apiBase":"http://gw.example","rerankModel":"rr-1"},` +
		`{"id":"p2","model":"m2","apiBase":"http://gw.example","rerankModel":"rr-2"}]}`)

	profile, err := ResolveProfileFromSettings(ProfileRerank, profiles, nil, Config{})
	if err != nil {
		t.Fatal(err)
	}
	if profile.ID != "p1" || profile.RerankModel != "rr-1" {
		t.Fatalf("profile = %+v", profile)
	}
}

func TestResolveProfileFromSettingsCompletionUnavailable(t *testing.T) {
	_, err := ResolveProfileFromSettings(ProfileCompletion, nil, nil, Config{})
	if !errors.Is(err, ErrCompletionUnavailable) {
		t.Fatalf("err = %v", err)
	}
}

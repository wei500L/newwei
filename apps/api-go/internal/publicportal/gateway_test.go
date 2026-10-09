package publicportal

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestGatewayCompletionUsesConfiguredProfile(t *testing.T) {
	var gotAuth, gotPath string
	var gotBody map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		gotPath = r.URL.Path
		raw, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(raw, &gotBody)
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"{\"detailed_summary\":\"Detail.\",\"tldr\":\"Short.\"}"}}]}`))
	}))
	defer server.Close()

	store := &fakeStore{gatewayJSON: []byte(`{
		"activeId":"profile-1",
		"profiles":[{
			"id":"profile-1",
			"model":"openai/gpt-4o-mini",
			"apiBase":"` + server.URL + `",
			"apiKey":"secret-key",
			"enabled":true,
			"maxRetries":1,
			"timeoutMs":5000,
			"responseFormatMode":"json_schema",
			"apiSurface":"chat_completions"
		}]
	}`)}
	client := newGateway(store, GatewayEnv{MaxRetries: 1, TimeoutMs: 5000})
	content, err := client.Complete(context.Background(), completionRequest{
		System:   "system",
		User:     "user",
		Metadata: map[string]any{"feature": "news_event_brief"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(content, "detailed_summary") {
		t.Fatalf("content = %s", content)
	}
	if gotAuth != "Bearer secret-key" {
		t.Fatalf("auth = %s", gotAuth)
	}
	if gotPath != "/v1/chat/completions" {
		t.Fatalf("path = %s", gotPath)
	}
	if gotBody["temperature"] != 0.2 || gotBody["max_tokens"] != float64(1200) {
		t.Fatalf("body = %#v", gotBody)
	}
	format, _ := gotBody["response_format"].(map[string]any)
	schema, _ := format["json_schema"].(map[string]any)
	if schema["name"] != "news_event_brief_v1" {
		t.Fatalf("format = %#v", format)
	}
}

func TestDecryptSettingsSecretRoundTrip(t *testing.T) {
	key := bytes32()
	payload := encryptForTest("sk-live", key)
	plain, err := decryptSecret(payload, base64.StdEncoding.EncodeToString(key))
	if err != nil || plain != "sk-live" {
		t.Fatalf("plain = %q err=%v", plain, err)
	}
	encoded, _ := json.Marshal(payload)
	var asMap map[string]any
	if err := json.Unmarshal(encoded, &asMap); err != nil {
		t.Fatal(err)
	}
	if profileAPIKey(asMap, base64.StdEncoding.EncodeToString(key)) != "sk-live" {
		t.Fatal("profile key")
	}
	if profileAPIKey(asMap, "") != "" {
		t.Fatal("missing encryption key must not yield a plaintext key")
	}
}

func TestGovernanceMissingKeyFailsClosed(t *testing.T) {
	_, err := resolveCompletionProfile([]byte(`{
		"activeId":"profile-1",
		"profiles":[{"id":"profile-1","model":"m","apiBase":"http://gateway.example","apiKey":"profile-key","enabled":true}]
	}`), []byte(`{"enabled":true,"targetProfileId":"profile-1"}`), GatewayEnv{})
	status, ok := err.(*StatusError)
	if !ok || status.Code != http.StatusServiceUnavailable {
		t.Fatalf("err = %v", err)
	}
}

func bytes32() []byte {
	key := make([]byte, 32)
	_, _ = rand.Read(key)
	return key
}

func encryptForTest(plain string, key []byte) map[string]any {
	block, err := aes.NewCipher(key)
	if err != nil {
		panic(err)
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		panic(err)
	}
	iv := make([]byte, gcm.NonceSize())
	_, _ = rand.Read(iv)
	sealed := gcm.Seal(nil, iv, []byte(plain), nil)
	tag := sealed[len(sealed)-gcm.Overhead():]
	data := sealed[:len(sealed)-gcm.Overhead()]
	return map[string]any{
		"__enc": "system-settings:v1",
		"alg":   "aes-256-gcm",
		"iv":    base64.StdEncoding.EncodeToString(iv),
		"tag":   base64.StdEncoding.EncodeToString(tag),
		"data":  base64.StdEncoding.EncodeToString(data),
	}
}

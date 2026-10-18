package llmgatewayops

import (
	"context"
	"encoding/json"
	"sync"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/llmgatewayprofiles"
	"github.com/wei500L/newwei/apps/api-go/internal/llmlogs"
)

// fakeProfilePort is the typed profile double: it returns fixed profiles and
// records nothing but the encoded secrets.
type fakeProfilePort struct {
	profiles     map[string]llmgatewayprofiles.ResolvedProfileConfig
	bindings     llmgatewayprofiles.RuntimeBindings
	decryptValue string
	decryptOK    bool
}

// RuntimeProfileConfig returns one configured profile.
func (f *fakeProfilePort) RuntimeProfileConfig(_ context.Context, id string) (llmgatewayprofiles.ResolvedProfileConfig, bool, error) {
	profile, ok := f.profiles[id]
	return profile, ok, nil
}

// RuntimeBindings returns the configured binding snapshot.
func (f *fakeProfilePort) RuntimeBindings(context.Context) (llmgatewayprofiles.RuntimeBindings, error) {
	return f.bindings, nil
}

// EncodeSecretForStorage stores the plaintext as a plaintext secret value.
func (f *fakeProfilePort) EncodeSecretForStorage(_ context.Context, plain string) (*llmgatewayprofiles.SecretValue, error) {
	raw, err := json.Marshal(plain)
	if err != nil {
		return nil, err
	}
	var value llmgatewayprofiles.SecretValue
	if err := json.Unmarshal(raw, &value); err != nil {
		return nil, err
	}
	return &value, nil
}

// DecryptSecretEnvelope reports the configured decryption outcome.
func (f *fakeProfilePort) DecryptSecretEnvelope(llmgatewayprofiles.EncryptedStringValueV1) (string, bool) {
	return f.decryptValue, f.decryptOK
}

// fakeLogWriter stores every probe row in memory.
type fakeLogWriter struct {
	mu      sync.Mutex
	entries []llmlogs.ProbeLogEntry
}

// WriteProbe records one row.
func (f *fakeLogWriter) WriteProbe(_ context.Context, entry llmlogs.ProbeLogEntry) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.entries = append(f.entries, entry)
	return nil
}

// snapshot returns a copy of the recorded rows.
func (f *fakeLogWriter) snapshot() []llmlogs.ProbeLogEntry {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]llmlogs.ProbeLogEntry, len(f.entries))
	copy(out, f.entries)
	return out
}

// fixedClock is the deterministic clock of every test service.
func fixedClock() time.Time { return time.Date(2026, 10, 18, 20, 27, 40, 0, time.UTC) }

// newTestService builds a Service over the fakes with a fixed clock.
func newTestService(port ProfilePort, logs ProbeLogWriter) *Service {
	return &Service{
		profiles: port,
		logs:     logs,
		http:     newUpstreamHTTPClient(),
		cfg:      Config{MasterKey: "sk-master"},
		now:      fixedClock,
	}
}

// profileConfig builds a minimal saved profile.
func profileConfig(id, apiBase, model string) llmgatewayprofiles.ResolvedProfileConfig {
	return llmgatewayprofiles.ResolvedProfileConfig{
		ID:                 id,
		Name:               id,
		Enabled:            true,
		APIBase:            apiBase,
		APIKey:             "sk-profile",
		HasAPIKey:          true,
		Model:              model,
		TimeoutMs:          5_000,
		Temperature:        0.2,
		TopP:               0.9,
		MaxOutputTokens:    1_200,
		ResponseFormatMode: llmgatewayprofiles.ResponseFormatJSONSchema,
		APISurface:         llmgatewayprofiles.APISurfaceChatCompletions,
	}
}

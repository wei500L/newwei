package llmgatewayprofiles

import (
	"bytes"
	"encoding/json"
	"errors"
)

// EncryptionTag and EncryptionAlgorithm are the two envelope constants of the
// system-settings:v1 secret protocol.
const (
	// EncryptionTag is stored in the __enc field.
	EncryptionTag = "system-settings:v1"
	// EncryptionAlgorithm is stored in the alg field.
	EncryptionAlgorithm = "aes-256-gcm"
)

// EncryptedStringValueV1 is the AES-256-GCM envelope NestJS writes for
// encrypted settings secrets. Field order matches the TypeScript object literal
// so a rewritten document keeps the same key order.
type EncryptedStringValueV1 struct {
	Enc  string `json:"__enc"`
	Alg  string `json:"alg"`
	IV   string `json:"iv"`
	Tag  string `json:"tag"`
	Data string `json:"data"`
}

// envelopeProbe is the tolerant decode boundary used to decide whether an
// unknown JSON value is a v1 envelope.
type envelopeProbe struct {
	Enc  json.RawMessage `json:"__enc"`
	Alg  json.RawMessage `json:"alg"`
	IV   json.RawMessage `json:"iv"`
	Tag  json.RawMessage `json:"tag"`
	Data json.RawMessage `json:"data"`
}

// SecretValue is the apiKey slot of one stored profile. It is a discriminated
// union so an unrecognised legacy value is preserved exactly instead of being
// dropped or coerced.
type SecretValue struct {
	kind      SecretKind
	plaintext string
	encrypted EncryptedStringValueV1
	opaque    json.RawMessage
}

// newPlaintextSecret builds a plaintext secret value.
func newPlaintextSecret(text string) *SecretValue {
	return &SecretValue{kind: SecretPlaintext, plaintext: text}
}

// newEncryptedSecret builds a v1 envelope secret value.
func newEncryptedSecret(envelope EncryptedStringValueV1) *SecretValue {
	return &SecretValue{kind: SecretEncrypted, encrypted: envelope}
}

// newNullSecret builds an explicit JSON null secret value.
func newNullSecret() *SecretValue {
	return &SecretValue{kind: SecretNull}
}

// newOpaqueSecret preserves any other JSON value byte-for-byte.
func newOpaqueSecret(raw json.RawMessage) *SecretValue {
	cloned := make([]byte, len(raw))
	copy(cloned, raw)
	return &SecretValue{kind: SecretOpaque, opaque: cloned}
}

// Kind reports the discriminated secret kind.
func (s *SecretValue) Kind() SecretKind {
	if s == nil {
		return SecretAbsent
	}
	return s.kind
}

// Plaintext returns the stored plaintext string, if any.
func (s *SecretValue) Plaintext() (string, bool) {
	if s == nil || s.kind != SecretPlaintext {
		return "", false
	}
	return s.plaintext, true
}

// Envelope returns the stored v1 envelope, if any.
func (s *SecretValue) Envelope() (EncryptedStringValueV1, bool) {
	if s == nil || s.kind != SecretEncrypted {
		return EncryptedStringValueV1{}, false
	}
	return s.encrypted, true
}

// MarshalJSON renders the stored JSON shape. A nil SecretValue never reaches
// this method because the profile field is an omitempty pointer.
func (s *SecretValue) MarshalJSON() ([]byte, error) {
	if s == nil {
		return []byte("null"), nil
	}
	switch s.kind {
	case SecretPlaintext:
		return json.Marshal(s.plaintext)
	case SecretEncrypted:
		return json.Marshal(s.encrypted)
	case SecretOpaque:
		if len(s.opaque) == 0 {
			return []byte("null"), nil
		}
		return s.opaque, nil
	default:
		return []byte("null"), nil
	}
}

// UnmarshalJSON decodes one stored apiKey value into the discriminated union.
func (s *SecretValue) UnmarshalJSON(data []byte) error {
	decoded := decodeSecretValue(json.RawMessage(data))
	if decoded == nil {
		*s = SecretValue{kind: SecretAbsent}
		return nil
	}
	*s = *decoded
	return nil
}

// decodeSecretValue classifies one raw JSON apiKey value.
func decodeSecretValue(raw json.RawMessage) *SecretValue {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 {
		return nil
	}
	if bytes.Equal(trimmed, []byte("null")) {
		return newNullSecret()
	}
	if trimmed[0] == '"' {
		var text string
		if err := json.Unmarshal(trimmed, &text); err != nil {
			return newOpaqueSecret(trimmed)
		}
		return newPlaintextSecret(text)
	}
	if trimmed[0] == '{' {
		if envelope, ok := decodeEnvelope(trimmed); ok {
			return newEncryptedSecret(envelope)
		}
	}
	return newOpaqueSecret(trimmed)
}

// decodeEnvelope reports whether the object is exactly a v1 envelope.
func decodeEnvelope(raw json.RawMessage) (EncryptedStringValueV1, bool) {
	var probe envelopeProbe
	if err := json.Unmarshal(raw, &probe); err != nil {
		return EncryptedStringValueV1{}, false
	}
	tag, ok := jsString(probe.Enc)
	if !ok || tag != EncryptionTag {
		return EncryptedStringValueV1{}, false
	}
	algorithm, ok := jsString(probe.Alg)
	if !ok || algorithm != EncryptionAlgorithm {
		return EncryptedStringValueV1{}, false
	}
	iv, ok := jsString(probe.IV)
	if !ok {
		return EncryptedStringValueV1{}, false
	}
	tag64, ok := jsString(probe.Tag)
	if !ok {
		return EncryptedStringValueV1{}, false
	}
	data, ok := jsString(probe.Data)
	if !ok {
		return EncryptedStringValueV1{}, false
	}
	return EncryptedStringValueV1{
		Enc:  EncryptionTag,
		Alg:  EncryptionAlgorithm,
		IV:   iv,
		Tag:  tag64,
		Data: data,
	}, true
}

// NullableBool is a tri-state JSON boolean. The NestJS service can persist an
// explicit null for assistantWebSearchEnabled/sendMetadata (it assigns
// input.value when the key is present, even when the value is null), and the
// immediately returned create/update profile keeps that null until the next
// list normalises it back to false/true.
type NullableBool struct {
	// Null reports an explicit JSON null.
	Null bool
	// Value is the boolean value when Null is false.
	Value bool
}

// boolNullable builds a present boolean.
func boolNullable(value bool) NullableBool {
	return NullableBool{Value: value}
}

// nullNullable builds an explicit JSON null.
func nullNullable() NullableBool {
	return NullableBool{Null: true}
}

// MarshalJSON renders null or a real JSON boolean.
func (n NullableBool) MarshalJSON() ([]byte, error) {
	if n.Null {
		return []byte("null"), nil
	}
	if n.Value {
		return []byte("true"), nil
	}
	return []byte("false"), nil
}

// StoredProfile is the normalized profile document persisted inside
// SystemSetting.value.profiles. Field order matches the NestJS normalizeProfile
// object literal so a rewritten document keeps its key order.
type StoredProfile struct {
	ID                        string             `json:"id"`
	Name                      string             `json:"name"`
	APIBase                   string             `json:"apiBase"`
	APIKey                    *SecretValue       `json:"apiKey,omitempty"`
	Model                     string             `json:"model"`
	EmbeddingModel            *string            `json:"embeddingModel,omitempty"`
	RerankModel               *string            `json:"rerankModel,omitempty"`
	RerankFallbackModels      []string           `json:"rerankFallbackModels"`
	AssistantModel            *string            `json:"assistantModel,omitempty"`
	AssistantWebSearchEnabled NullableBool       `json:"assistantWebSearchEnabled"`
	TimeoutMs                 float64            `json:"timeoutMs"`
	Temperature               float64            `json:"temperature"`
	TopP                      float64            `json:"topP"`
	MaxOutputTokens           float64            `json:"maxOutputTokens"`
	MaxRetries                float64            `json:"maxRetries"`
	FallbackModels            []string           `json:"fallbackModels"`
	SendMetadata              NullableBool       `json:"sendMetadata"`
	ResponseFormatMode        ResponseFormatMode `json:"responseFormatMode"`
	APISurface                APISurface         `json:"apiSurface"`
	Enabled                   bool               `json:"enabled"`
	CreatedAt                 string             `json:"createdAt"`
	UpdatedAt                 string             `json:"updatedAt"`
}

// StoredSettings is the normalized SystemSetting.value document.
type StoredSettings struct {
	ActiveID          *string         `json:"activeId"`
	EmbeddingActiveID *string         `json:"embeddingActiveId"`
	EmbeddingMode     EmbeddingMode   `json:"embeddingMode"`
	RerankActiveID    *string         `json:"rerankActiveId"`
	RerankMode        RerankMode      `json:"rerankMode"`
	Profiles          []StoredProfile `json:"profiles"`
}

// rawStoredSettings is the tolerant decode boundary for one SystemSetting.value
// document. Every field is a raw token so a legacy non-string or non-array value
// degrades through the same normalisation rules as NestJS instead of failing the
// whole decode.
type rawStoredSettings struct {
	ActiveID          json.RawMessage `json:"activeId"`
	EmbeddingActiveID json.RawMessage `json:"embeddingActiveId"`
	EmbeddingMode     json.RawMessage `json:"embeddingMode"`
	RerankActiveID    json.RawMessage `json:"rerankActiveId"`
	RerankMode        json.RawMessage `json:"rerankMode"`
	Profiles          json.RawMessage `json:"profiles"`
}

// rawStoredProfile is the tolerant decode boundary for one stored profile.
type rawStoredProfile struct {
	ID                        json.RawMessage `json:"id"`
	Name                      json.RawMessage `json:"name"`
	APIBase                   json.RawMessage `json:"apiBase"`
	APIKey                    json.RawMessage `json:"apiKey"`
	Model                     json.RawMessage `json:"model"`
	EmbeddingModel            json.RawMessage `json:"embeddingModel"`
	RerankModel               json.RawMessage `json:"rerankModel"`
	RerankFallbackModels      json.RawMessage `json:"rerankFallbackModels"`
	AssistantModel            json.RawMessage `json:"assistantModel"`
	AssistantWebSearchEnabled json.RawMessage `json:"assistantWebSearchEnabled"`
	TimeoutMs                 json.RawMessage `json:"timeoutMs"`
	Temperature               json.RawMessage `json:"temperature"`
	TopP                      json.RawMessage `json:"topP"`
	MaxOutputTokens           json.RawMessage `json:"maxOutputTokens"`
	MaxRetries                json.RawMessage `json:"maxRetries"`
	FallbackModels            json.RawMessage `json:"fallbackModels"`
	SendMetadata              json.RawMessage `json:"sendMetadata"`
	ResponseFormatMode        json.RawMessage `json:"responseFormatMode"`
	APISurface                json.RawMessage `json:"apiSurface"`
	Enabled                   json.RawMessage `json:"enabled"`
	CreatedAt                 json.RawMessage `json:"createdAt"`
	UpdatedAt                 json.RawMessage `json:"updatedAt"`
}

// PublicProfile is the profile projection returned by every endpoint. It never
// contains the apiKey, its ciphertext or any secret fingerprint.
type PublicProfile struct {
	ID                        string             `json:"id"`
	Name                      string             `json:"name"`
	Model                     string             `json:"model"`
	EmbeddingModel            *string            `json:"embeddingModel,omitempty"`
	RerankModel               *string            `json:"rerankModel,omitempty"`
	AssistantModel            *string            `json:"assistantModel,omitempty"`
	AssistantWebSearchEnabled NullableBool       `json:"assistantWebSearchEnabled"`
	APIBase                   string             `json:"apiBase"`
	TimeoutMs                 float64            `json:"timeoutMs"`
	Temperature               float64            `json:"temperature"`
	TopP                      float64            `json:"topP"`
	MaxOutputTokens           float64            `json:"maxOutputTokens"`
	MaxRetries                float64            `json:"maxRetries"`
	FallbackModels            []string           `json:"fallbackModels"`
	RerankFallbackModels      []string           `json:"rerankFallbackModels"`
	SendMetadata              NullableBool       `json:"sendMetadata"`
	ResponseFormatMode        ResponseFormatMode `json:"responseFormatMode"`
	APISurface                APISurface         `json:"apiSurface"`
	Enabled                   bool               `json:"enabled"`
	CreatedAt                 string             `json:"createdAt"`
	UpdatedAt                 string             `json:"updatedAt"`
	HasAPIKey                 bool               `json:"hasApiKey"`
}

// SettingsPublic is the full settings projection returned by the list and the
// three activation endpoints.
type SettingsPublic struct {
	ActiveID          *string         `json:"activeId"`
	EmbeddingActiveID *string         `json:"embeddingActiveId"`
	EmbeddingMode     EmbeddingMode   `json:"embeddingMode"`
	RerankActiveID    *string         `json:"rerankActiveId"`
	RerankMode        RerankMode      `json:"rerankMode"`
	Profiles          []PublicProfile `json:"profiles"`
}

// deleteResponse is the {"ok":true} body DELETE returns.
type deleteResponse struct {
	OK bool `json:"ok"`
}

// profileIdentity carries the immutable identity fields of a build.
type profileIdentity struct {
	ID        string
	CreatedAt string
	UpdatedAt string
}

// profileDefaults carries the per-field fallbacks of buildProfileFromInput.
// Create fills them from the effective LITELLM_* environment configuration;
// update fills them from the existing normalized profile, exactly like the
// NestJS call that passes the environment config on create and the existing
// profile on update.
type profileDefaults struct {
	APIBase                   string
	AssistantModel            *string
	TimeoutMs                 float64
	Temperature               float64
	TopP                      float64
	MaxOutputTokens           float64
	MaxRetries                float64
	AssistantWebSearchEnabled bool
	SendMetadata              bool
	ResponseFormatMode        ResponseFormatMode
	APISurface                APISurface
}

// profileInput is the validated request projection. Every optional field keeps a
// separate "present" flag because the NestJS service distinguishes an absent key
// (undefined) from an explicit null on several fields.
type profileInput struct {
	Name    *string
	APIBase *string
	Model   *string

	APIKeySet bool
	APIKey    *string

	EmbeddingModelSet bool
	EmbeddingModel    *string

	RerankModelSet bool
	RerankModel    *string

	RerankFallbackModelsSet bool
	RerankFallbackModels    []string

	AssistantModelSet bool
	AssistantModel    *string

	AssistantWebSearchEnabledSet bool
	AssistantWebSearchEnabled    *bool

	APISurfaceSet bool
	APISurface    APISurface

	TimeoutMsSet bool
	TimeoutMs    jsNumber

	TemperatureSet bool
	Temperature    jsNumber

	TopPSet bool
	TopP    jsNumber

	MaxOutputTokensSet bool
	MaxOutputTokens    jsNumber

	MaxRetriesSet bool
	MaxRetries    jsNumber

	FallbackModelsSet bool
	FallbackModels    []string

	SendMetadataSet bool
	SendMetadata    *bool

	ResponseFormatModeSet bool
	ResponseFormatMode    ResponseFormatMode

	EnabledSet bool
	Enabled    *bool
}

// errNoDatabase reports a missing MySQL pool on every persistence path.
var errNoDatabase = errors.New("llmgatewayprofiles: mysql is not configured")

// errNoRedis reports a missing Redis client on the cache paths.
var errNoRedis = errors.New("llmgatewayprofiles: redis is not configured")

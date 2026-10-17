package llmgatewayprofiles

import "encoding/json"

// gatewayProfileAuditMetadata is the exact metadata document the create and
// update paths record. Field order and field set match the NestJS object
// literal: embeddingModel, the numeric parameters and the full fallbackModels
// list were never recorded and must stay out.
type gatewayProfileAuditMetadata struct {
	ID                        string             `json:"id"`
	Name                      string             `json:"name"`
	APIBase                   string             `json:"apiBase"`
	Model                     string             `json:"model"`
	AssistantModel            *string            `json:"assistantModel,omitempty"`
	AssistantWebSearchEnabled NullableBool       `json:"assistantWebSearchEnabled"`
	RerankModel               *string            `json:"rerankModel,omitempty"`
	RerankFallbackModels      []string           `json:"rerankFallbackModels"`
	Enabled                   bool               `json:"enabled"`
	HasAPIKey                 bool               `json:"hasApiKey"`
	SendMetadata              NullableBool       `json:"sendMetadata"`
	ResponseFormatMode        ResponseFormatMode `json:"responseFormatMode"`
	APISurface                APISurface         `json:"apiSurface"`
}

// profileAuditMetadata builds the create/update audit document. The nullable
// compatibility flags are copied as-is, so an immediately-following create or
// update records the same null the response body carries.
func profileAuditMetadata(profile StoredProfile, hasAPIKey bool) gatewayProfileAuditMetadata {
	return gatewayProfileAuditMetadata{
		ID:                        profile.ID,
		Name:                      profile.Name,
		APIBase:                   profile.APIBase,
		Model:                     profile.Model,
		AssistantModel:            profile.AssistantModel,
		AssistantWebSearchEnabled: profile.AssistantWebSearchEnabled,
		RerankModel:               profile.RerankModel,
		RerankFallbackModels:      nonNilStrings(profile.RerankFallbackModels),
		Enabled:                   profile.Enabled,
		HasAPIKey:                 hasAPIKey,
		SendMetadata:              profile.SendMetadata,
		ResponseFormatMode:        profile.ResponseFormatMode,
		APISurface:                profile.APISurface,
	}
}

// gatewayIDMetadata is the delete audit document.
type gatewayIDMetadata struct {
	ID string `json:"id"`
}

// gatewayActiveIDMetadata is the completion activation audit document. The raw
// selection is recorded (including an empty string or null) and no mode field is
// added.
type gatewayActiveIDMetadata struct {
	ActiveID *string `json:"activeId"`
}

// gatewayEmbeddingActiveIDMetadata is the embedding activation audit document.
type gatewayEmbeddingActiveIDMetadata struct {
	EmbeddingActiveID *string `json:"embeddingActiveId"`
}

// gatewayRerankActiveIDMetadata is the rerank activation audit document.
type gatewayRerankActiveIDMetadata struct {
	RerankActiveID *string `json:"rerankActiveId"`
}

// encodeMetadata converts one json.Marshal result into the metadata token. The
// helper takes the two results directly so no untyped parameter is ever needed.
func encodeMetadata(payload []byte, err error) json.RawMessage {
	if err != nil {
		return json.RawMessage([]byte("{}"))
	}
	return payload
}

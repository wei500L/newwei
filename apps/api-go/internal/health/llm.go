package health

import (
	"context"
	"database/sql"
	"encoding/json"
	"strings"
)

type llmProfile struct {
	ID             string `json:"id"`
	Model          string `json:"model"`
	EmbeddingModel string `json:"embeddingModel"`
	RerankModel    string `json:"rerankModel"`
	Enabled        *bool  `json:"enabled"`
}

type llmSettings struct {
	activeID          string
	embeddingActiveID string
	embeddingMode     string
	rerankActiveID    string
	rerankMode        string
	profiles          []llmProfile
}

func (p *probeSet) loadLLM(ctx context.Context) (llmSettings, error) {
	if p.db == nil {
		return llmSettings{}, sql.ErrConnDone
	}
	var raw []byte
	err := p.db.QueryRowContext(ctx, "SELECT value FROM SystemSetting WHERE `key` = ? LIMIT 1", "llm_gateway_profiles").Scan(&raw)
	if err == sql.ErrNoRows {
		return llmSettings{}, nil
	}
	if err != nil {
		return llmSettings{}, err
	}
	return normalizeLLM(raw), nil
}

func normalizeLLM(raw []byte) llmSettings {
	var doc struct {
		ActiveID          string       `json:"activeId"`
		EmbeddingActiveID string       `json:"embeddingActiveId"`
		EmbeddingMode     string       `json:"embeddingMode"`
		RerankActiveID    string       `json:"rerankActiveId"`
		RerankMode        string       `json:"rerankMode"`
		Profiles          []llmProfile `json:"profiles"`
	}
	if json.Unmarshal(raw, &doc) != nil {
		return llmSettings{}
	}
	profiles := make([]llmProfile, 0, len(doc.Profiles))
	for _, profile := range doc.Profiles {
		profile.ID = strings.TrimSpace(profile.ID)
		profile.Model = strings.TrimSpace(profile.Model)
		profile.EmbeddingModel = strings.TrimSpace(profile.EmbeddingModel)
		profile.RerankModel = strings.TrimSpace(profile.RerankModel)
		if profile.ID == "" || profile.Model == "" {
			continue
		}
		if profile.Enabled == nil {
			enabled := true
			profile.Enabled = &enabled
		}
		profiles = append(profiles, profile)
	}
	settings := llmSettings{
		embeddingMode: modeOrFollow(doc.EmbeddingMode),
		rerankMode:    modeOrFollow(doc.RerankMode),
		profiles:      profiles,
	}
	if profile := findProfile(profiles, strings.TrimSpace(doc.ActiveID)); profile != nil && profile.enabled() {
		settings.activeID = profile.ID
	}
	if profile := findProfile(profiles, strings.TrimSpace(doc.EmbeddingActiveID)); profile != nil && profile.enabled() && profile.EmbeddingModel != "" {
		settings.embeddingActiveID = profile.ID
	}
	if profile := findProfile(profiles, strings.TrimSpace(doc.RerankActiveID)); profile != nil && profile.enabled() && profile.RerankModel != "" {
		settings.rerankActiveID = profile.ID
	}
	return settings
}

func (s llmSettings) completion() string {
	if profile := findProfile(s.profiles, s.activeID); profile != nil && profile.enabled() {
		return profile.Model
	}
	if profile := s.first("completion"); profile != nil {
		return profile.Model
	}
	return ""
}

func (s llmSettings) embedding() string {
	resolved := s.embeddingActiveID
	if resolved == "" && s.embeddingMode != "use_default" {
		resolved = s.activeID
	}
	if profile := findProfile(s.profiles, resolved); profile != nil && profile.enabled() && profile.EmbeddingModel != "" {
		return profile.EmbeddingModel
	}
	if s.embeddingMode == "use_default" || resolved == "" {
		if profile := s.first("embedding"); profile != nil {
			return profile.EmbeddingModel
		}
	}
	return ""
}

func (s llmSettings) rerank() string {
	resolved := s.rerankActiveID
	if resolved == "" && s.rerankMode != "use_default" {
		resolved = s.activeID
	}
	if profile := findProfile(s.profiles, resolved); profile != nil && profile.enabled() && profile.RerankModel != "" {
		return profile.RerankModel
	}
	if s.rerankMode == "use_default" || resolved == "" {
		if profile := s.first("rerank"); profile != nil {
			return profile.RerankModel
		}
	}
	return ""
}

func (s llmSettings) first(kind string) *llmProfile {
	for i := range s.profiles {
		profile := &s.profiles[i]
		if !profile.enabled() {
			continue
		}
		switch kind {
		case "completion":
			return profile
		case "embedding":
			if profile.EmbeddingModel != "" {
				return profile
			}
		case "rerank":
			if profile.RerankModel != "" {
				return profile
			}
		}
	}
	return nil
}

func (p llmProfile) enabled() bool {
	return p.Enabled == nil || *p.Enabled
}

func findProfile(profiles []llmProfile, id string) *llmProfile {
	if id == "" {
		return nil
	}
	for i := range profiles {
		if profiles[i].ID == id {
			return &profiles[i]
		}
	}
	return nil
}

func modeOrFollow(value string) string {
	if strings.TrimSpace(value) == "use_default" {
		return "use_default"
	}
	return "follow_completion"
}

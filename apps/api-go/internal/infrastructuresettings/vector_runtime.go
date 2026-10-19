package infrastructuresettings

import (
	"context"
	"errors"
)

// VectorRuntimeConfig is the resolved vector-service configuration: the stored
// `vector_service` row overlaid on the environment defaults, with an encrypted
// token already decrypted. It is the read-only surface other background units
// reuse instead of duplicating the cache, normalization and decryption logic.
type VectorRuntimeConfig struct {
	Enabled         bool
	FallbackToMongo bool
	BaseURL         string
	Token           string
	TimeoutMs       int
	MaxRetries      int
}

// VectorRuntimeConfig resolves the effective vector-service configuration the
// same way getVectorPublicSettings and the runtime diagnostics do. A missing
// row keeps the environment defaults; an unreadable stored token falls back to
// the environment token. The read is cache-first through the shared
// vector_service:settings envelope.
func (s *Service) VectorRuntimeConfig(ctx context.Context) (VectorRuntimeConfig, error) {
	if s == nil || s.db == nil {
		return VectorRuntimeConfig{}, errors.New("infrastructuresettings: mysql is not configured")
	}
	stored, err := s.loadVectorSettings(ctx)
	if err != nil {
		return VectorRuntimeConfig{}, err
	}
	effective := s.resolveVectorEffective(stored)
	return VectorRuntimeConfig{
		Enabled:         effective.Enabled,
		FallbackToMongo: effective.FallbackToMongo,
		BaseURL:         effective.BaseURL,
		Token:           effective.Token,
		TimeoutMs:       effective.TimeoutMs,
		MaxRetries:      effective.MaxRetries,
	}, nil
}

package modelaccesssettings

import (
	"context"
	"encoding/json"
	"log"
	"time"
)

// reportAppliedKeyFingerprints serves POST /api/internal/litellm/openai-keys/applied.
//
// It records what the LiteLLM proxy REPORTS, not proof that the proxy loaded the
// keys: the row is written with updatedById=NULL, isPublic=false, it never touches
// the openai_keys row, it writes no admin AuditLog entry, and it deletes the
// openai_keys:applied_status cache envelope so the next read observes the report.
func (s *Service) reportAppliedKeyFingerprints(
	ctx context.Context,
	request reportAppliedRequest,
) error {
	fingerprints := normalizeFingerprints(request.KeyFingerprints)
	if fingerprints == nil {
		fingerprints = []string{}
	}
	payload, err := json.Marshal(appliedStatusWrite{
		Source:          request.Source,
		KeyFingerprints: fingerprints,
		AppliedAt:       time.Now().UTC().Format("2006-01-02T15:04:05.000Z"),
	})
	if err != nil {
		return err
	}
	// updatedById is NULL: the column is a foreign key into User(id) and the
	// internal endpoint has no user identity.
	if err := s.persistSetting(ctx, settingKeyAppliedStatus, payload, descriptionAppliedStatus, nil); err != nil {
		return err
	}
	s.invalidateCache(ctx, cacheKeyAppliedStatus)
	log.Printf("modelaccesssettings: litellm reported %d applied key fingerprints (source=%s)", len(fingerprints), request.Source)
	return nil
}

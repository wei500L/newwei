package infrastructuresettings

import (
	"context"
	"encoding/json"
	"fmt"
	"time"
)

// Public runtime-secret models.

// runtimeSecretsPublicEntry is one public entry: metadata only, never the value
// or the ciphertext.
type runtimeSecretsPublicEntry struct {
	SourceID    string `json:"sourceId"`
	Key         string `json:"key"`
	HasValue    bool   `json:"hasValue"`
	Fingerprint string `json:"fingerprint"`
	UpdatedAt   string `json:"updatedAt"`
}

// runtimeSecretsPublic is the public document. Entries is always an array.
type runtimeSecretsPublic struct {
	Source  string                      `json:"source"`
	Entries []runtimeSecretsPublicEntry `json:"entries"`
}

// runtimeSecretsWriteEntry is one entry of the document written back to MySQL.
type runtimeSecretsWriteEntry struct {
	SourceID    string          `json:"sourceId"`
	Key         string          `json:"key"`
	Value       json.RawMessage `json:"value"`
	Fingerprint string          `json:"fingerprint"`
	UpdatedAt   string          `json:"updatedAt"`
}

// runtimeSecretsWriteDocument is the stored `version: 1` document.
type runtimeSecretsWriteDocument struct {
	Version int                        `json:"version"`
	Entries []runtimeSecretsWriteEntry `json:"entries"`
}

// getRuntimeSecretsPublic mirrors getPublicSettings: always the database, never
// the process cache.
func (s *Service) getRuntimeSecretsPublic(ctx context.Context) (runtimeSecretsPublic, error) {
	settings, err := s.loadRuntimeSecretsStrictFromDB(ctx)
	if err != nil {
		return runtimeSecretsPublic{}, err
	}
	return runtimeSecretsPublicFrom(settings), nil
}

// runtimeSecretsPublicFrom renders the public view. hasValue stays constant
// true for every parsed entry: the public GET must not decrypt to decide.
func runtimeSecretsPublicFrom(settings *runtimeStoredSettings) runtimeSecretsPublic {
	if settings == nil {
		return runtimeSecretsPublic{Source: string(SettingSourceNone), Entries: []runtimeSecretsPublicEntry{}}
	}
	entries := make([]runtimeSecretsPublicEntry, 0, len(settings.Entries))
	for _, entry := range settings.Entries {
		entries = append(entries, runtimeSecretsPublicEntry{
			SourceID:    entry.SourceID,
			Key:         entry.Key,
			HasValue:    true,
			Fingerprint: entry.Fingerprint,
			UpdatedAt:   entry.UpdatedAt,
		})
	}
	return runtimeSecretsPublic{Source: string(SettingSourceDB), Entries: entries}
}

// loadRuntimeSecretsStrictFromDB strictly parses the stored row. Corrupt rows
// fail with the 400/409 contract instead of being silently treated as empty.
func (s *Service) loadRuntimeSecretsStrictFromDB(ctx context.Context) (*runtimeStoredSettings, error) {
	raw, found, err := s.loadSetting(ctx, settingKeyRuntimeSecrets)
	if err != nil {
		return nil, err
	}
	if !found {
		return nil, nil
	}
	return parseRuntimeSecretsStrict(raw)
}

// updateRuntimeSecrets mirrors updateSettings. The merge base is read from
// MySQL inside the global lock, so two concurrent writers cannot drop each
// other's untouched entries.
func (s *Service) updateRuntimeSecrets(ctx context.Context, orgID, actorID string, input runtimeSecretsUpdateInput) (runtimeSecretsPublic, error) {
	upserts, err := normalizeRuntimeUpserts(input.Upserts)
	if err != nil {
		return runtimeSecretsPublic{}, err
	}
	removes, err := normalizeRuntimeRemoves(input.Removes)
	if err != nil {
		return runtimeSecretsPublic{}, err
	}
	if len(upserts) == 0 && len(removes) == 0 {
		return s.getRuntimeSecretsPublic(ctx)
	}

	var snapshot runtimeSecretsPublic
	err = s.withSessionLock(ctx, lockNewsSourceRuntimeKey, func(lockCtx context.Context) error {
		current, err := s.loadRuntimeSecretsStrictFromDB(lockCtx)
		if err != nil {
			return err
		}

		order := make([]string, 0)
		byKey := make(map[string]runtimeStoredEntry)
		for _, entry := range currentEntries(current) {
			composite := runtimeCompositeKey(entry.SourceID, entry.Key)
			if _, seen := byKey[composite]; !seen {
				order = append(order, composite)
			}
			byKey[composite] = entry
		}

		for _, item := range removes {
			composite := runtimeCompositeKey(item.SourceID, item.Key)
			delete(byKey, composite)
		}

		updatedAt := time.Now().UTC().Format("2006-01-02T15:04:05.000Z")
		for _, item := range upserts {
			encoded, err := s.encodeSecretForStorage(lockCtx, item.Value)
			if err != nil {
				if secretErr, ok := err.(*secretError); ok {
					return secretErr.asHTTPError()
				}
				return err
			}
			rawValue, err := encoded.toRawValue()
			if err != nil {
				return err
			}
			composite := runtimeCompositeKey(item.SourceID, item.Key)
			if _, seen := byKey[composite]; !seen {
				order = append(order, composite)
			}
			byKey[composite] = runtimeStoredEntry{
				SourceID:    item.SourceID,
				Key:         item.Key,
				Value:       rawValue,
				Fingerprint: fingerprintSecretValue(item.Value),
				UpdatedAt:   updatedAt,
			}
		}

		if len(byKey) > runtimeSecretsMaxEntries {
			return &httpError{
				status:  400,
				message: fmt.Sprintf("Too many runtime secrets entries (max %d)", runtimeSecretsMaxEntries),
			}
		}

		entries := make([]runtimeStoredEntry, 0, len(byKey))
		for _, composite := range order {
			entry, ok := byKey[composite]
			if !ok {
				continue
			}
			entries = append(entries, entry)
		}
		sortRuntimeEntries(entries)

		if len(entries) == 0 {
			if err := s.deleteSetting(lockCtx, settingKeyRuntimeSecrets); err != nil {
				return err
			}
		} else {
			document := runtimeSecretsWriteDocument{Version: 1, Entries: make([]runtimeSecretsWriteEntry, 0, len(entries))}
			for _, entry := range entries {
				document.Entries = append(document.Entries, runtimeSecretsWriteEntry{
					SourceID:    entry.SourceID,
					Key:         entry.Key,
					Value:       entry.Value,
					Fingerprint: entry.Fingerprint,
					UpdatedAt:   entry.UpdatedAt,
				})
			}
			value, err := json.Marshal(document)
			if err != nil {
				return err
			}
			if err := s.upsertSettingForceDescription(lockCtx, settingKeyRuntimeSecrets, value,
				descriptionRuntimeSecrets, false, nullableActorID(actorID)); err != nil {
				return err
			}
		}

		metadata, err := json.Marshal(runtimeSecretsAuditMetadata{
			Upserts:      len(upserts),
			Removes:      len(removes),
			EntriesAfter: len(entries),
		})
		if err != nil {
			return err
		}
		if err := s.writeAuditLogBestEffort(lockCtx, orgID, actorID, "news_source_runtime_secrets_update", metadata); err != nil {
			return err
		}

		// The in-process consumers keep their own 30 second cache; the
		// management path never served it and never will.
		if len(entries) == 0 {
			snapshot = runtimeSecretsPublicFrom(nil)
			return nil
		}
		snapshot = runtimeSecretsPublicFrom(&runtimeStoredSettings{Entries: entries})
		return nil
	})
	if err != nil {
		return runtimeSecretsPublic{}, err
	}
	return snapshot, nil
}

// currentEntries returns the parsed entries, tolerating a nil document.
func currentEntries(settings *runtimeStoredSettings) []runtimeStoredEntry {
	if settings == nil {
		return nil
	}
	return settings.Entries
}

// normalizeRuntimeUpserts mirrors normalizeUpserts: sourceId is trimmed and
// lowercased, the key is trimmed with its case preserved, the value is trimmed,
// and a repeated composite key keeps the last value (at its first position).
func normalizeRuntimeUpserts(raw []runtimeSecretUpsertInput) ([]runtimeSecretUpsertInput, error) {
	order := make([]string, 0, len(raw))
	byKey := make(map[string]runtimeSecretUpsertInput, len(raw))
	for _, item := range raw {
		sourceID, err := normalizeRuntimeSourceID(item.SourceID)
		if err != nil {
			return nil, err
		}
		key, err := normalizeRuntimeKey(item.Key)
		if err != nil {
			return nil, err
		}
		value, err := normalizeRuntimeValue(item.Value)
		if err != nil {
			return nil, err
		}
		composite := runtimeCompositeKey(sourceID, key)
		if _, seen := byKey[composite]; !seen {
			order = append(order, composite)
		}
		byKey[composite] = runtimeSecretUpsertInput{SourceID: sourceID, Key: key, Value: value}
	}
	out := make([]runtimeSecretUpsertInput, 0, len(order))
	for _, composite := range order {
		out = append(out, byKey[composite])
	}
	return out, nil
}

// normalizeRuntimeRemoves mirrors normalizeRemoves.
func normalizeRuntimeRemoves(raw []runtimeSecretRemoveInput) ([]runtimeSecretRemoveInput, error) {
	order := make([]string, 0, len(raw))
	byKey := make(map[string]runtimeSecretRemoveInput, len(raw))
	for _, item := range raw {
		sourceID, err := normalizeRuntimeSourceID(item.SourceID)
		if err != nil {
			return nil, err
		}
		key, err := normalizeRuntimeKey(item.Key)
		if err != nil {
			return nil, err
		}
		composite := runtimeCompositeKey(sourceID, key)
		if _, seen := byKey[composite]; !seen {
			order = append(order, composite)
		}
		byKey[composite] = runtimeSecretRemoveInput{SourceID: sourceID, Key: key}
	}
	out := make([]runtimeSecretRemoveInput, 0, len(order))
	for _, composite := range order {
		out = append(out, byKey[composite])
	}
	return out, nil
}

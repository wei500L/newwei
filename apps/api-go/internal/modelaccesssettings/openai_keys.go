package modelaccesssettings

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"log"
	"unicode/utf8"
)

// MAX_KEYS mirrors OpenAiKeysSettingsService.MAX_KEYS.
const maxKeysMessage = "Too many OpenAI API keys (max 100)"

// tooManyKeysError is the 400 the business layer raises once a NORMALIZED list
// exceeds the ceiling. The DTO-level @ArrayMaxSize(100) already rejected a raw
// body with more than 100 entries, so this catches a merge/legacy overflow.
func tooManyKeysError() error {
	return &httpError{status: 400, message: maxKeysMessage}
}

// stripBearerPrefix mirrors OpenAiKeysSettingsService.stripBearerPrefix:
//
//	value.replace(/^bearer\s+/i, "").trim()
//
// The replace runs BEFORE the trim, the match is anchored at the start, the
// keyword is case-insensitive, and `\s` is the JavaScript whitespace class (which
// includes U+00A0, U+2028 and U+FEFF but excludes U+0085). Both steps are
// implemented against the JavaScript definitions instead of Go's approximations.
func stripBearerPrefix(value string) string {
	rest := value
	if len(rest) >= len("bearer") && equalFoldASCII(rest[:len("bearer")], "bearer") {
		after := rest[len("bearer"):]
		whitespace := 0
		for whitespace < len(after) {
			r, size := decodeRune(after[whitespace:])
			if !isJSWhitespace(r) {
				break
			}
			whitespace += size
		}
		if whitespace > 0 {
			rest = after[whitespace:]
		}
	}
	return jsTrimSpace(rest)
}

// equalFoldASCII compares two ASCII strings case-insensitively.
func equalFoldASCII(left, right string) bool {
	if len(left) != len(right) {
		return false
	}
	for index := 0; index < len(left); index++ {
		a := left[index]
		b := right[index]
		if a >= 'A' && a <= 'Z' {
			a += 'a' - 'A'
		}
		if b >= 'A' && b <= 'Z' {
			b += 'a' - 'A'
		}
		if a != b {
			return false
		}
	}
	return true
}

// decodeRune decodes the first UTF-8 rune of value. Every JavaScript whitespace
// code point this feature must match is in the BMP, so the UTF-8 decode agrees
// with the UTF-16 view of the string.
func decodeRune(value string) (rune, int) {
	return utf8.DecodeRuneInString(value)
}

// normalizeKeys mirrors OpenAiKeysSettingsService.normalizeKeys, step by step:
// keep only strings, strip the bearer prefix, trim again, drop empty entries, then
// de-duplicate in first-appearance order. The extra trim after stripBearerPrefix
// is present in the source and is kept (it is idempotent, but the order is part of
// the contract).
func normalizeKeys(entries []string) []string {
	normalized := make([]string, 0, len(entries))
	for _, entry := range entries {
		value := jsTrimSpace(stripBearerPrefix(entry))
		if value == "" {
			continue
		}
		normalized = append(normalized, value)
	}
	return uniqueStrings(normalized)
}

// uniqueStrings keeps the first occurrence of each value, in order.
func uniqueStrings(values []string) []string {
	seen := make(map[string]bool, len(values))
	out := make([]string, 0, len(values))
	for _, value := range values {
		if seen[value] {
			continue
		}
		seen[value] = true
		out = append(out, value)
	}
	return out
}

// fingerprintKey mirrors fingerprintKey: the SHA-256 of the
// stripBearerPrefix+trim form, lowercase hex.
func fingerprintKey(key string) string {
	sum := sha256.Sum256([]byte(stripBearerPrefix(key)))
	return hex.EncodeToString(sum[:])
}

// normalizeFingerprints mirrors normalizeFingerprints: keep only strings, trim,
// drop empty entries, de-duplicate in first-appearance order. It does NOT strip a
// bearer prefix — fingerprints are not keys.
func normalizeFingerprints(entries []string) []string {
	normalized := make([]string, 0, len(entries))
	for _, entry := range entries {
		value := jsTrimSpace(entry)
		if value == "" {
			continue
		}
		normalized = append(normalized, value)
	}
	return uniqueStrings(normalized)
}

// sameFingerprintSets mirrors sameFingerprintSets: equal length, no duplicate on
// the left, and every right-hand member present on the left. Order is irrelevant.
func sameFingerprintSets(left, right []string) bool {
	if len(left) != len(right) {
		return false
	}
	set := make(map[string]bool, len(left))
	for _, value := range left {
		if set[value] {
			// Should not happen, but a duplicate is treated as a mismatch.
			return false
		}
		set[value] = true
	}
	for _, value := range right {
		if !set[value] {
			return false
		}
	}
	return true
}

// countStoredKeys mirrors countStoredKeys. It counts by STRUCTURE and never
// decrypts: a wrapped entry counts when its value is JS-truthy, a legacy
// plaintext string or a bare encrypted envelope counts unconditionally.
//
// This is a different algorithm from resolveKeys and listKeyFingerprints on
// purpose — the three deliberately disagree on legacy rows, and the public
// keysCount is NOT resolveKeys().length.
func countStoredKeys(entries []json.RawMessage) int {
	return countStoredKeysParsed(parseOpenAiKeyEntries(entries))
}

// countStoredKeysParsed is countStoredKeys over an already classified entry
// list, so a caller that also needs the fingerprints classifies the array once.
func countStoredKeysParsed(entries []openAiKeyEntry) int {
	count := 0
	for _, entry := range entries {
		switch entry.kind {
		case openAiKeyLegacyPlain, openAiKeyLegacyEncrypted:
			count++
		case openAiKeyWrapped:
			if entry.wrapped.value.truthy() {
				count++
			}
		}
	}
	return count
}

// resolveKeys mirrors resolveKeys: decrypt what can be decrypted, skip what
// cannot, and de-duplicate in first-appearance order. A decryption failure is
// never an error response.
func (s *Service) resolveKeys(entries []json.RawMessage) []string {
	return s.resolveParsedKeys(parseOpenAiKeyEntries(entries))
}

// resolveParsedKeys is resolveKeys over an already classified entry list.
func (s *Service) resolveParsedKeys(entries []openAiKeyEntry) []string {
	key, keyPresent := s.settingsDecryptionKey()
	out := make([]string, 0, len(entries))
	for _, entry := range entries {
		switch entry.kind {
		case openAiKeyWrapped:
			switch entry.wrapped.value.kind {
			case secretPlain:
				value := stripBearerPrefix(entry.wrapped.value.plain)
				if value != "" {
					out = append(out, value)
				}
			case secretEncrypted:
				if !keyPresent {
					log.Printf("modelaccesssettings: SYSTEM_SETTINGS_ENCRYPTION_KEY is missing or invalid for the OpenAI keys")
					continue
				}
				decrypted, ok := entry.wrapped.value.decryptRaw(key)
				if !ok {
					log.Printf("modelaccesssettings: failed to decrypt an OpenAI key")
					continue
				}
				if value := stripBearerPrefix(decrypted); value != "" {
					out = append(out, value)
				}
			}
		case openAiKeyLegacyPlain:
			if value := stripBearerPrefix(entry.plain); value != "" {
				out = append(out, value)
			}
		case openAiKeyLegacyEncrypted:
			if !keyPresent {
				log.Printf("modelaccesssettings: SYSTEM_SETTINGS_ENCRYPTION_KEY is missing or invalid for the OpenAI keys")
				continue
			}
			decrypted, ok := entry.encrypted.decryptRaw(key)
			if !ok {
				log.Printf("modelaccesssettings: failed to decrypt an OpenAI key")
				continue
			}
			if value := stripBearerPrefix(decrypted); value != "" {
				out = append(out, value)
			}
		}
	}
	return uniqueStrings(out)
}

// listKeyFingerprints mirrors listKeyFingerprints: a wrapped entry exposes its
// stored fingerprint WITHOUT decrypting (and only when it is non-blank), a legacy
// plaintext string is hashed even when the stripped form is empty, and a bare
// encrypted envelope is hashed only when it decrypts.
//
// The empty-plaintext difference against resolveKeys is intentional: it is the
// source's behaviour and is covered by unit tests.
func (s *Service) listKeyFingerprints(entries []json.RawMessage) []string {
	return s.listParsedKeyFingerprints(parseOpenAiKeyEntries(entries))
}

// listParsedKeyFingerprints is listKeyFingerprints over an already classified
// entry list.
func (s *Service) listParsedKeyFingerprints(entries []openAiKeyEntry) []string {
	key, keyPresent := s.settingsDecryptionKey()
	out := make([]string, 0, len(entries))
	for _, entry := range entries {
		switch entry.kind {
		case openAiKeyWrapped:
			if trimmed := jsTrimSpace(entry.wrapped.fingerprint); trimmed != "" {
				out = append(out, trimmed)
			}
		case openAiKeyLegacyPlain:
			out = append(out, fingerprintKey(stripBearerPrefix(entry.plain)))
		case openAiKeyLegacyEncrypted:
			if !keyPresent {
				continue
			}
			decrypted, ok := entry.encrypted.decryptRaw(key)
			if !ok {
				continue
			}
			out = append(out, fingerprintKey(stripBearerPrefix(decrypted)))
		}
	}
	return uniqueStrings(out)
}

// getOpenAiKeysSettings serves GET /api/system-settings/openai-keys through the
// original 30 second best-effort cache contract for both the keys row and the
// applied-status row.
func (s *Service) getOpenAiKeysSettings(ctx context.Context) (openAiKeysSettingsPublic, error) {
	record, err := s.readOpenAiKeysRecordCached(ctx)
	if err != nil {
		return openAiKeysSettingsPublic{}, err
	}
	applied, err := s.readAppliedStatusCached(ctx)
	if err != nil {
		return openAiKeysSettingsPublic{}, err
	}
	return s.buildOpenAiKeysPublic(record, applied), nil
}

// buildOpenAiKeysPublic projects the keys row and the applied-status row onto the
// public response contract.
func (s *Service) buildOpenAiKeysPublic(
	record openAiKeysRecord,
	applied appliedStatusRecord,
) openAiKeysSettingsPublic {
	// One classification feeds both projections: the structural count and the
	// fingerprint list no longer parse the stored array separately.
	entries := parseOpenAiKeyEntries(record.entries)
	keysCount := countStoredKeysParsed(entries)
	keyFingerprints := s.listParsedKeyFingerprints(entries)
	appliedAt, appliedAtOK := jsonString(applied.payload.AppliedAt)
	appliedKeyFingerprints := s.listAppliedFingerprints(applied.payload.KeyFingerprints)
	appliedState, appliedOK := s.resolveAppliedSource(applied.payload.Source)

	var appliedAtPointer *string
	if appliedAtOK {
		value := appliedAt
		appliedAtPointer = &value
	}
	var appliedSourcePointer *appliedSource
	if appliedOK {
		value := appliedState
		appliedSourcePointer = &value
	}

	restartRequired := false
	if keysCount > 0 {
		restartRequired = appliedState != appliedSourceDB ||
			len(keyFingerprints) == 0 ||
			len(appliedKeyFingerprints) == 0 ||
			!sameFingerprintSets(keyFingerprints, appliedKeyFingerprints)
	} else {
		restartRequired = appliedOK && appliedState == appliedSourceDB && len(appliedKeyFingerprints) > 0
	}

	if keyFingerprints == nil {
		keyFingerprints = []string{}
	}
	if appliedKeyFingerprints == nil {
		appliedKeyFingerprints = []string{}
	}

	source := settingsSourceNone
	if record.present {
		source = settingsSourceDB
	}

	return openAiKeysSettingsPublic{
		Source:                  source,
		KeysCount:               keysCount,
		HasKeys:                 keysCount > 0,
		KeyFingerprints:         keyFingerprints,
		InternalTokenConfigured: jsTrimSpace(s.cfg.LiteLLMConfigInternalToken) != "",
		AppliedAt:               appliedAtPointer,
		AppliedSource:           appliedSourcePointer,
		AppliedKeyFingerprints:  appliedKeyFingerprints,
		RestartRequired:         restartRequired,
	}
}

// listAppliedFingerprints projects the stored applied fingerprints: keep only
// strings, trim, drop empty entries, de-duplicate in order.
func (s *Service) listAppliedFingerprints(entries []json.RawMessage) []string {
	collected := make([]string, 0, len(entries))
	for _, raw := range entries {
		if text, ok := jsonString(raw); ok {
			collected = append(collected, text)
		}
	}
	return normalizeFingerprints(collected)
}

// resolveAppliedSource normalizes a stored applied source: anything outside
// db|env|none (including a non-string) becomes null.
func (s *Service) resolveAppliedSource(raw json.RawMessage) (appliedSource, bool) {
	text, ok := jsonString(raw)
	if !ok {
		return "", false
	}
	return validAppliedSource(text)
}

// updateOpenAiKeysSettings serves PUT /api/system-settings/openai-keys: the
// normalized set fully replaces the stored collection (MA1 gate, MA2 lock).
func (s *Service) updateOpenAiKeysSettings(
	ctx context.Context,
	orgID string,
	actorID string,
	request updateOpenAiKeysSettingsRequest,
) (openAiKeysSettingsPublic, error) {
	if err := s.assertPlatformAdmin(ctx, actorID); err != nil {
		return openAiKeysSettingsPublic{}, err
	}
	var result openAiKeysSettingsPublic
	err := s.withSessionLock(ctx, lockNameOpenAiKeys, func(lockCtx context.Context) error {
		public, err := s.persistKeysLocked(lockCtx, orgID, actorID, normalizeKeys(request.Keys))
		if err != nil {
			return err
		}
		result = public
		return nil
	})
	if err != nil {
		return openAiKeysSettingsPublic{}, err
	}
	return result, nil
}

// appendOpenAiKeys serves POST /api/system-settings/openai-keys.
//
// MA2: the merge baseline is the authoritative row read inside the lock, and the
// write goes through the private in-lock helper (never a public locking method,
// which would deadlock).
func (s *Service) appendOpenAiKeys(
	ctx context.Context,
	orgID string,
	actorID string,
	request updateOpenAiKeysSettingsRequest,
) (openAiKeysSettingsPublic, error) {
	if err := s.assertPlatformAdmin(ctx, actorID); err != nil {
		return openAiKeysSettingsPublic{}, err
	}
	var result openAiKeysSettingsPublic
	err := s.withSessionLock(ctx, lockNameOpenAiKeys, func(lockCtx context.Context) error {
		record, err := s.readOpenAiKeysRecordAuthoritative(lockCtx)
		if err != nil {
			return err
		}
		existing := s.resolveKeys(record.entries)
		merged := uniqueStrings(append(append([]string{}, existing...), normalizeKeys(request.Keys)...))
		public, err := s.persistKeysLocked(lockCtx, orgID, actorID, merged)
		if err != nil {
			return err
		}
		result = public
		return nil
	})
	if err != nil {
		return openAiKeysSettingsPublic{}, err
	}
	return result, nil
}

// removeOpenAiKeyByFingerprint serves
// DELETE /api/system-settings/openai-keys/key/:fingerprint.
//
// The fingerprint is compared verbatim: it is not trimmed, not case-folded and not
// validated. A fingerprint that matches nothing still returns 200 with the
// unchanged collection.
func (s *Service) removeOpenAiKeyByFingerprint(
	ctx context.Context,
	orgID string,
	actorID string,
	fingerprint string,
) (openAiKeysSettingsPublic, error) {
	if err := s.assertPlatformAdmin(ctx, actorID); err != nil {
		return openAiKeysSettingsPublic{}, err
	}
	var result openAiKeysSettingsPublic
	err := s.withSessionLock(ctx, lockNameOpenAiKeys, func(lockCtx context.Context) error {
		record, err := s.readOpenAiKeysRecordAuthoritative(lockCtx)
		if err != nil {
			return err
		}
		existing := s.resolveKeys(record.entries)
		remaining := make([]string, 0, len(existing))
		for _, key := range existing {
			if fingerprintKey(key) == fingerprint {
				continue
			}
			remaining = append(remaining, key)
		}
		public, err := s.persistKeysLocked(lockCtx, orgID, actorID, remaining)
		if err != nil {
			return err
		}
		result = public
		return nil
	})
	if err != nil {
		return openAiKeysSettingsPublic{}, err
	}
	return result, nil
}

// resetOpenAiKeys serves DELETE /api/system-settings/openai-keys.
//
// MA1 gate + MA2 lock. litellm_openai_keys_applied and its cache are deliberately
// preserved, so the response may still report restartRequired=true.
func (s *Service) resetOpenAiKeys(
	ctx context.Context,
	orgID string,
	actorID string,
) (openAiKeysSettingsPublic, error) {
	if err := s.assertPlatformAdmin(ctx, actorID); err != nil {
		return openAiKeysSettingsPublic{}, err
	}
	var result openAiKeysSettingsPublic
	err := s.withSessionLock(ctx, lockNameOpenAiKeys, func(lockCtx context.Context) error {
		if err := s.removeSetting(lockCtx, settingKeyOpenAiKeys); err != nil {
			return err
		}
		metadata, err := json.Marshal(okAudit{OK: true})
		if err != nil {
			return err
		}
		if err := s.writeAuditLogBestEffort(lockCtx, orgID, actorID, actionOpenAiKeysReset, metadata); err != nil {
			return err
		}
		s.invalidateCache(lockCtx, cacheKeyOpenAiKeys)
		applied, err := s.readAppliedStatusAuthoritative(lockCtx)
		if err != nil {
			return err
		}
		result = s.buildOpenAiKeysPublic(openAiKeysRecord{}, applied)
		return nil
	})
	if err != nil {
		return openAiKeysSettingsPublic{}, err
	}
	return result, nil
}

// persistKeysLocked persists one already-normalized key list and returns the
// public projection of the committed snapshot.
//
// The caller MUST hold lockNameOpenAiKeys: this helper never acquires the lock and
// never calls a public locking method. Every key is encoded BEFORE the upsert, so a
// mid-list encryption failure leaves the stored configuration untouched (no
// half-written list). The lock is released only after the upsert, the audit
// handling and the cache invalidation.
func (s *Service) persistKeysLocked(
	ctx context.Context,
	orgID string,
	actorID string,
	keys []string,
) (openAiKeysSettingsPublic, error) {
	if len(keys) > maxOpenAiApiKeys {
		return openAiKeysSettingsPublic{}, tooManyKeysError()
	}

	encoded := make([]openAiKeyEntryWrite, 0, len(keys))
	for _, key := range keys {
		storedValue, err := s.encodeSecretForStorage(ctx, key)
		if err != nil {
			log.Printf("modelaccesssettings: failed to encode an OpenAI key for storage")
			return openAiKeysSettingsPublic{}, err
		}
		encoded = append(encoded, openAiKeyEntryWrite{
			Fingerprint: fingerprintKey(key),
			Value:       storedValue,
		})
	}

	next := openAiKeysSettingsWrite{OpenaiApiKeys: encoded}
	payload, err := json.Marshal(next)
	if err != nil {
		return openAiKeysSettingsPublic{}, err
	}
	if err := s.persistSetting(ctx, settingKeyOpenAiKeys, payload, descriptionOpenAiKeys, nullableActorID(actorID)); err != nil {
		return openAiKeysSettingsPublic{}, err
	}

	metadata, err := json.Marshal(keysCountAudit{KeysCount: len(keys)})
	if err != nil {
		return openAiKeysSettingsPublic{}, err
	}
	if err := s.writeAuditLogBestEffort(ctx, orgID, actorID, actionOpenAiKeysUpdate, metadata); err != nil {
		return openAiKeysSettingsPublic{}, err
	}

	s.invalidateCache(ctx, cacheKeyOpenAiKeys)
	// The applied-status projection is read from MySQL, not from the pre-write
	// Redis envelope, so the response describes the committed state.
	applied, err := s.readAppliedStatusAuthoritative(ctx)
	if err != nil {
		return openAiKeysSettingsPublic{}, err
	}
	written, err := decodeOpenAiKeysRecord(payload)
	if err != nil {
		return openAiKeysSettingsPublic{}, err
	}
	return s.buildOpenAiKeysPublic(written, applied), nil
}

// getPlaintextKeys serves GET /api/internal/litellm/openai-keys. It reuses the
// same configuration, cache envelope and resolveKeys algorithm as the admin read;
// this is the only route allowed to return plaintext keys, and nothing about it is
// logged.
func (s *Service) getPlaintextKeys(ctx context.Context) (openAiKeysInternalResponse, error) {
	record, err := s.readOpenAiKeysRecordCached(ctx)
	if err != nil {
		return openAiKeysInternalResponse{}, err
	}
	keys := s.resolveKeys(record.entries)
	if keys == nil {
		keys = []string{}
	}
	return openAiKeysInternalResponse{OpenaiApiKeys: keys}, nil
}

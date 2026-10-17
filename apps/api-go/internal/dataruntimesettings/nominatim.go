package dataruntimesettings

import (
	"bytes"
	"context"
	"encoding/json"
	"strings"
	"sync"
	"time"
)

// This file implements GET/PUT /api/system-settings/geo/nominatim.
//
// The domain keeps the NestJS per-process 30 second cache and has no Redis
// configuration cache at all: after one instance updates the row, another
// instance may keep serving its own cached copy for up to 30 seconds. That is
// documented, retained behaviour and is deliberately not "fixed" here. The write
// path never uses that cache as a merge base — it reads the row from MySQL inside
// the caller's lock and only then refreshes the cache.

// nominatimCacheTTL is the per-process cache lifetime.
const nominatimCacheTTL = 30 * time.Second

// nominatimOverrides is the stored override pair.
type nominatimOverrides struct {
	UserAgent *string
	Email     *string
}

// geoNominatimSettings is the response body. Every member is always present,
// with JSON null for an unset override / effective value.
type geoNominatimSettings struct {
	UserAgent          *string `json:"userAgent"`
	Email              *string `json:"email"`
	EffectiveUserAgent string  `json:"effectiveUserAgent"`
	EffectiveEmail     *string `json:"effectiveEmail"`
}

// encodeJSON renders the Nominatim settings.
func (s geoNominatimSettings) encodeJSON() ([]byte, error) { return json.Marshal(s) }

// nominatimStoredValue is the stored value shape. Members stay raw so a wrong
// stored type is normalized away instead of failing the read.
type nominatimStoredValue struct {
	UserAgent json.RawMessage `json:"userAgent,omitempty"`
	Email     json.RawMessage `json:"email,omitempty"`
}

// nominatimWrittenValue is the exact document the writer persists.
type nominatimWrittenValue struct {
	UserAgent *string `json:"userAgent"`
	Email     *string `json:"email"`
}

// nominatimCacheEntry is the thread-safe per-process cache slot.
type nominatimCacheEntry struct {
	settings  *geoNominatimSettings
	expiresAt time.Time
}

// processCache is the per-process 30 second cache. The mutex makes it safe for
// concurrent requests, which the Go server (unlike the single-threaded NestJS
// event loop) genuinely needs.
type processCache struct {
	mu    sync.RWMutex
	entry nominatimCacheEntry
}

// get returns the cached settings when the entry is still fresh.
func (c *processCache) get(now time.Time) (*geoNominatimSettings, bool) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	if c.entry.settings != nil && now.Before(c.entry.expiresAt) {
		return c.entry.settings, true
	}
	return nil, false
}

// put stores the settings with the standard TTL.
func (c *processCache) put(settings *geoNominatimSettings, now time.Time) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.entry = nominatimCacheEntry{settings: settings, expiresAt: now.Add(nominatimCacheTTL)}
}

// invalidate drops the cached entry.
func (c *processCache) invalidate() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.entry = nominatimCacheEntry{}
}

// normalizeUserAgent mirrors normalizeUserAgent: trim, and a blank or non-string
// value becomes null.
func normalizeUserAgent(raw json.RawMessage) *string {
	if len(bytes.TrimSpace(raw)) == 0 || isNullRaw(raw) {
		return nil
	}
	text, ok := decodeJSONString(raw)
	if !ok {
		return nil
	}
	trimmed := strings.TrimSpace(text)
	if trimmed == "" {
		return nil
	}
	return &trimmed
}

// normalizeEmail mirrors normalizeEmail: trim, then require a valid address.
func normalizeEmail(raw json.RawMessage) *string {
	if len(bytes.TrimSpace(raw)) == 0 || isNullRaw(raw) {
		return nil
	}
	text, ok := decodeJSONString(raw)
	if !ok {
		return nil
	}
	trimmed := strings.TrimSpace(text)
	if trimmed == "" || !validatorIsEmail(trimmed) {
		return nil
	}
	return &trimmed
}

// loadNominatimOverridesFromDB reads the override row straight from MySQL. This is
// the authoritative read for the management GET on a cache miss and for every
// write; the process cache is never a merge base.
func (s *Service) loadNominatimOverridesFromDB(ctx context.Context) (nominatimOverrides, error) {
	raw, found, err := s.loadSettingRaw(ctx, settingKeyNominatim)
	if err != nil {
		return nominatimOverrides{}, err
	}
	if !found {
		return nominatimOverrides{}, nil
	}
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || trimmed[0] != '{' {
		return nominatimOverrides{}, nil
	}
	var stored nominatimStoredValue
	if err := json.Unmarshal(trimmed, &stored); err != nil {
		return nominatimOverrides{}, nil
	}
	return nominatimOverrides{
		UserAgent: normalizeUserAgent(stored.UserAgent),
		Email:     normalizeEmail(stored.Email),
	}, nil
}

// applyNominatimFallback mirrors applyFallback: the effective identity falls back
// to GEO_NOMINATIM_USER_AGENT (default "modular-api") and GEO_NOMINATIM_EMAIL.
//
// The environment e-mail is normalized through the same validator, so an
// environment value that is not a valid address degrades to null instead of being
// returned as an effective address.
func (s *Service) applyNominatimFallback(overrides nominatimOverrides) *geoNominatimSettings {
	fallbackUserAgent := s.cfg.NominatimUserAgentDefault
	if fallbackUserAgent == "" {
		fallbackUserAgent = "modular-api"
	}
	fallbackEmail := normalizeEmail(jsonStringValue(s.cfg.NominatimEmailDefault))

	effectiveUserAgent := fallbackUserAgent
	if overrides.UserAgent != nil {
		effectiveUserAgent = *overrides.UserAgent
	}
	var effectiveEmail *string
	if overrides.Email != nil {
		effectiveEmail = overrides.Email
	} else {
		effectiveEmail = fallbackEmail
	}
	return &geoNominatimSettings{
		UserAgent:          overrides.UserAgent,
		Email:              overrides.Email,
		EffectiveUserAgent: effectiveUserAgent,
		EffectiveEmail:     effectiveEmail,
	}
}

// getNominatimSettings mirrors getSettings: the process cache is consulted first
// and a miss re-reads MySQL and refreshes the cache.
func (s *Service) getNominatimSettings(ctx context.Context) (*geoNominatimSettings, error) {
	if cached, ok := s.nominatimCache.get(time.Now()); ok {
		return cached, nil
	}
	overrides, err := s.loadNominatimOverridesFromDB(ctx)
	if err != nil {
		return nil, err
	}
	settings := s.applyNominatimFallback(overrides)
	s.nominatimCache.put(settings, time.Now())
	return settings, nil
}

// updateNominatimSettings mirrors updateSettings.
//
// The caller has already asserted the platform admin (DS1) and taken the global
// nominatim lock (DS2); `current` is the raw MySQL override pair read inside that
// lock, so two concurrent updates of userAgent and email both survive.
//
// The audit write is deliberately fire-and-forget: it runs on a detached context
// so a client disconnect cannot cancel it, and its failure is swallowed instead of
// turning a successful write into an HTTP 500. This preserves the NestJS
// `void writeAuditLogBestEffort(...).catch(() => undefined)` contract.
func (s *Service) updateNominatimSettings(ctx context.Context, orgID, actorID string, update *nominatimUpdate, current nominatimOverrides) (*geoNominatimSettings, error) {
	next := nominatimOverrides{
		UserAgent: current.UserAgent,
		Email:     current.Email,
	}
	// An absent member keeps the current override; an explicit null or blank
	// clears it.
	if update.UserAgent.state != presenceMissing {
		if update.UserAgent.state == presenceNull {
			next.UserAgent = nil
		} else {
			next.UserAgent = normalizeUserAgent(jsonStringValue(update.UserAgent.value))
		}
	}
	if update.Email.state != presenceMissing {
		if update.Email.state == presenceNull {
			next.Email = nil
		} else {
			next.Email = normalizeEmail(jsonStringValue(update.Email.value))
		}
	}

	document := nominatimWrittenValue{UserAgent: next.UserAgent, Email: next.Email}
	encoded, err := json.Marshal(document)
	if err != nil {
		return nil, err
	}
	if err := s.upsertNominatim(ctx, encoded, nullableActorID(actorID)); err != nil {
		return nil, err
	}

	metadata, err := json.Marshal(nominatimAuditMetadata{
		UserAgent: next.UserAgent,
		Email:     next.Email,
	})
	if err != nil {
		return nil, err
	}
	go func() {
		auditCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), nominatimAuditTimeout)
		defer cancel()
		if auditErr := s.writeAuditLogBestEffort(auditCtx, orgID, actorID, "geo_nominatim_settings_update", metadata); auditErr != nil {
			logBackground("nominatim settings audit write failed", auditErr)
		}
	}()

	settings := s.applyNominatimFallback(next)
	s.nominatimCache.put(settings, time.Now())
	return settings, nil
}

// nominatimAuditTimeout bounds the detached audit write.
const nominatimAuditTimeout = 15 * time.Second

// invalidateNominatimCache drops the per-process cache entry. It is used by the
// tests and by the geocoding consumers that stay on NestJS; the management write
// path refreshes the entry in place instead of invalidating it.
func (s *Service) invalidateNominatimCache() {
	s.nominatimCache.invalidate()
}

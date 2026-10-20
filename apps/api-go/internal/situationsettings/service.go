package situationsettings

import (
	"context"
	"encoding/json"
	"math"
	"strconv"
	"strings"
)

// GetPublicSettings mirrors getPublicSettings. It reads the stored row once and
// computes the public shape without touching MySQL or Redis again.
func (s *Service) GetPublicSettings(ctx context.Context) (PublicSettings, error) {
	loaded, err := s.loadSettings(ctx)
	if err != nil {
		return PublicSettings{}, err
	}
	return s.publicSettings(&loaded.fields, loaded.stored), nil
}

// Update mirrors updateSettings: resolve every field's tri-state against the
// stored document, encrypt credentials, upsert, audit, invalidate the cache and
// build the response from the written value (O3).
func (s *Service) Update(ctx context.Context, orgID, actorID string, input UpdateInput) (PublicSettings, error) {
	loaded, err := s.loadSettings(ctx)
	if err != nil {
		return PublicSettings{}, err
	}
	// NestJS only reads system_security when a credential is actually being
	// encoded, so a PUT that keeps every key does not depend on that row.
	var encoder secretEncoder
	if updateNeedsSecretEncoder(input) {
		encoder, err = s.loadSecretEncoder(ctx)
		if err != nil {
			return PublicSettings{}, err
		}
	}
	next, metadata, err := s.buildNextStored(loaded.fields, input, encoder)
	if err != nil {
		return PublicSettings{}, err
	}
	encoded, err := json.Marshal(next)
	if err != nil {
		return PublicSettings{}, err
	}
	if err := s.upsertSettings(ctx, encoded); err != nil {
		return PublicSettings{}, err
	}
	s.writeAuditLogBestEffort(ctx, orgID, actorID, "situation_monitor_update", metadata)
	s.invalidateSettingsCache(ctx)

	// O3: the response and the cache are built from the exact bytes just
	// written, decoded in memory. This is equivalent to the NestJS post-write
	// getPublicSettings (which deletes the cache, reads MySQL and repopulates
	// the same envelope) and is proven by the equivalence test.
	fields := decodeStoredFields(encoded)
	loaded = loadedSettings{exists: true, stored: true, raw: encoded, fields: fields}
	s.writeSettingsCache(ctx, loaded)
	return s.publicSettings(&fields, true), nil
}

// Reset mirrors resetToEnv: delete the row, audit, invalidate and compute the
// environment-backed response without a re-read (O3).
func (s *Service) Reset(ctx context.Context, orgID, actorID string) (PublicSettings, error) {
	if err := s.deleteSettings(ctx); err != nil {
		return PublicSettings{}, err
	}
	metadata, err := json.Marshal(resetAuditMetadata{Ok: true})
	if err != nil {
		return PublicSettings{}, err
	}
	s.writeAuditLogBestEffort(ctx, orgID, actorID, "situation_monitor_reset", metadata)
	s.invalidateSettingsCache(ctx)
	s.writeSettingsCache(ctx, loadedSettings{exists: false})
	return s.publicSettings(nil, false), nil
}

// ClearTelegramConfiguration mirrors clearTelegramConfiguration: keep every
// stored member except the four Telegram credential fields, which are reset to
// false/null.
func (s *Service) ClearTelegramConfiguration(ctx context.Context, orgID, actorID string) (PublicSettings, error) {
	loaded, err := s.loadSettings(ctx)
	if err != nil {
		return PublicSettings{}, err
	}
	encoded, err := clearTelegramStoredValue(loaded.raw)
	if err != nil {
		return PublicSettings{}, err
	}
	if err := s.upsertSettings(ctx, encoded); err != nil {
		return PublicSettings{}, err
	}
	metadata, err := json.Marshal(clearTelegramAuditMetadata{
		Ok:                     true,
		TelegramEnabled:        false,
		TelegramAPIIDCleared:   true,
		TelegramAPIHashCleared: true,
		TelegramSessionCleared: true,
	})
	if err != nil {
		return PublicSettings{}, err
	}
	s.writeAuditLogBestEffort(ctx, orgID, actorID, "situation_monitor_telegram_clear", metadata)
	s.invalidateSettingsCache(ctx)
	fields := decodeStoredFields(encoded)
	s.writeSettingsCache(ctx, loadedSettings{exists: true, stored: true, raw: encoded, fields: fields})
	return s.publicSettings(&fields, true), nil
}

// ClearTelegramStateEverywhere is the T1 cross-instance clear used after a
// reset without a session and after clearing the Telegram authorization.
func (s *Service) ClearTelegramStateEverywhere(ctx context.Context) {
	s.clearTelegramStateEverywhere(ctx)
}

// resolveEffective mirrors resolveEffectiveConfig.
func (s *Service) resolveEffective(stored *storedFields) EffectiveSettings {
	raw := func(pick func(*storedFields) json.RawMessage) json.RawMessage {
		if stored == nil {
			return nil
		}
		return pick(stored)
	}

	storedTranslationAPIKey, _ := resolveStoredAPIKey(raw(func(f *storedFields) json.RawMessage { return f.TranslationAPIKey }), "translation api key", s.env)
	storedFinnhubAPIKey, _ := resolveStoredAPIKey(raw(func(f *storedFields) json.RawMessage { return f.FinnhubAPIKey }), "finnhub api key", s.env)
	storedFredAPIKey, _ := resolveStoredAPIKey(raw(func(f *storedFields) json.RawMessage { return f.FredAPIKey }), "fred api key", s.env)
	storedTelegramAPIID, _ := normalizeStringRaw(raw(func(f *storedFields) json.RawMessage { return f.TelegramAPIID }))
	storedTelegramAPIHash, _ := resolveStoredAPIKey(raw(func(f *storedFields) json.RawMessage { return f.TelegramAPIHash }), "telegram api hash", s.env)
	storedTelegramSession, _ := resolveStoredAPIKey(raw(func(f *storedFields) json.RawMessage { return f.TelegramSession }), "telegram session", s.env)

	translationBaseURL := ""
	if value, ok := normalizeURLRaw(raw(func(f *storedFields) json.RawMessage { return f.TranslationAPIBaseURL })); ok {
		translationBaseURL = value
	} else if value, ok := normalizeEnvURL(s.env.TranslationAPIBaseURL); ok {
		translationBaseURL = value
	} else {
		translationBaseURL = defaultTranslationAPIBaseURL
	}
	fallbackBaseURL := ""
	if value, ok := normalizeURLRaw(raw(func(f *storedFields) json.RawMessage { return f.TranslationFallbackAPIBaseURL })); ok {
		fallbackBaseURL = value
	} else if value, ok := normalizeEnvURL(s.env.TranslationFallbackAPIBaseURL); ok {
		fallbackBaseURL = value
	}

	telegramAPIID := storedTelegramAPIID
	if telegramAPIID == "" {
		telegramAPIID = s.env.TelegramAPIID
	}
	telegramAPIHash := storedTelegramAPIHash
	if telegramAPIHash == "" {
		telegramAPIHash = s.env.TelegramAPIHash
	}
	channelSet := ""
	if value, ok := normalizeStringRaw(raw(func(f *storedFields) json.RawMessage { return f.TelegramChannelSet })); ok {
		channelSet = value
	} else {
		channelSet = s.env.TelegramChannelSet
	}

	return EffectiveSettings{
		TranslationMaxConcurrency: asBoundedIntRaw(raw(func(f *storedFields) json.RawMessage { return f.TranslationMaxConcurrency }),
			defaultTranslationMaxConcurrency, minTranslationMaxConcurrency, maxTranslationMaxConcurrency),
		TranslationAPIEnabled: asBooleanRaw(raw(func(f *storedFields) json.RawMessage { return f.TranslationAPIEnabled }), s.env.TranslationAPIEnabled),
		TranslationAPIBaseURL: translationBaseURL,
		TranslationAPIKey:     storedTranslationAPIKey,
		TranslationFallbackAPIEnabled: asBooleanRaw(raw(func(f *storedFields) json.RawMessage { return f.TranslationFallbackAPIEnabled }),
			s.env.TranslationFallbackAPIEnabled),
		TranslationFallbackAPIBaseURL: fallbackBaseURL,
		FinnhubAPIKey:                 storedFinnhubAPIKey,
		FredAPIKey:                    storedFredAPIKey,
		TranslationAPITimeoutMS: asBoundedIntRaw(raw(func(f *storedFields) json.RawMessage { return f.TranslationAPITimeoutMS }),
			s.env.TranslationAPITimeoutMS, minTranslationAPITimeoutMS, maxTranslationAPITimeoutMS),
		TranslationAPIMaxRetries: asBoundedIntRaw(raw(func(f *storedFields) json.RawMessage { return f.TranslationAPIMaxRetries }),
			s.env.TranslationAPIMaxRetries, minTranslationAPIMaxRetries, maxTranslationAPIMaxRetries),
		TelegramEnabled:              asBooleanRaw(raw(func(f *storedFields) json.RawMessage { return f.TelegramEnabled }), s.env.TelegramEnabled),
		TelegramAPIID:                telegramAPIID,
		TelegramAPIHash:              telegramAPIHash,
		TelegramSession:              storedTelegramSession,
		TelegramChannelSet:           channelSet,
		TelegramMaxFeedItems:         asBoundedIntRaw(raw(func(f *storedFields) json.RawMessage { return f.TelegramMaxFeedItems }), s.env.TelegramMaxFeedItems, minTelegramMaxFeedItems, maxTelegramMaxFeedItems),
		TelegramMaxTextChars:         asBoundedIntRaw(raw(func(f *storedFields) json.RawMessage { return f.TelegramMaxTextChars }), s.env.TelegramMaxTextChars, minTelegramMaxTextChars, maxTelegramMaxTextChars),
		TelegramChannelTimeoutMS:     asBoundedIntRaw(raw(func(f *storedFields) json.RawMessage { return f.TelegramChannelTimeoutMS }), s.env.TelegramChannelTimeoutMS, minTelegramChannelTimeoutMS, maxTelegramChannelTimeoutMS),
		TelegramPollCycleTimeoutMS:   asBoundedIntRaw(raw(func(f *storedFields) json.RawMessage { return f.TelegramPollCycleTimeoutMS }), s.env.TelegramPollCycleTimeoutMS, minTelegramPollCycleTimeoutMS, maxTelegramPollCycleTimeoutMS),
		TelegramStartupDelayMS:       asBoundedIntRaw(raw(func(f *storedFields) json.RawMessage { return f.TelegramStartupDelayMS }), s.env.TelegramStartupDelayMS, minTelegramStartupDelayMS, maxTelegramStartupDelayMS),
		TelegramRateLimitMS:          asBoundedIntRaw(raw(func(f *storedFields) json.RawMessage { return f.TelegramRateLimitMS }), s.env.TelegramRateLimitMS, minTelegramRateLimitMS, maxTelegramRateLimitMS),
		TelegramPollIntervalMS:       asBoundedIntRaw(raw(func(f *storedFields) json.RawMessage { return f.TelegramPollIntervalMS }), s.env.TelegramPollIntervalMS, minTelegramPollIntervalMS, maxTelegramPollIntervalMS),
		LiveHLSProxyCnnUpstreamURL:   normalizeHTTPSURLRaw(raw(func(f *storedFields) json.RawMessage { return f.LiveHLSProxyCnnUpstreamURL })),
		LiveHLSProxyCnnReferer:       normalizeHTTPURLRaw(raw(func(f *storedFields) json.RawMessage { return f.LiveHLSProxyCnnReferer })),
		LiveHLSProxyCnnAllowedHosts:  normalizeHostListRaw(raw(func(f *storedFields) json.RawMessage { return f.LiveHLSProxyCnnAllowedHosts })),
		LiveHLSProxyCnbcUpstreamURL:  normalizeHTTPSURLRaw(raw(func(f *storedFields) json.RawMessage { return f.LiveHLSProxyCnbcUpstreamURL })),
		LiveHLSProxyCnbcReferer:      normalizeHTTPURLRaw(raw(func(f *storedFields) json.RawMessage { return f.LiveHLSProxyCnbcReferer })),
		LiveHLSProxyCnbcAllowedHosts: normalizeHostListRaw(raw(func(f *storedFields) json.RawMessage { return f.LiveHLSProxyCnbcAllowedHosts })),
	}
}

// publicSettings builds SituationMonitorSettingsPublic from a stored projection.
func (s *Service) publicSettings(stored *storedFields, exists bool) PublicSettings {
	effective := s.resolveEffective(stored)
	raw := func(pick func(*storedFields) json.RawMessage) json.RawMessage {
		if stored == nil {
			return nil
		}
		return pick(stored)
	}

	storedTranslationAPIKey, _ := resolveStoredAPIKey(raw(func(f *storedFields) json.RawMessage { return f.TranslationAPIKey }), "translation api key", s.env)
	storedFinnhubAPIKey, _ := resolveStoredAPIKey(raw(func(f *storedFields) json.RawMessage { return f.FinnhubAPIKey }), "finnhub api key", s.env)
	storedFredAPIKey, _ := resolveStoredAPIKey(raw(func(f *storedFields) json.RawMessage { return f.FredAPIKey }), "fred api key", s.env)
	storedTelegramAPIID, _ := normalizeStringRaw(raw(func(f *storedFields) json.RawMessage { return f.TelegramAPIID }))
	storedTelegramAPIHash, _ := resolveStoredAPIKey(raw(func(f *storedFields) json.RawMessage { return f.TelegramAPIHash }), "telegram api hash", s.env)
	storedTelegramSession, _ := resolveStoredAPIKey(raw(func(f *storedFields) json.RawMessage { return f.TelegramSession }), "telegram session", s.env)

	source := SettingsSourceEnv
	if exists {
		source = SettingsSourceDB
	}

	var telegramAPIID *string
	if effective.TelegramAPIID != "" {
		value := effective.TelegramAPIID
		telegramAPIID = &value
	}

	orefConfigured := s.env.OrefProxyAuth != ""
	orefSource := OrefSecretSourceNone
	if orefConfigured {
		orefSource = OrefSecretSourceEnv
	}

	cnnConfigured := effective.LiveHLSProxyCnnUpstreamURL != nil
	cnnSource := LiveHLSProxySourceNone
	cnnURL := ""
	if cnnConfigured {
		cnnSource = LiveHLSProxySourceStored
		cnnURL = *effective.LiveHLSProxyCnnUpstreamURL
	}
	cnnReferer := ""
	if effective.LiveHLSProxyCnnReferer != nil {
		cnnReferer = *effective.LiveHLSProxyCnnReferer
	}
	cnbcConfigured := effective.LiveHLSProxyCnbcUpstreamURL != nil
	cnbcSource := LiveHLSProxySourceNone
	cnbcURL := ""
	if cnbcConfigured {
		cnbcSource = LiveHLSProxySourceStored
		cnbcURL = *effective.LiveHLSProxyCnbcUpstreamURL
	}
	cnbcReferer := ""
	if effective.LiveHLSProxyCnbcReferer != nil {
		cnbcReferer = *effective.LiveHLSProxyCnbcReferer
	}

	return PublicSettings{
		Source:                        source,
		TranslationMaxConcurrency:     effective.TranslationMaxConcurrency,
		TranslationProvider:           translationProviderDeepLX,
		TranslationAPIEnabled:         effective.TranslationAPIEnabled,
		TranslationAPIBaseURL:         effective.TranslationAPIBaseURL,
		TranslationFallbackAPIEnabled: effective.TranslationFallbackAPIEnabled,
		TranslationFallbackAPIBaseURL: effective.TranslationFallbackAPIBaseURL,
		TranslationAPITimeoutMS:       effective.TranslationAPITimeoutMS,
		TranslationAPIMaxRetries:      effective.TranslationAPIMaxRetries,
		HasTranslationAPIKey:          effective.TranslationAPIKey != "",
		TranslationAPIKeySource:       resolveAPIKeySource(storedTranslationAPIKey, effective.TranslationAPIKey),
		HasFinnhubAPIKey:              effective.FinnhubAPIKey != "",
		FinnhubAPIKeySource:           resolveAPIKeySource(storedFinnhubAPIKey, effective.FinnhubAPIKey),
		HasFredAPIKey:                 effective.FredAPIKey != "",
		FredAPIKeySource:              resolveAPIKeySource(storedFredAPIKey, effective.FredAPIKey),
		TelegramEnabled:               effective.TelegramEnabled,
		HasTelegramAPIID:              effective.TelegramAPIID != "",
		TelegramAPIIDSource:           resolveAPIKeySource(storedTelegramAPIID, effective.TelegramAPIID),
		TelegramAPIID:                 telegramAPIID,
		HasTelegramAPIHash:            effective.TelegramAPIHash != "",
		TelegramAPIHashSource:         resolveAPIKeySource(storedTelegramAPIHash, effective.TelegramAPIHash),
		HasTelegramSession:            effective.TelegramSession != "",
		TelegramSessionSource:         resolveAPIKeySource(storedTelegramSession, effective.TelegramSession),
		OrefEnabled:                   s.env.OrefEnabled,
		OrefConfigured:                orefConfigured,
		OrefProxyAuthSource:           orefSource,
		TelegramChannelSet:            effective.TelegramChannelSet,
		TelegramMaxFeedItems:          effective.TelegramMaxFeedItems,
		TelegramMaxTextChars:          effective.TelegramMaxTextChars,
		TelegramChannelTimeoutMS:      effective.TelegramChannelTimeoutMS,
		TelegramPollCycleTimeoutMS:    effective.TelegramPollCycleTimeoutMS,
		TelegramStartupDelayMS:        effective.TelegramStartupDelayMS,
		TelegramRateLimitMS:           effective.TelegramRateLimitMS,
		TelegramPollIntervalMS:        effective.TelegramPollIntervalMS,
		LiveHLSProxyCnnConfigured:     cnnConfigured,
		LiveHLSProxyCnnSource:         cnnSource,
		LiveHLSProxyCnnUpstreamURL:    cnnURL,
		LiveHLSProxyCnnReferer:        cnnReferer,
		LiveHLSProxyCnnAllowedHosts:   effective.LiveHLSProxyCnnAllowedHosts,
		LiveHLSProxyCnbcConfigured:    cnbcConfigured,
		LiveHLSProxyCnbcSource:        cnbcSource,
		LiveHLSProxyCnbcUpstreamURL:   cnbcURL,
		LiveHLSProxyCnbcReferer:       cnbcReferer,
		LiveHLSProxyCnbcAllowedHosts:  effective.LiveHLSProxyCnbcAllowedHosts,
	}
}

// buildNextStored mirrors the field-by-field merge and the audit metadata of
// updateSettings.
func (s *Service) buildNextStored(stored storedFields, input UpdateInput, encoder secretEncoder) (storedValue, json.RawMessage, error) {
	current := s.resolveEffective(&stored)
	storedRaw := func(pick func(*storedFields) json.RawMessage) json.RawMessage { return pick(&stored) }

	next := storedValue{
		TranslationMaxConcurrency:     clampInt(input.TranslationMaxConcurrency, minTranslationMaxConcurrency, maxTranslationMaxConcurrency),
		TranslationAPIEnabled:         asBooleanInput(input.TranslationAPIEnabled, current.TranslationAPIEnabled),
		TranslationAPITimeoutMS:       asBoundedIntInput(input.TranslationAPITimeoutMS, current.TranslationAPITimeoutMS, minTranslationAPITimeoutMS, maxTranslationAPITimeoutMS),
		TranslationAPIMaxRetries:      asBoundedIntInput(input.TranslationAPIMaxRetries, current.TranslationAPIMaxRetries, minTranslationAPIMaxRetries, maxTranslationAPIMaxRetries),
		TranslationFallbackAPIEnabled: asBooleanInput(input.TranslationFallbackAPIEnabled, current.TranslationFallbackAPIEnabled),
		TelegramEnabled:               asBooleanInput(input.TelegramEnabled, current.TelegramEnabled),
		TelegramChannelSet:            asStringInput(input.TelegramChannelSet, current.TelegramChannelSet, defaultTelegramChannelSet),
		TelegramMaxFeedItems:          asBoundedIntInput(input.TelegramMaxFeedItems, current.TelegramMaxFeedItems, minTelegramMaxFeedItems, maxTelegramMaxFeedItems),
		TelegramMaxTextChars:          asBoundedIntInput(input.TelegramMaxTextChars, current.TelegramMaxTextChars, minTelegramMaxTextChars, maxTelegramMaxTextChars),
		TelegramChannelTimeoutMS:      asBoundedIntInput(input.TelegramChannelTimeoutMS, current.TelegramChannelTimeoutMS, minTelegramChannelTimeoutMS, maxTelegramChannelTimeoutMS),
		TelegramPollCycleTimeoutMS:    asBoundedIntInput(input.TelegramPollCycleTimeoutMS, current.TelegramPollCycleTimeoutMS, minTelegramPollCycleTimeoutMS, maxTelegramPollCycleTimeoutMS),
		TelegramStartupDelayMS:        asBoundedIntInput(input.TelegramStartupDelayMS, current.TelegramStartupDelayMS, minTelegramStartupDelayMS, maxTelegramStartupDelayMS),
		TelegramRateLimitMS:           asBoundedIntInput(input.TelegramRateLimitMS, current.TelegramRateLimitMS, minTelegramRateLimitMS, maxTelegramRateLimitMS),
		TelegramPollIntervalMS:        asBoundedIntInput(input.TelegramPollIntervalMS, current.TelegramPollIntervalMS, minTelegramPollIntervalMS, maxTelegramPollIntervalMS),
	}

	var err error
	next.TranslationAPIBaseURL, err = resolveNextURL(storedRaw(func(f *storedFields) json.RawMessage { return f.TranslationAPIBaseURL }),
		input.TranslationAPIBaseURL, "translationApiBaseUrl", "http", "https")
	if err != nil {
		return storedValue{}, nil, err
	}
	next.TranslationFallbackAPIBaseURL, err = resolveNextURL(storedRaw(func(f *storedFields) json.RawMessage { return f.TranslationFallbackAPIBaseURL }),
		input.TranslationFallbackAPIBaseURL, "translationFallbackApiBaseUrl", "http", "https")
	if err != nil {
		return storedValue{}, nil, err
	}
	next.TranslationAPIKey, err = resolveNextAPIKey(storedRaw(func(f *storedFields) json.RawMessage { return f.TranslationAPIKey }),
		input.TranslationAPIKey, encoder, s.env)
	if err != nil {
		return storedValue{}, nil, err
	}
	next.FinnhubAPIKey, err = resolveNextAPIKey(storedRaw(func(f *storedFields) json.RawMessage { return f.FinnhubAPIKey }), input.FinnhubAPIKey, encoder, s.env)
	if err != nil {
		return storedValue{}, nil, err
	}
	next.FredAPIKey, err = resolveNextAPIKey(storedRaw(func(f *storedFields) json.RawMessage { return f.FredAPIKey }), input.FredAPIKey, encoder, s.env)
	if err != nil {
		return storedValue{}, nil, err
	}
	// telegramApiId is not a member of this DTO either; preserve the current
	// normalized value exactly like resolveNextString(current, undefined).
	next.TelegramAPIID, _ = resolveNextString(storedRaw(func(f *storedFields) json.RawMessage { return f.TelegramAPIID }),
		optionalString{state: presenceMissing})
	// telegramApiId/apiHash/session are not members of this DTO (telegram-auth
	// start/complete stay on NestJS), so they are always preserved as-is. The
	// audit flags therefore stay false, exactly like the NestJS DTO path.
	next.TelegramAPIHash = copyRaw(storedRaw(func(f *storedFields) json.RawMessage { return f.TelegramAPIHash }))
	next.TelegramSession = copyRaw(storedRaw(func(f *storedFields) json.RawMessage { return f.TelegramSession }))
	next.LiveHLSProxyCnnUpstreamURL, err = resolveNextURL(storedRaw(func(f *storedFields) json.RawMessage { return f.LiveHLSProxyCnnUpstreamURL }),
		input.LiveHLSProxyCnnUpstreamURL, "liveHlsProxyCnnUpstreamUrl", "https")
	if err != nil {
		return storedValue{}, nil, err
	}
	next.LiveHLSProxyCnnReferer, err = resolveNextURL(storedRaw(func(f *storedFields) json.RawMessage { return f.LiveHLSProxyCnnReferer }),
		input.LiveHLSProxyCnnReferer, "liveHlsProxyCnnReferer", "http", "https")
	if err != nil {
		return storedValue{}, nil, err
	}
	next.LiveHLSProxyCnnAllowedHosts, err = resolveNextHostList(storedRaw(func(f *storedFields) json.RawMessage { return f.LiveHLSProxyCnnAllowedHosts }),
		input.LiveHLSProxyCnnAllowedHosts, "liveHlsProxyCnnAllowedHosts")
	if err != nil {
		return storedValue{}, nil, err
	}
	next.LiveHLSProxyCnbcUpstreamURL, err = resolveNextURL(storedRaw(func(f *storedFields) json.RawMessage { return f.LiveHLSProxyCnbcUpstreamURL }),
		input.LiveHLSProxyCnbcUpstreamURL, "liveHlsProxyCnbcUpstreamUrl", "https")
	if err != nil {
		return storedValue{}, nil, err
	}
	next.LiveHLSProxyCnbcReferer, err = resolveNextURL(storedRaw(func(f *storedFields) json.RawMessage { return f.LiveHLSProxyCnbcReferer }),
		input.LiveHLSProxyCnbcReferer, "liveHlsProxyCnbcReferer", "http", "https")
	if err != nil {
		return storedValue{}, nil, err
	}
	next.LiveHLSProxyCnbcAllowedHosts, err = resolveNextHostList(storedRaw(func(f *storedFields) json.RawMessage { return f.LiveHLSProxyCnbcAllowedHosts }),
		input.LiveHLSProxyCnbcAllowedHosts, "liveHlsProxyCnbcAllowedHosts")
	if err != nil {
		return storedValue{}, nil, err
	}

	metadata, err := json.Marshal(updateAuditMetadata{
		Ok:                                true,
		TranslationMaxConcurrency:         next.TranslationMaxConcurrency,
		TranslationAPIEnabled:             next.TranslationAPIEnabled,
		TranslationAPIBaseURL:             next.TranslationAPIBaseURL,
		TranslationFallbackAPIEnabled:     next.TranslationFallbackAPIEnabled,
		TranslationFallbackAPIBaseURL:     next.TranslationFallbackAPIBaseURL,
		TranslationAPITimeoutMS:           next.TranslationAPITimeoutMS,
		TranslationAPIMaxRetries:          next.TranslationAPIMaxRetries,
		TranslationAPIKeyUpdated:          provided(input.TranslationAPIKey.state),
		FinnhubAPIKeyUpdated:              provided(input.FinnhubAPIKey.state),
		FredAPIKeyUpdated:                 provided(input.FredAPIKey.state),
		TelegramEnabled:                   next.TelegramEnabled,
		TelegramChannelSet:                next.TelegramChannelSet,
		TelegramMaxFeedItems:              next.TelegramMaxFeedItems,
		TelegramMaxTextChars:              next.TelegramMaxTextChars,
		TelegramChannelTimeoutMS:          next.TelegramChannelTimeoutMS,
		TelegramPollCycleTimeoutMS:        next.TelegramPollCycleTimeoutMS,
		TelegramStartupDelayMS:            next.TelegramStartupDelayMS,
		TelegramRateLimitMS:               next.TelegramRateLimitMS,
		TelegramPollIntervalMS:            next.TelegramPollIntervalMS,
		TelegramAPIIDUpdated:              false,
		TelegramAPIHashUpdated:            false,
		TelegramSessionUpdated:            false,
		LiveHLSProxyCnnConfigured:         next.LiveHLSProxyCnnUpstreamURL != nil,
		LiveHLSProxyCnnAllowedHostsCount:  len(next.LiveHLSProxyCnnAllowedHosts),
		LiveHLSProxyCnbcConfigured:        next.LiveHLSProxyCnbcUpstreamURL != nil,
		LiveHLSProxyCnbcAllowedHostsCount: len(next.LiveHLSProxyCnbcAllowedHosts),
		LiveHLSProxyCnnUpdated: provided(input.LiveHLSProxyCnnUpstreamURL.state) ||
			provided(input.LiveHLSProxyCnnReferer.state) ||
			provided(input.LiveHLSProxyCnnAllowedHosts.state),
		LiveHLSProxyCnbcUpdated: provided(input.LiveHLSProxyCnbcUpstreamURL.state) ||
			provided(input.LiveHLSProxyCnbcReferer.state) ||
			provided(input.LiveHLSProxyCnbcAllowedHosts.state),
	})
	if err != nil {
		return storedValue{}, nil, err
	}
	return next, metadata, nil
}

// updateNeedsSecretEncoder reports whether any of the three credential fields
// present in this DTO would call encodeSecretForStorage. Missing, null and
// empty-string values clear or keep the stored value and never touch
// system_security.
func updateNeedsSecretEncoder(input UpdateInput) bool {
	for _, field := range []optionalString{input.TranslationAPIKey, input.FinnhubAPIKey, input.FredAPIKey} {
		if field.state == presenceValue && strings.TrimSpace(field.value) != "" {
			return true
		}
	}
	return false
}

// ---- option merge helpers ----

func asBooleanInput(input optionalBool, fallback bool) bool {
	if input.state == presenceValue {
		return input.value
	}
	return fallback
}

func asBoundedIntInput(input optionalNumber, fallback, min, max int) int {
	switch input.state {
	case presenceMissing:
		return clampInt(fallback, min, max)
	case presenceNull:
		return clampInt(0, min, max)
	default:
		return clampInt(int(math.Trunc(input.value)), min, max)
	}
}

func asStringInput(input optionalString, fallback, defaultValue string) string {
	if input.state != presenceValue {
		return fallback
	}
	trimmed := strings.TrimSpace(input.value)
	if trimmed == "" {
		return defaultValue
	}
	return trimmed
}

// resolveNextURL mirrors resolveNextApiBaseUrl / resolveNextHttpsUrl /
// resolveNextHttpUrl: absent keeps the stored normalized value, null and the
// empty string clear it, anything else must validate.
func resolveNextURL(current json.RawMessage, input optionalString, fieldName string, protocols ...string) (*string, error) {
	if input.state == presenceMissing {
		value, ok := normalizeURLRaw(current)
		if !ok {
			return nil, nil
		}
		return &value, nil
	}
	normalized := strings.TrimSpace(input.value)
	if input.state == presenceNull || normalized == "" {
		return nil, nil
	}
	value, err := validateURL(normalized, fieldName, protocols...)
	if err != nil {
		return nil, err
	}
	return &value, nil
}

// resolveNextString mirrors resolveNextString.
func resolveNextString(current json.RawMessage, input optionalString) (*string, error) {
	if input.state == presenceMissing {
		value, ok := normalizeStringRaw(current)
		if !ok {
			return nil, nil
		}
		return &value, nil
	}
	normalized := strings.TrimSpace(input.value)
	if input.state == presenceNull || normalized == "" {
		return nil, nil
	}
	return &normalized, nil
}

// resolveNextAPIKey mirrors resolveNextApiKey. A missing member keeps the exact
// stored bytes; present null or an empty string clears the value; anything else
// goes through the shared encryption policy.
func resolveNextAPIKey(current json.RawMessage, input optionalString, encoder secretEncoder, env Env) (json.RawMessage, error) {
	if input.state == presenceMissing {
		return copyRaw(current), nil
	}
	normalized := strings.TrimSpace(input.value)
	if input.state == presenceNull || normalized == "" {
		return nil, nil
	}
	return encoder.encodeSecretForStorage(normalized, env)
}

// resolveNextHostList mirrors resolveNextHostList.
func resolveNextHostList(current json.RawMessage, input optionalString, fieldName string) ([]string, error) {
	if input.state == presenceMissing {
		return normalizeHostListRaw(current), nil
	}
	normalized := strings.TrimSpace(input.value)
	if input.state == presenceNull || normalized == "" {
		return []string{}, nil
	}
	return parseHostCSV(normalized, fieldName)
}

func copyRaw(raw json.RawMessage) json.RawMessage {
	if len(raw) == 0 {
		return nil
	}
	return append(json.RawMessage(nil), raw...)
}

// normalizeEnvURL mirrors normalizeUrl for an environment string.
func normalizeEnvURL(value string) (string, bool) {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return "", false
	}
	return strings.TrimRight(trimmed, "/"), true
}

// clearTelegramStoredValue mirrors `{...stored, telegramEnabled:false,
// telegramApiId:null, telegramApiHash:null, telegramSession:null}`. Unknown
// members written by an older revision survive, because the NestJS spread keeps
// them. The map is a JSON-object merge, not a business container.
func clearTelegramStoredValue(raw json.RawMessage) ([]byte, error) {
	merged := map[string]json.RawMessage{}
	trimmed := strings.TrimSpace(string(raw))
	switch {
	case strings.HasPrefix(trimmed, "{"):
		_ = json.Unmarshal(raw, &merged)
	case strings.HasPrefix(trimmed, "["):
		// JavaScript object spread of an array keeps its numeric indices as
		// string keys; reproduce that instead of dropping them.
		var items []json.RawMessage
		if json.Unmarshal(raw, &items) == nil {
			for index, item := range items {
				merged[strconv.Itoa(index)] = item
			}
		}
	}
	merged["telegramEnabled"] = json.RawMessage("false")
	merged["telegramApiId"] = json.RawMessage("null")
	merged["telegramApiHash"] = json.RawMessage("null")
	merged["telegramSession"] = json.RawMessage("null")
	return json.Marshal(merged)
}

// ---- audit metadata ----

type updateAuditMetadata struct {
	Ok                                bool    `json:"ok"`
	TranslationMaxConcurrency         int     `json:"translationMaxConcurrency"`
	TranslationAPIEnabled             bool    `json:"translationApiEnabled"`
	TranslationAPIBaseURL             *string `json:"translationApiBaseUrl"`
	TranslationFallbackAPIEnabled     bool    `json:"translationFallbackApiEnabled"`
	TranslationFallbackAPIBaseURL     *string `json:"translationFallbackApiBaseUrl"`
	TranslationAPITimeoutMS           int     `json:"translationApiTimeoutMs"`
	TranslationAPIMaxRetries          int     `json:"translationApiMaxRetries"`
	TranslationAPIKeyUpdated          bool    `json:"translationApiKeyUpdated"`
	FinnhubAPIKeyUpdated              bool    `json:"finnhubApiKeyUpdated"`
	FredAPIKeyUpdated                 bool    `json:"fredApiKeyUpdated"`
	TelegramEnabled                   bool    `json:"telegramEnabled"`
	TelegramChannelSet                string  `json:"telegramChannelSet"`
	TelegramMaxFeedItems              int     `json:"telegramMaxFeedItems"`
	TelegramMaxTextChars              int     `json:"telegramMaxTextChars"`
	TelegramChannelTimeoutMS          int     `json:"telegramChannelTimeoutMs"`
	TelegramPollCycleTimeoutMS        int     `json:"telegramPollCycleTimeoutMs"`
	TelegramStartupDelayMS            int     `json:"telegramStartupDelayMs"`
	TelegramRateLimitMS               int     `json:"telegramRateLimitMs"`
	TelegramPollIntervalMS            int     `json:"telegramPollIntervalMs"`
	TelegramAPIIDUpdated              bool    `json:"telegramApiIdUpdated"`
	TelegramAPIHashUpdated            bool    `json:"telegramApiHashUpdated"`
	TelegramSessionUpdated            bool    `json:"telegramSessionUpdated"`
	LiveHLSProxyCnnConfigured         bool    `json:"liveHlsProxyCnnConfigured"`
	LiveHLSProxyCnnAllowedHostsCount  int     `json:"liveHlsProxyCnnAllowedHostsCount"`
	LiveHLSProxyCnbcConfigured        bool    `json:"liveHlsProxyCnbcConfigured"`
	LiveHLSProxyCnbcAllowedHostsCount int     `json:"liveHlsProxyCnbcAllowedHostsCount"`
	LiveHLSProxyCnnUpdated            bool    `json:"liveHlsProxyCnnUpdated"`
	LiveHLSProxyCnbcUpdated           bool    `json:"liveHlsProxyCnbcUpdated"`
}

type resetAuditMetadata struct {
	Ok bool `json:"ok"`
}

type clearTelegramAuditMetadata struct {
	Ok                     bool `json:"ok"`
	TelegramEnabled        bool `json:"telegramEnabled"`
	TelegramAPIIDCleared   bool `json:"telegramApiIdCleared"`
	TelegramAPIHashCleared bool `json:"telegramApiHashCleared"`
	TelegramSessionCleared bool `json:"telegramSessionCleared"`
}

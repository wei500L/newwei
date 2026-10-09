package dashboardwarmap

import (
	"bytes"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"sync"
	"time"
)

const (
	translationCachePrefix = "situation-monitor:translation:v3:zh-cn:multi:"
	translationCacheTTL    = 30 * 24 * time.Hour
	translationSettingsKey = "situation_monitor_settings"
	settingsCacheKey       = "situation-monitor:settings"
)

type translator interface {
	ToZH(ctx context.Context, texts []string) map[string]string
}

type translationConfig struct {
	Enabled         bool
	BaseURL         string
	APIKey          string
	FallbackEnabled bool
	FallbackBaseURL string
	Timeout         time.Duration
	MaxRetries      int
	MaxConcurrency  int
	EncryptionKey   string
}

type liveTranslator struct {
	cache  blobCache
	db     settingsDB
	config translationConfig
	http   *http.Client
}

func newLiveTranslator(cache blobCache, db settingsDB, cfg translationConfig) *liveTranslator {
	if cfg.BaseURL == "" {
		cfg.BaseURL = "https://api.deeplx.org"
	}
	if cfg.Timeout <= 0 {
		cfg.Timeout = 15 * time.Second
	}
	if cfg.MaxRetries < 0 {
		cfg.MaxRetries = 2
	}
	if cfg.MaxConcurrency < 1 {
		cfg.MaxConcurrency = 2
	}
	return &liveTranslator{cache: cache, db: db, config: cfg, http: &http.Client{}}
}

func (t *liveTranslator) ToZH(ctx context.Context, texts []string) map[string]string {
	targets := map[string]string{}
	order := make([]string, 0)
	for _, text := range texts {
		text = strings.TrimSpace(text)
		if text == "" {
			continue
		}
		sum := sha256.Sum256([]byte(text))
		hash := hex.EncodeToString(sum[:])
		if _, ok := targets[hash]; ok {
			continue
		}
		targets[hash] = text
		order = append(order, hash)
	}
	if len(order) == 0 {
		return map[string]string{}
	}
	runtime, err := t.runtime(ctx)
	if err != nil {
		log.Printf("dashboard war map: translation config unavailable")
		return map[string]string{}
	}
	if err := assertTranslation(runtime); err != nil {
		log.Printf("dashboard war map: translation unavailable")
		return map[string]string{}
	}
	translated := map[string]string{}
	var missing []string
	for _, hash := range order {
		if t.cache != nil {
			raw, hit, err := t.cache.Get(ctx, translationCachePrefix+hash)
			if err == nil && hit {
				var value string
				if json.Unmarshal(raw, &value) == nil && value != "" {
					translated[hash] = value
					continue
				}
			}
		}
		missing = append(missing, hash)
	}
	if len(missing) == 0 {
		return byText(targets, translated)
	}
	limit := runtime.MaxConcurrency
	if limit > len(missing) {
		limit = len(missing)
	}
	jobs := make(chan string)
	results := make(chan error, len(missing))
	var mu sync.Mutex
	for i := 0; i < limit; i++ {
		go func() {
			for hash := range jobs {
				text := targets[hash]
				value, err := t.request(ctx, text, runtime)
				if err != nil {
					results <- err
					continue
				}
				if value != "" {
					mu.Lock()
					translated[hash] = value
					mu.Unlock()
					if t.cache != nil {
						body, _ := json.Marshal(value)
						_ = t.cache.Set(ctx, translationCachePrefix+hash, body, translationCacheTTL)
					}
				}
				results <- nil
			}
		}()
	}
	for _, hash := range missing {
		jobs <- hash
	}
	close(jobs)
	failed := false
	for range missing {
		if err := <-results; err != nil {
			failed = true
		}
	}
	if failed {
		log.Printf("dashboard war map: translation request failed")
		return map[string]string{}
	}
	return byText(targets, translated)
}

func byText(targets, translated map[string]string) map[string]string {
	out := map[string]string{}
	for hash, original := range targets {
		if value := translated[hash]; value != "" {
			out[original] = value
		}
	}
	return out
}

func (t *liveTranslator) runtime(ctx context.Context) (translationConfig, error) {
	cfg := t.config
	stored, err := t.stored(ctx)
	if err != nil {
		return translationConfig{}, err
	}
	if stored != nil {
		if value, ok := stored["translationApiEnabled"].(bool); ok {
			cfg.Enabled = value
		}
		if url := trim(stringOrEmpty(stored["translationApiBaseUrl"])); url != "" {
			cfg.BaseURL = strings.TrimRight(url, "/")
		}
		if url := trim(stringOrEmpty(stored["translationFallbackApiBaseUrl"])); url != "" {
			cfg.FallbackBaseURL = strings.TrimRight(url, "/")
		}
		if value, ok := stored["translationFallbackApiEnabled"].(bool); ok {
			cfg.FallbackEnabled = value
		}
		if n, ok := boundedInt(stored["translationApiTimeoutMs"], int(cfg.Timeout/time.Millisecond), 1000, 120000); ok {
			cfg.Timeout = time.Duration(n) * time.Millisecond
		}
		if n, ok := boundedInt(stored["translationApiMaxRetries"], cfg.MaxRetries, 0, 5); ok {
			cfg.MaxRetries = n
		}
		if n, ok := boundedInt(stored["translationMaxConcurrency"], cfg.MaxConcurrency, 1, 5000); ok {
			cfg.MaxConcurrency = n
		}
		if key := t.apiKey(stored["translationApiKey"]); key != "" {
			cfg.APIKey = key
		}
	}
	cfg.BaseURL = strings.TrimRight(cfg.BaseURL, "/")
	cfg.FallbackBaseURL = strings.TrimRight(cfg.FallbackBaseURL, "/")
	return cfg, nil
}

func (t *liveTranslator) stored(ctx context.Context) (map[string]any, error) {
	if t.cache != nil {
		raw, hit, err := t.cache.Get(ctx, settingsCacheKey)
		if err == nil && hit {
			var cached struct {
				Exists bool           `json:"exists"`
				Value  map[string]any `json:"value"`
			}
			if json.Unmarshal(raw, &cached) == nil {
				if !cached.Exists {
					return nil, nil
				}
				return cached.Value, nil
			}
		}
	}
	if t.db == nil {
		return nil, nil
	}
	raw, ok, err := t.db.Setting(ctx, translationSettingsKey)
	if err != nil || !ok {
		return nil, err
	}
	var payload map[string]any
	if json.Unmarshal(raw, &payload) != nil {
		return nil, nil
	}
	return payload, nil
}

func (t *liveTranslator) apiKey(raw any) string {
	switch value := raw.(type) {
	case string:
		return trim(value)
	case map[string]any:
		plain, err := decryptSetting(value, t.config.EncryptionKey)
		if err != nil {
			return ""
		}
		return trim(plain)
	default:
		return ""
	}
}

func assertTranslation(cfg translationConfig) error {
	deep := cfg.Enabled && cfg.BaseURL != "" && cfg.APIKey != ""
	fallback := cfg.FallbackEnabled && cfg.FallbackBaseURL != ""
	if !cfg.Enabled && !cfg.FallbackEnabled {
		return errors.New("translation disabled")
	}
	if deep || fallback {
		return nil
	}
	return errors.New("translation unconfigured")
}

func (t *liveTranslator) request(ctx context.Context, text string, cfg translationConfig) (string, error) {
	var deepErr error
	if cfg.Enabled && cfg.BaseURL != "" && cfg.APIKey != "" {
		value, err := t.deepL(ctx, text, cfg)
		if err == nil {
			return value, nil
		}
		deepErr = err
	}
	if !cfg.FallbackEnabled || cfg.FallbackBaseURL == "" {
		if deepErr != nil {
			return "", deepErr
		}
		return "", errors.New("translation unconfigured")
	}
	lang := detectLang(text)
	if lang == "zh-CN" {
		return text, nil
	}
	if lang == "" {
		return "", errors.New("unsupported source language")
	}
	return t.fallback(ctx, text, lang, cfg)
}

func (t *liveTranslator) deepL(ctx context.Context, text string, cfg translationConfig) (string, error) {
	endpoint := cfg.BaseURL + "/" + url.PathEscape(cfg.APIKey) + "/translate"
	body, _ := json.Marshal(map[string]string{"text": text, "source_lang": "auto", "target_lang": "ZH"})
	return t.post(ctx, endpoint, body, cfg, true)
}

func (t *liveTranslator) fallback(ctx context.Context, text, lang string, cfg translationConfig) (string, error) {
	body, _ := json.Marshal(map[string]any{
		"source_lang": lang,
		"target_lang": "zh-CN",
		"text_list":   []string{text},
	})
	return t.post(ctx, cfg.FallbackBaseURL, body, cfg, false)
}

func (t *liveTranslator) post(ctx context.Context, endpoint string, body []byte, cfg translationConfig, deep bool) (string, error) {
	attempts := cfg.MaxRetries + 1
	if attempts < 1 {
		attempts = 1
	}
	var last error
	for attempt := 1; attempt <= attempts; attempt++ {
		callCtx, cancel := context.WithTimeout(ctx, cfg.Timeout)
		req, err := http.NewRequestWithContext(callCtx, http.MethodPost, endpoint, bytes.NewReader(body))
		if err != nil {
			cancel()
			return "", err
		}
		req.Header.Set("content-type", "application/json")
		resp, err := t.http.Do(req)
		if err != nil {
			cancel()
			last = err
			if attempt < attempts {
				time.Sleep(time.Duration(attempt) * 300 * time.Millisecond)
				continue
			}
			return "", err
		}
		payload, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
		resp.Body.Close()
		cancel()
		if resp.StatusCode < 200 || resp.StatusCode >= 300 {
			last = errors.New("translation http status")
			if attempt < attempts && (resp.StatusCode == 408 || resp.StatusCode == 429 || resp.StatusCode >= 500) {
				time.Sleep(time.Duration(attempt) * 300 * time.Millisecond)
				continue
			}
			return "", last
		}
		var decoded any
		if json.Unmarshal(payload, &decoded) != nil {
			return "", errors.New("translation response")
		}
		if deep {
			if code, ok := numericCode(decoded); ok && code != 200 {
				last = errors.New("translation code")
				if attempt < attempts && (code == 408 || code == 429 || code >= 500) {
					time.Sleep(time.Duration(attempt) * 300 * time.Millisecond)
					continue
				}
				return "", last
			}
			if text := deepText(decoded); text != "" {
				return text, nil
			}
			return "", errors.New("translation empty")
		}
		if text := fallbackText(decoded); text != "" {
			return text, nil
		}
		return "", errors.New("translation empty")
	}
	if last == nil {
		last = errors.New("translation failed")
	}
	return "", last
}

func numericCode(payload any) (int, bool) {
	record, ok := payload.(map[string]any)
	if !ok {
		return 0, false
	}
	n, ok := record["code"].(float64)
	if !ok {
		return 0, false
	}
	return int(n), true
}

func deepText(payload any) string {
	if text, ok := payload.(string); ok {
		return trim(text)
	}
	record, ok := payload.(map[string]any)
	if !ok {
		return ""
	}
	if text := trim(stringOrEmpty(record["data"])); text != "" {
		return text
	}
	if text := trim(stringOrEmpty(record["translation"])); text != "" {
		return text
	}
	alts, _ := record["alternatives"].([]any)
	for _, alt := range alts {
		if text := trim(stringOrEmpty(alt)); text != "" {
			return text
		}
	}
	return ""
}

func fallbackText(payload any) string {
	record, ok := payload.(map[string]any)
	if !ok {
		return ""
	}
	list, _ := record["translations"].([]any)
	for _, entry := range list {
		item, ok := entry.(map[string]any)
		if !ok {
			continue
		}
		if text := trim(stringOrEmpty(item["text"])); text != "" {
			return text
		}
	}
	return ""
}

func detectLang(text string) string {
	text = trim(text)
	if text == "" {
		return ""
	}
	if regexp.MustCompile(`[\x{3040}-\x{30ff}]`).MatchString(text) {
		return "ja"
	}
	if regexp.MustCompile(`[\x{ac00}-\x{d7af}\x{1100}-\x{11ff}]`).MatchString(text) {
		return "ko"
	}
	if regexp.MustCompile(`[\x{4e00}-\x{9fff}]`).MatchString(text) {
		return "zh-CN"
	}
	lower := strings.ToLower(text)
	if regexp.MustCompile(`[àâçéèêëîïôûùüÿœæ]`).MatchString(lower) || frenchWords.MatchString(lower) {
		return "fr"
	}
	if regexp.MustCompile(`[äöüß]`).MatchString(lower) || germanWords.MatchString(lower) {
		return "de"
	}
	if regexp.MustCompile(`[a-z]`).MatchString(lower) {
		return "en"
	}
	return ""
}

var (
	frenchWords = regexp.MustCompile(`\b(le|la|les|des|du|de|une|un|bonjour|merci|avec|pour|dans|est|sont)\b`)
	germanWords = regexp.MustCompile(`\b(der|die|das|und|ist|mit|nicht|ein|eine|für|auf|von|den)\b`)
)

func boundedInt(value any, fallback, min, max int) (int, bool) {
	parsed := fallback
	switch n := value.(type) {
	case float64:
		parsed = int(n)
	case string:
		if n == "" {
			return fallback, false
		}
		var number json.Number = json.Number(n)
		i, err := number.Int64()
		if err != nil {
			return fallback, false
		}
		parsed = int(i)
	default:
		if value == nil {
			return fallback, false
		}
	}
	if parsed < min {
		parsed = min
	}
	if parsed > max {
		parsed = max
	}
	return parsed, true
}

func decryptSetting(payload map[string]any, encryptionKey string) (string, error) {
	if payload["__enc"] != "system-settings:v1" || payload["alg"] != "aes-256-gcm" {
		return "", errors.New("not an encrypted setting")
	}
	key, err := decodeSettingsKey(encryptionKey)
	if err != nil {
		return "", err
	}
	iv, err := base64.StdEncoding.DecodeString(stringOrEmpty(payload["iv"]))
	if err != nil {
		return "", err
	}
	tag, err := base64.StdEncoding.DecodeString(stringOrEmpty(payload["tag"]))
	if err != nil {
		return "", err
	}
	data, err := base64.StdEncoding.DecodeString(stringOrEmpty(payload["data"]))
	if err != nil {
		return "", err
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	plain, err := gcm.Open(nil, iv, append(data, tag...), nil)
	if err != nil {
		return "", err
	}
	return string(plain), nil
}

func decodeSettingsKey(raw string) ([]byte, error) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return nil, errors.New("missing encryption key")
	}
	hexCandidate := strings.TrimPrefix(strings.TrimPrefix(trimmed, "0x"), "0X")
	if len(hexCandidate) == 64 && isHex(hexCandidate) {
		return hex.DecodeString(hexCandidate)
	}
	decoded, err := base64.StdEncoding.DecodeString(trimmed)
	if err != nil || len(decoded) != 32 {
		return nil, errors.New("invalid encryption key")
	}
	return decoded, nil
}

func isHex(value string) bool {
	for _, r := range value {
		switch {
		case r >= '0' && r <= '9', r >= 'a' && r <= 'f', r >= 'A' && r <= 'F':
		default:
			return false
		}
	}
	return true
}

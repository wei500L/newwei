package newssources

import (
	"bytes"
	"encoding/json"
	"math"
	"strconv"
	"strings"
)

func normalizeConfig(raw json.RawMessage) ([]byte, error) {
	if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return nil, nil
	}
	var value map[string]any
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	if decoder.Decode(&value) != nil || value == nil {
		return nil, &inputError{Message: "config must be an object"}
	}
	if crawl, ok := value["crawlOptions"]; ok {
		options, ok := crawl.(map[string]any)
		if !ok {
			return nil, &inputError{Message: "crawlOptions must be an object"}
		}
		if message := unsupportedProxy(options, "config.crawlOptions"); message != "" {
			return nil, &inputError{Message: "Unsupported crawl config: " + message}
		}
		if message := llmMessage(options); message != "" {
			return nil, &inputError{Message: message}
		}
	}
	if seed, ok := value["seed"].(map[string]any); ok {
		mode, _ := seed["mode"].(string)
		if strings.EqualFold(strings.TrimSpace(mode), "rss") {
			if ttl, ok := roundedTTL(seed["cacheTtlSeconds"]); ok && ttl == 600 {
				delete(seed, "cacheTtlSeconds")
			}
		}
	}
	encoded, err := json.Marshal(value)
	if err != nil {
		return nil, err
	}
	return encoded, nil
}

func unsupportedProxy(value map[string]any, path string) string {
	var issues []string
	if _, ok := value["proxyUrl"]; ok {
		issues = append(issues, path+".proxyUrl: custom upstream proxies are not supported")
	}
	if _, ok := value["proxyConfig"]; ok {
		issues = append(issues, path+".proxyConfig: custom upstream proxies are not supported")
	}
	return strings.Join(issues, "; ")
}

func llmMessage(value any) string {
	keys := llmKeys(value, "")
	if len(keys) == 0 {
		return ""
	}
	shown := keys
	suffix := ""
	if len(shown) > 5 {
		suffix = " (+" + strconv.Itoa(len(shown)-5) + " more)"
		shown = shown[:5]
	}
	return "crawlOptions contains crawl4ai LLM extraction settings (" + strings.Join(shown, ", ") + suffix + "). The crawl stage must only fetch and store cleaned markdown; run your configured model in the pipeline stage instead."
}

func llmKeys(value any, prefix string) []string {
	switch typed := value.(type) {
	case map[string]any:
		var hits []string
		for key, entry := range typed {
			normalized := normalizeKey(key)
			path := key
			if prefix != "" {
				path = prefix + "." + key
			}
			if normalized == "extractionstrategy" || normalized == "llmconfig" {
				hits = append(hits, path)
			}
			if normalized == "type" {
				if text, ok := entry.(string); ok && strings.Contains(normalizeKey(text), "llm") && (strings.Contains(normalizeKey(path), "strategy") || strings.Contains(normalizeKey(path), "extraction")) {
					hits = append(hits, path)
				}
			}
			hits = append(hits, llmKeys(entry, path)...)
		}
		return hits
	case []any:
		var hits []string
		for i, entry := range typed {
			hits = append(hits, llmKeys(entry, prefix+"["+strconv.Itoa(i)+"]")...)
		}
		return hits
	default:
		return nil
	}
}

func normalizeKey(value string) string {
	var b strings.Builder
	for _, r := range strings.ToLower(value) {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') {
			b.WriteRune(r)
		}
	}
	return b.String()
}

func roundedTTL(value any) (int, bool) {
	switch typed := value.(type) {
	case json.Number:
		parsed, err := typed.Float64()
		if err != nil || math.IsNaN(parsed) || math.IsInf(parsed, 0) {
			return 0, false
		}
		return int(math.Round(parsed)), true
	case float64:
		if math.IsNaN(typed) || math.IsInf(typed, 0) {
			return 0, false
		}
		return int(math.Round(typed)), true
	case string:
		parsed, err := strconv.ParseFloat(strings.TrimSpace(typed), 64)
		if err != nil {
			return 0, false
		}
		return int(math.Round(parsed)), true
	default:
		return 0, false
	}
}

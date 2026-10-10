package dashboardspacetime

import "strings"

func isHex(value byte) bool {
	return (value >= '0' && value <= '9') || (value >= 'a' && value <= 'f') || (value >= 'A' && value <= 'F')
}

func isObjectID(value string) bool {
	if len(value) != 24 {
		return false
	}
	for index := 0; index < len(value); index++ {
		if !isHex(value[index]) {
			return false
		}
	}
	return true
}

func canonicalizeMongoKey(value string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return ""
	}
	if isObjectID(value) {
		return strings.ToLower(value)
	}
	return value
}

func extractObjectID(value string) string {
	normalized := strings.TrimSpace(value)
	if normalized == "" {
		return ""
	}
	if isObjectID(normalized) {
		return strings.ToLower(normalized)
	}
	last := ""
	index := 0
	for index < len(normalized) {
		if !isHex(normalized[index]) {
			index++
			continue
		}
		start := index
		for index < len(normalized) && isHex(normalized[index]) {
			index++
		}
		if index-start == 24 {
			last = strings.ToLower(normalized[start:index])
		}
	}
	return last
}

func lookupKeys(candidates ...string) []string {
	keys := make([]string, 0, len(candidates))
	seen := map[string]struct{}{}
	appendKey := func(raw string) {
		canonical := canonicalizeMongoKey(raw)
		if canonical == "" {
			return
		}
		if _, ok := seen[canonical]; ok {
			return
		}
		seen[canonical] = struct{}{}
		keys = append(keys, canonical)
	}
	for _, candidate := range candidates {
		trimmed := strings.TrimSpace(candidate)
		if trimmed != "" {
			appendKey(trimmed)
		}
		if extracted := extractObjectID(candidate); extracted != "" {
			appendKey(extracted)
		}
	}
	return keys
}

func lowercaseObjectIDs(keys []string) []string {
	out := make([]string, 0, len(keys))
	seen := map[string]struct{}{}
	for _, key := range keys {
		if len(key) != 24 || key != strings.ToLower(key) || !isObjectID(key) {
			continue
		}
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		out = append(out, key)
	}
	return out
}

func normalizeSentiment(raw any) string {
	text, ok := raw.(string)
	if !ok {
		return "unknown"
	}
	switch strings.ToLower(strings.TrimSpace(text)) {
	case "positive":
		return "positive"
	case "neutral":
		return "neutral"
	case "negative":
		return "negative"
	default:
		return "unknown"
	}
}

func sentimentFromResult(result map[string]any) string {
	if result == nil {
		return "unknown"
	}
	for _, key := range []string{"sentiment_label", "sentimentLabel", "sentiment"} {
		value, ok := result[key]
		if !ok || value == nil {
			continue
		}
		return normalizeSentiment(value)
	}
	return "unknown"
}

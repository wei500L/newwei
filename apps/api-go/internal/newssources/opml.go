package newssources

import (
	"context"
	"encoding/json"
	"encoding/xml"
	"net/url"
	"strings"
)

const presetID = "hn_popular_blogs_2025"

func (s *Service) Presets() []map[string]any {
	parsed := parseOPML(hnPopularBlogs2025)
	return []map[string]any{{
		"id":              presetID,
		"name":            "HN Popular Blogs 2025",
		"description":     "RSS/Atom feed list curated from HN Popularity Contest 2025 for direct import.",
		"defaultLanguage": "zh",
		"entryCount":      len(parsed.entries),
	}}
}

func (s *Service) PreviewOPML(ctx context.Context, orgID string, body []byte) (map[string]any, error) {
	fields, err := objectFields(body)
	if err != nil {
		return nil, err
	}
	if err := rejectUnknown(fields, map[string]bool{"presetId": true, "opmlContent": true, "defaultLanguage": true}); err != nil {
		return nil, err
	}
	preset, _ := jsonString(fields["presetId"])
	content, _ := jsonString(fields["opmlContent"])
	preset = strings.TrimSpace(preset)
	content = strings.TrimSpace(content)
	if preset == "" && content == "" {
		return nil, newStatus(400, "presetId or opmlContent is required")
	}
	var presetOPML string
	var presetLanguage string
	resolvedPreset := ""
	if preset != "" {
		if preset != presetID {
			return nil, newStatus(400, "Unknown OPML preset")
		}
		presetOPML = hnPopularBlogs2025
		presetLanguage = "zh"
		resolvedPreset = presetID
	}
	languageRaw, _ := jsonString(fields["defaultLanguage"])
	if strings.TrimSpace(languageRaw) == "" {
		languageRaw = presetLanguage
	}
	language := normalizeLanguage(languageRaw)
	source := content
	if source == "" {
		source = presetOPML
	}
	parsed := parseOPML(source)
	entries := make([]map[string]any, 0, len(parsed.entries))
	seen := map[string]bool{}
	for _, entry := range parsed.entries {
		errors := []string{}
		site, siteErr := normalizeAndValidateSiteURL(ctx, entry.url)
		if siteErr != "" {
			errors = append(errors, siteErr)
			site = entry.url
		}
		feed, feedErr := normalizeAndValidateFeedURL(ctx, entry.feedURL)
		if feedErr != "" {
			errors = append(errors, feedErr)
			feed = entry.feedURL
		}
		if seen[site] {
			continue
		}
		seen[site] = true
		valid := siteErr == "" && feedErr == ""
		item := map[string]any{
			"name": entry.name, "url": site, "feedUrl": feed, "language": language,
			"group": entry.group, "enabled": valid, "valid": valid, "alreadyExists": false, "errors": errors,
		}
		entries = append(entries, item)
	}
	urls := make([]string, 0)
	for _, entry := range entries {
		if entry["valid"] == true {
			urls = append(urls, entry["url"].(string))
		}
	}
	existing, err := s.existingURLs(ctx, orgID, urls)
	if err != nil {
		return nil, err
	}
	for _, entry := range entries {
		if entry["valid"] != true {
			entry["enabled"] = false
			continue
		}
		if existing.has(entry["url"].(string)) {
			entry["alreadyExists"] = true
			entry["enabled"] = false
			entry["errors"] = append(entry["errors"].([]string), "News source already exists")
		}
	}
	summary := map[string]int{"total": len(entries), "valid": 0, "invalid": 0, "duplicates": 0, "enabled": 0}
	for _, entry := range entries {
		if entry["valid"] == true {
			summary["valid"]++
		} else {
			summary["invalid"]++
		}
		if entry["alreadyExists"] == true {
			summary["duplicates"]++
		}
		if entry["enabled"] == true {
			summary["enabled"]++
		}
	}
	var title any
	if parsed.title != "" {
		title = parsed.title
	}
	var presetValue any
	if resolvedPreset != "" {
		presetValue = resolvedPreset
	}
	return map[string]any{"presetId": presetValue, "title": title, "entries": entries, "summary": summary}, nil
}

func (s *Service) ImportOPML(ctx context.Context, orgID string, body []byte) (map[string]any, error) {
	fields, err := objectFields(body)
	if err != nil {
		return nil, err
	}
	if err := rejectUnknown(fields, map[string]bool{"entries": true, "conflictPolicy": true, "runtimeProfile": true}); err != nil {
		return nil, err
	}
	if raw, ok := fields["conflictPolicy"]; ok {
		text, ok := jsonString(raw)
		if !ok || (text != "" && text != "skip") {
			return nil, &inputError{Message: "conflictPolicy must be one of the following values: skip"}
		}
	}
	if raw, ok := fields["runtimeProfile"]; ok {
		text, ok := jsonString(raw)
		if !ok || (text != "" && text != "steady") {
			return nil, &inputError{Message: "runtimeProfile must be one of the following values: steady"}
		}
	}
	var rawEntries []map[string]any
	if json.Unmarshal(fields["entries"], &rawEntries) != nil {
		return nil, &inputError{Message: "entries must be an array"}
	}
	type normalized struct {
		name, url, feed string
		language        string
		enabled, valid  bool
		siteType        string
		group           *string
		errors          []string
	}
	rows := make([]normalized, 0, len(rawEntries))
	for _, entry := range rawEntries {
		var errors []string
		name := strings.TrimSpace(stringField(entry, "name"))
		urlRaw := strings.TrimSpace(stringField(entry, "url"))
		feedRaw := strings.TrimSpace(stringField(entry, "feedUrl"))
		site, siteErr := normalizeAndValidateSiteURL(ctx, urlRaw)
		if siteErr != "" {
			errors = append(errors, siteErr)
		}
		feed, feedErr := normalizeAndValidateFeedURL(ctx, feedRaw)
		if feedErr != "" {
			errors = append(errors, feedErr)
		}
		if site == "" {
			site = urlRaw
		}
		if feed == "" {
			feed = feedRaw
		}
		enabled := true
		if value, ok := entry["enabled"].(bool); ok && !value {
			enabled = false
		}
		siteType := "general"
		if text := stringField(entry, "siteType"); text != "" && siteTypes[text] {
			siteType = text
		}
		var group *string
		if text := strings.TrimSpace(stringField(entry, "group")); text != "" {
			group = &text
		}
		display := name
		if display == "" {
			display = urlRaw
		}
		rows = append(rows, normalized{
			name: display, url: site, feed: feed, language: normalizeLanguage(stringField(entry, "language")),
			enabled: enabled, valid: name != "" && siteErr == "" && feedErr == "" && len(errors) == 0,
			siteType: siteType, group: group, errors: errors,
		})
	}
	var candidate []string
	enabledCount := 0
	for _, row := range rows {
		if row.enabled {
			enabledCount++
			if row.valid {
				candidate = append(candidate, row.url)
			}
		}
	}
	existing, err := s.existingURLs(ctx, orgID, candidate)
	if err != nil {
		return nil, err
	}
	created := []map[string]string{}
	skipped := []map[string]string{}
	failed := []map[string]string{}
	for _, row := range rows {
		if !row.enabled {
			continue
		}
		if !row.valid {
			message := "Invalid entry"
			if len(row.errors) > 0 {
				message = strings.Join(row.errors, "; ")
			}
			failed = append(failed, map[string]string{"name": row.name, "url": row.url, "error": message})
			continue
		}
		if existing.has(row.url) {
			skipped = append(skipped, map[string]string{"name": row.name, "url": row.url, "reason": "duplicate"})
			continue
		}
		config, _ := json.Marshal(map[string]any{"seed": map[string]any{
			"enabled": true, "mode": "rss", "feedUrl": row.feed, "maxUrls": 200,
			"maxNewUrlsPerRun": 80, "scoreThreshold": 0, "concurrency": 5, "dedupeWindowHours": 24,
		}})
		doc, err := s.Create(ctx, orgID, createInput{
			Name: row.name, URL: row.url, SiteType: row.siteType, Language: &row.language,
			WorkflowBindingMode: "published", FrequencySeconds: 3600, IsActive: true, Config: config, Group: row.group,
		})
		if err != nil {
			if status, ok := err.(*statusError); ok && status.status == 409 {
				skipped = append(skipped, map[string]string{"name": row.name, "url": row.url, "reason": "duplicate"})
				continue
			}
			failed = append(failed, map[string]string{"name": row.name, "url": row.url, "error": err.Error()})
			continue
		}
		created = append(created, map[string]string{"id": doc.ID, "name": doc.Name, "url": doc.URL})
		for _, candidate := range urlCandidates(doc.URL) {
			existing.add(candidate)
		}
	}
	return map[string]any{
		"summary": map[string]int{
			"total": len(rows), "enabled": enabledCount, "created": len(created), "skipped": len(skipped), "failed": len(failed),
		},
		"created": created, "skipped": skipped, "failed": failed,
	}, nil
}

type urlSet map[string]bool

func (s urlSet) has(raw string) bool {
	for _, candidate := range urlCandidates(raw) {
		if s[candidate] {
			return true
		}
	}
	return false
}

func (s urlSet) add(raw string) { s[raw] = true }

func (s *Service) existingURLs(ctx context.Context, orgID string, urls []string) (urlSet, error) {
	set := urlSet{}
	candidates := []string{}
	seen := map[string]bool{}
	for _, raw := range urls {
		for _, candidate := range urlCandidates(raw) {
			if !seen[candidate] {
				seen[candidate] = true
				candidates = append(candidates, candidate)
			}
		}
	}
	if len(candidates) == 0 {
		return set, nil
	}
	rows, err := s.db.QueryContext(ctx, `SELECT url FROM NewsSource WHERE orgId = ? AND url IN (`+placeholders(len(candidates))+`)`, append([]any{orgID}, stringsToArgs(candidates)...)...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var raw string
		if err := rows.Scan(&raw); err != nil {
			return nil, err
		}
		set.add(raw)
	}
	return set, rows.Err()
}

func normalizeAndValidateSiteURL(ctx context.Context, raw string) (string, string) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return "", "Missing site URL (htmlUrl)"
	}
	if !strings.HasPrefix(strings.ToLower(trimmed), "http://") && !strings.HasPrefix(strings.ToLower(trimmed), "https://") {
		return "", "Site URL must be http/https"
	}
	if reason, ok := validateSourceURL(ctx, trimmed); !ok {
		text := reason
		if text == "" {
			text = "potential SSRF"
		}
		return "", "Site URL is not safe: " + text
	}
	normalized, err := normalizeURLForStorage(trimmed)
	if err != nil {
		return "", "Invalid site URL (htmlUrl)"
	}
	return normalized, ""
}

func normalizeAndValidateFeedURL(ctx context.Context, raw string) (string, string) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return "", "Missing feed URL (xmlUrl)"
	}
	if !strings.HasPrefix(strings.ToLower(trimmed), "http://") && !strings.HasPrefix(strings.ToLower(trimmed), "https://") {
		return "", "Feed URL must be http/https"
	}
	if reason, ok := validateSourceURL(ctx, trimmed); !ok {
		text := reason
		if text == "" {
			text = "potential SSRF"
		}
		return "", "Feed URL is not safe: " + text
	}
	parsed, err := url.Parse(trimmed)
	if err != nil {
		return "", "Invalid feed URL (xmlUrl)"
	}
	parsed.Fragment = ""
	return parsed.String(), ""
}

func normalizeURLForStorage(raw string) (string, error) {
	parsed, err := url.Parse(raw)
	if err != nil {
		return "", err
	}
	parsed.Fragment = ""
	if parsed.Path == "/" && parsed.RawQuery == "" {
		return parsed.Scheme + "://" + parsed.Host, nil
	}
	if strings.HasSuffix(parsed.Path, "/") && parsed.Path != "/" {
		parsed.Path = strings.TrimSuffix(parsed.Path, "/")
		parsed.RawPath = ""
	}
	return parsed.String(), nil
}

func urlCandidates(raw string) []string {
	parsed, err := url.Parse(raw)
	if err != nil {
		return []string{raw}
	}
	parsed.Fragment = ""
	out := map[string]bool{parsed.String(): true}
	if parsed.Path == "/" && parsed.RawQuery == "" {
		out[parsed.Scheme+"://"+parsed.Host] = true
		out[parsed.Scheme+"://"+parsed.Host+"/"] = true
	} else if strings.HasSuffix(parsed.Path, "/") && parsed.Path != "/" {
		clone := *parsed
		clone.Path = strings.TrimSuffix(parsed.Path, "/")
		clone.RawPath = ""
		out[clone.String()] = true
	} else if !strings.HasSuffix(parsed.Path, "/") {
		clone := *parsed
		clone.Path = parsed.Path + "/"
		clone.RawPath = ""
		out[clone.String()] = true
	}
	values := make([]string, 0, len(out))
	for value := range out {
		values = append(values, value)
	}
	return values
}

func normalizeLanguage(value string) string {
	raw := strings.TrimSpace(value)
	if raw == "" {
		return "zh"
	}
	lower := strings.ToLower(raw)
	if strings.HasPrefix(lower, "zh") {
		return "zh"
	}
	if strings.HasPrefix(lower, "en") {
		return "en"
	}
	if len(lower) <= 12 {
		return lower
	}
	return "zh"
}

func stringField(entry map[string]any, key string) string {
	text, _ := entry[key].(string)
	return text
}

type parsedOPML struct {
	title   string
	entries []opmlEntry
}

type opmlEntry struct {
	name, url, feedURL string
	group              any
}

type xmlOPML struct {
	Head struct {
		Title string `xml:"title"`
	} `xml:"head"`
	Body struct {
		Outlines []xmlOutline `xml:"outline"`
	} `xml:"body"`
}

type xmlOutline struct {
	Type     string       `xml:"type,attr"`
	Text     string       `xml:"text,attr"`
	Title    string       `xml:"title,attr"`
	XMLURL   string       `xml:"xmlUrl,attr"`
	HTMLURL  string       `xml:"htmlUrl,attr"`
	Outlines []xmlOutline `xml:"outline"`
}

func parseOPML(raw string) parsedOPML {
	var doc xmlOPML
	if xml.Unmarshal([]byte(raw), &doc) != nil {
		return parsedOPML{}
	}
	var collected []opmlEntry
	var walk func(nodes []xmlOutline, parent any)
	walk = func(nodes []xmlOutline, parent any) {
		for _, node := range nodes {
			typeName := strings.ToLower(strings.TrimSpace(node.Type))
			xmlURL := strings.TrimSpace(node.XMLURL)
			htmlURL := strings.TrimSpace(node.HTMLURL)
			label := strings.TrimSpace(node.Text)
			if label == "" {
				label = strings.TrimSpace(node.Title)
			}
			isFeed := typeName == "rss" || xmlURL != ""
			if isFeed && (xmlURL != "" || htmlURL != "") {
				name := label
				if name == "" {
					name = htmlURL
				}
				if name == "" {
					name = xmlURL
				}
				if htmlURL != "" || xmlURL != "" {
					collected = append(collected, opmlEntry{name: name, url: htmlURL, feedURL: xmlURL, group: parent})
				}
			}
			next := parent
			if !isFeed && label != "" {
				next = label
			}
			walk(node.Outlines, next)
		}
	}
	walk(doc.Body.Outlines, nil)
	title := strings.TrimSpace(doc.Head.Title)
	return parsedOPML{title: title, entries: collected}
}

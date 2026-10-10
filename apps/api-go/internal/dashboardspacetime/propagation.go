package dashboardspacetime

import (
	"context"
	"errors"
	"math"
	"net/url"
	"sort"
	"strings"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/dashboardcharts"
)

type nodeJSON struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Count   int    `json:"count"`
	FirstAt string `json:"firstAt"`
	LastAt  string `json:"lastAt"`
}

type edgeJSON struct {
	Source                 string   `json:"source"`
	Target                 string   `json:"target"`
	Kind                   string   `json:"kind"`
	Weight                 int      `json:"weight"`
	AvgLagMs               float64  `json:"avgLagMs"`
	FirstAt                string   `json:"firstAt"`
	LastAt                 string   `json:"lastAt"`
	AvgDuplicateSimilarity *float64 `json:"avgDuplicateSimilarity,omitempty"`
}

type propResponse struct {
	EventID     string     `json:"eventId"`
	WindowHours int        `json:"windowHours"`
	Nodes       []nodeJSON `json:"nodes"`
	Edges       []edgeJSON `json:"edges"`
	UpdatedAt   string     `json:"updatedAt,omitempty"`
}

type propArticleJSON struct {
	ID          string  `json:"id"`
	Title       string  `json:"title"`
	URL         *string `json:"url"`
	SourceLabel *string `json:"sourceLabel"`
	PublishedAt *string `json:"publishedAt,omitempty"`
	IngestedAt  *string `json:"ingestedAt,omitempty"`
	ProcessedAt *string `json:"processedAt,omitempty"`
	Sentiment   *string `json:"sentiment,omitempty"`
}

type propArticlesResponse struct {
	EventID     string            `json:"eventId"`
	Source      string            `json:"source"`
	CursorStart string            `json:"cursorStart,omitempty"`
	CursorEnd   string            `json:"cursorEnd,omitempty"`
	HasMore     bool              `json:"hasMore"`
	Articles    []propArticleJSON `json:"articles"`
	UpdatedAt   string            `json:"updatedAt,omitempty"`
}

type signal struct {
	articleID string
	lookup    []string
	source    string
	ts        int64
}

type edgeAgg struct {
	kind       string
	source     string
	target     string
	weight     int
	lagSum     int64
	lagCount   int
	first      int64
	last       int64
	simSum     float64
	simCount   int
	hasSim     bool
}

func sourceKey(label, rawURL string) string {
	label = strings.TrimSpace(label)
	if label != "" {
		return clipUnits(label, 120)
	}
	rawURL = strings.TrimSpace(rawURL)
	if rawURL != "" {
		parsed, err := url.Parse(rawURL)
		host := ""
		if err == nil && parsed.Scheme != "" {
			host = strings.ToLower(parsed.Hostname())
		}
		if host != "" {
			return clipUnits(host, 120)
		}
	}
	return "unknown"
}

func propTimestamp(row propRow) (time.Time, bool) {
	if row.Published != nil {
		return row.Published.UTC(), true
	}
	if row.CrawlAt != nil {
		return row.CrawlAt.UTC(), true
	}
	if row.Processed != nil {
		return row.Processed.UTC(), true
	}
	return time.Time{}, false
}

func (s *Service) Propagation(ctx context.Context, orgID, eventID string, start, end time.Time, windowHours, maxNodes, maxEdges, maxPred int) (propResponse, error) {
	eventID = strings.TrimSpace(eventID)
	if eventID == "" {
		return propResponse{}, errBad("eventId is required")
	}
	if s == nil || s.articles == nil {
		return propResponse{}, errors.New("mysql is not configured")
	}
	rows, err := s.articles.Propagation(ctx, orgID, eventID, start, end)
	if err != nil {
		return propResponse{}, err
	}
	signals := make([]signal, 0, len(rows))
	lookupIDs := make([]string, 0)
	for _, row := range rows {
		ts, ok := propTimestamp(row)
		if !ok {
			continue
		}
		keys := lookupKeys(row.ProcessedItemID, row.CleanedRef)
		signals = append(signals, signal{
			articleID: row.ArticleID,
			lookup:    keys,
			source:    sourceKey(row.SourceLabel, row.URL),
			ts:        ts.UnixMilli(),
		})
		lookupIDs = append(lookupIDs, keys...)
	}
	links := []dupLink{}
	failed := false
	if s.items != nil {
		var ok bool
		links, ok = s.items.Duplicates(ctx, orgID, lowercaseObjectIDs(lookupIDs))
		failed = !ok
	}
	return assemblePropagation(eventID, windowHours, signals, links, failed, maxNodes, maxEdges, maxPred), nil
}

func assemblePropagation(eventID string, windowHours int, signals []signal, links []dupLink, dupFailed bool, maxNodes, maxEdges, maxPred int) propResponse {
	response := propResponse{
		EventID: eventID, WindowHours: windowHours,
		Nodes: []nodeJSON{}, Edges: []edgeJSON{},
	}
	type nodeState struct {
		count int
		first int64
		last  int64
	}
	nodes := map[string]*nodeState{}
	nodeOrder := make([]string, 0)
	byItem := map[string]*signal{}
	var updated int64
	hasUpdated := false
	for index := range signals {
		signal := &signals[index]
		state := nodes[signal.source]
		if state == nil {
			state = &nodeState{first: signal.ts, last: signal.ts}
			nodes[signal.source] = state
			nodeOrder = append(nodeOrder, signal.source)
		}
		state.count++
		if signal.ts < state.first {
			state.first = signal.ts
		}
		if signal.ts > state.last {
			state.last = signal.ts
		}
		for _, key := range signal.lookup {
			prior := byItem[key]
			if prior == nil || signal.ts < prior.ts {
				byItem[key] = signal
			}
		}
		if !hasUpdated || signal.ts > updated {
			updated = signal.ts
			hasUpdated = true
		}
	}
	if hasUpdated {
		response.UpdatedAt = toISO(time.UnixMilli(updated).UTC())
	}
	if len(signals) == 0 {
		return response
	}
	edges := map[string]*edgeAgg{}
	edgeOrder := make([]string, 0)
	push := func(kind, source, target string, lag, ts int64, similarity *float64) {
		if source == "" || target == "" || source == target {
			return
		}
		key := kind + ":" + source + " -> " + target
		existing := edges[key]
		if existing == nil {
			existing = &edgeAgg{kind: kind, source: source, target: target, first: ts, last: ts}
			edges[key] = existing
			edgeOrder = append(edgeOrder, key)
		}
		existing.weight++
		existing.lagSum += lag
		existing.lagCount++
		if ts < existing.first {
			existing.first = ts
		}
		if ts > existing.last {
			existing.last = ts
		}
		if kind == "duplicate" && similarity != nil && !math.IsNaN(*similarity) && !math.IsInf(*similarity, 0) {
			existing.simSum += *similarity
			existing.simCount++
			existing.hasSim = true
		}
	}
	handled := map[string]struct{}{}
	if !dupFailed {
		for _, link := range links {
			child := byItem[link.Child]
			parent := byItem[link.Parent]
			if child == nil || parent == nil || child.source == parent.source {
				continue
			}
			lag := child.ts - parent.ts
			if lag < 0 {
				lag = -lag
			}
			ts := child.ts
			if parent.ts > ts {
				ts = parent.ts
			}
			source, target := parent.source, child.source
			if parent.ts > child.ts {
				source, target = child.source, parent.source
			}
			push("duplicate", source, target, lag, ts, link.Similarity)
			handled[link.Child] = struct{}{}
		}
	}
	ordered := append([]signal(nil), signals...)
	sort.SliceStable(ordered, func(i, j int) bool {
		return ordered[i].ts < ordered[j].ts
	})
	windowMS := int64(windowHours) * 60 * 60 * 1000
	for index := range ordered {
		current := ordered[index]
		if len(current.lookup) > 0 {
			skip := false
			for _, key := range current.lookup {
				if _, ok := handled[key]; ok {
					skip = true
					break
				}
			}
			if skip {
				continue
			}
		}
		linked := map[string]struct{}{}
		for prev := index - 1; prev >= 0; prev-- {
			if len(linked) >= maxPred {
				break
			}
			earlier := ordered[prev]
			delta := current.ts - earlier.ts
			if delta > windowMS {
				break
			}
			if earlier.source == current.source {
				continue
			}
			if _, ok := linked[earlier.source]; ok {
				continue
			}
			push("time", earlier.source, current.source, delta, current.ts, nil)
			linked[earlier.source] = struct{}{}
		}
	}
	sort.SliceStable(nodeOrder, func(i, j int) bool {
		return nodes[nodeOrder[i]].count > nodes[nodeOrder[j]].count
	})
	if len(nodeOrder) > maxNodes {
		nodeOrder = nodeOrder[:maxNodes]
	}
	allowed := map[string]struct{}{}
	for _, id := range nodeOrder {
		state := nodes[id]
		response.Nodes = append(response.Nodes, nodeJSON{
			ID: id, Name: id, Count: state.count,
			FirstAt: toISO(time.UnixMilli(state.first).UTC()),
			LastAt:  toISO(time.UnixMilli(state.last).UTC()),
		})
		allowed[id] = struct{}{}
	}
	kept := make([]*edgeAgg, 0, len(edgeOrder))
	for _, key := range edgeOrder {
		edge := edges[key]
		if _, ok := allowed[edge.source]; !ok {
			continue
		}
		if _, ok := allowed[edge.target]; !ok {
			continue
		}
		kept = append(kept, edge)
	}
	sort.SliceStable(kept, func(i, j int) bool {
		return kept[i].weight > kept[j].weight
	})
	if len(kept) > maxEdges {
		kept = kept[:maxEdges]
	}
	for _, edge := range kept {
		avg := 0.0
		if edge.lagCount > 0 {
			avg = float64(edge.lagSum) / float64(edge.lagCount)
		}
		encoded := edgeJSON{
			Source: edge.source, Target: edge.target, Kind: edge.kind, Weight: edge.weight,
			AvgLagMs: avg,
			FirstAt:  toISO(time.UnixMilli(edge.first).UTC()),
			LastAt:   toISO(time.UnixMilli(edge.last).UTC()),
		}
		if edge.kind == "duplicate" && edge.hasSim && edge.simCount > 0 {
			value := edge.simSum / float64(edge.simCount)
			encoded.AvgDuplicateSimilarity = &value
		}
		response.Edges = append(response.Edges, encoded)
	}
	return response
}

func (s *Service) PropagationArticles(ctx context.Context, orgID, eventID, source, cursorStartRaw, cursorEndRaw string, start, end time.Time, limit int) (propArticlesResponse, error) {
	eventID = strings.TrimSpace(eventID)
	if eventID == "" {
		return propArticlesResponse{}, errBad("eventId is required")
	}
	source = strings.TrimSpace(source)
	if source == "" {
		return propArticlesResponse{}, errBad("source is required")
	}
	if s == nil || s.articles == nil {
		return propArticlesResponse{}, errors.New("mysql is not configured")
	}
	response := propArticlesResponse{EventID: eventID, Source: source, Articles: []propArticleJSON{}}
	var cursorStart, cursorEnd *time.Time
	if strings.TrimSpace(cursorStartRaw) != "" {
		parsed, ok := dashboardcharts.ParseJSDate(strings.TrimSpace(cursorStartRaw))
		if !ok {
			return propArticlesResponse{}, errBad("Invalid cursor date")
		}
		response.CursorStart = toISO(parsed)
		cursorStart = &parsed
	}
	if strings.TrimSpace(cursorEndRaw) != "" {
		parsed, ok := dashboardcharts.ParseJSDate(strings.TrimSpace(cursorEndRaw))
		if !ok {
			return propArticlesResponse{}, errBad("Invalid cursor date")
		}
		response.CursorEnd = toISO(parsed)
		cursorEnd = &parsed
	}
	rows, err := s.articles.Propagation(ctx, orgID, eventID, start, end)
	if err != nil {
		return propArticlesResponse{}, err
	}
	type match struct {
		row propRow
		ts  time.Time
		ref string
	}
	matches := make([]match, 0)
	var updated time.Time
	hasUpdated := false
	for _, row := range rows {
		if sourceKey(row.SourceLabel, row.URL) != source {
			continue
		}
		ts, ok := propTimestamp(row)
		if !ok {
			continue
		}
		if cursorStart != nil && ts.Before(*cursorStart) {
			continue
		}
		if cursorEnd != nil && !ts.Before(*cursorEnd) {
			continue
		}
		ref := strings.TrimSpace(row.ProcessedItemID)
		if ref == "" {
			ref = strings.TrimSpace(row.CleanedRef)
		}
		matches = append(matches, match{row: row, ts: ts, ref: ref})
		if !hasUpdated || ts.After(updated) {
			updated = ts
			hasUpdated = true
		}
	}
	sort.SliceStable(matches, func(i, j int) bool {
		return matches[i].ts.After(matches[j].ts)
	})
	if len(matches) > limit {
		response.HasMore = true
		matches = matches[:limit]
	}
	if hasUpdated {
		response.UpdatedAt = toISO(updated)
	}
	refs := make([]string, 0, len(matches))
	for _, item := range matches {
		if item.ref != "" {
			refs = append(refs, item.ref)
		}
	}
	labels := map[string]string{}
	ok := false
	if s.items != nil {
		labels, ok = s.items.Sentiments(ctx, orgID, refs)
	}
	for _, item := range matches {
		title := strings.TrimSpace(item.row.Title)
		urlValue := item.row.URL
		urlPtr := &urlValue
		if title == "" {
			if urlValue != "" {
				title = urlValue
			} else {
				title = source
			}
		}
		var sourcePtr *string
		if !item.row.SourceNull {
			copied := item.row.SourceLabel
			sourcePtr = &copied
		}
		article := propArticleJSON{
			ID: item.row.ArticleID, Title: title, URL: urlPtr, SourceLabel: sourcePtr,
			PublishedAt: isoPtr(item.row.Published), IngestedAt: isoPtr(item.row.CrawlAt), ProcessedAt: isoPtr(item.row.Processed),
		}
		if ok && item.ref != "" {
			if label, exists := labels[item.ref]; exists {
				copied := label
				article.Sentiment = &copied
			}
		}
		response.Articles = append(response.Articles, article)
	}
	return response, nil
}

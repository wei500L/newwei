package analysisexport

import (
	"context"
	"io"
	"strconv"
	"strings"
	"time"
	"unicode/utf16"

	"github.com/wei500L/newwei/apps/api-go/internal/analysiscollab"
	"github.com/wei500L/newwei/apps/api-go/internal/archivereading"
)

// searchFilename is the exact Content-Disposition name of the search export.
const searchFilename = "analysis-search-export.csv"

// searchHeader is the fixed 13-column headlines CSV contract.
var searchHeader = []string{
	"processedArticleId", "title", "summary", "countryLabel", "region", "vertical",
	"weight", "publishedAt", "sourceLabel", "eventId", "matchOrigin",
	"relevanceScore", "sourceUrl",
}

// maxSearchExportRows is the shared 5000-row output cap.
const maxSearchExportRows = 5000

// ArchiveSnapshotReader is the narrow snapshot port. It freezes the digest
// candidate/classification/display/search work once per export request.
type ArchiveSnapshotReader interface {
	BuildExportGroups(ctx context.Context, orgID string, input archivereading.DigestInput) (archivereading.ExportGroups, error)
}

// SearchService serves POST /api/analysis/exports/search. The items mode
// delegates to the already-migrated item export so the 5000 cap, behavior
// profile and field completion stay identical; the headlines mode uses one
// archive snapshot instead of re-running getDigest per cursor round.
type SearchService struct {
	items   *Service
	archive ArchiveSnapshotReader
}

// NewSearchService wires both modes.
func NewSearchService(items *Service, archive ArchiveSnapshotReader) *SearchService {
	return &SearchService{items: items, archive: archive}
}

// ExportSearchCSV writes the selected mode. Every query and model call happens
// before the first byte, so a failure can still be projected as an error status.
func (s *SearchService) ExportSearchCSV(ctx context.Context, orgID, userID, queryString string, w io.Writer) error {
	params := parseQueryParams(analysiscollab.NormalizeQueryString(queryString))
	mode := strings.ToLower(strings.TrimSpace(params.first("mode")))
	if mode != "headlines" {
		return s.items.ExportItemsCSV(ctx, orgID, userID, queryString, w)
	}
	input, err := parseArchiveSearchInput(params)
	if err != nil {
		return err
	}
	groups, err := s.archive.BuildExportGroups(ctx, orgID, input)
	if err != nil {
		return err
	}
	items := groups.RoundRobinItems(maxSearchExportRows)
	writer := newCSVRowWriter(w)
	writer.writeRow(searchHeader)
	for _, item := range items {
		writer.writeRow(buildSearchRow(item))
	}
	return writer.err
}

// parseArchiveSearchInput ports parseArchiveDate / parseArchiveRegion /
// parseArchiveWeights / parseArchiveSearch. The q two-character floor is
// deliberately local: archiveDigest still searches a non-empty one-character
// term.
func parseArchiveSearchInput(params queryParams) (archivereading.DigestInput, error) {
	anchor := parseArchiveSearchDate(params.first("archiveDate"))
	region := parseArchiveSearchRegion(params.first("archiveRegion"))
	weights := parseArchiveSearchWeights(params.first("archiveWeights"))
	search := ""
	if query := strings.TrimSpace(params.first("q")); utf16Length(query) >= 2 {
		search = query
	}
	return archivereading.DigestInput{
		AnchorDate: anchor,
		Region:     region,
		Search:     search,
		Weights:    weights,
		PageSize:   100,
	}, nil
}

func parseArchiveSearchDate(raw string) time.Time {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return time.Now()
	}
	parsed, ok := parseJSDate(trimmed + "T00:00:00.000Z")
	if !ok {
		return time.Now()
	}
	return parsed
}

// parseJSDate accepts the UTC form the source builds, plus a full RFC3339
// offset form for callers that already sent one.
func parseJSDate(value string) (time.Time, bool) {
	for _, layout := range []string{"2006-01-02T15:04:05.000Z", time.RFC3339Nano, time.RFC3339} {
		parsed, err := time.Parse(layout, value)
		if err == nil {
			return parsed, true
		}
	}
	return time.Time{}, false
}

func parseArchiveSearchRegion(raw string) archivereading.Region {
	switch strings.ToUpper(strings.TrimSpace(raw)) {
	case "MIDDLE_EAST":
		return archivereading.RegionMiddleEast
	case "AMERICAS":
		return archivereading.RegionAmericas
	case "EUROPE":
		return archivereading.RegionEurope
	case "AFRICA":
		return archivereading.RegionAfrica
	case "OTHER":
		return archivereading.RegionOther
	default:
		return archivereading.RegionAPAC
	}
}

func parseArchiveSearchWeights(raw string) []archivereading.Weight {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return archivereading.AllWeights()
	}
	weights := make([]archivereading.Weight, 0, 5)
	for _, part := range strings.Split(trimmed, ",") {
		value, ok := jsParseInt(strings.TrimSpace(part))
		if !ok {
			continue
		}
		switch value {
		case 5:
			weights = append(weights, archivereading.WeightFive)
		case 4:
			weights = append(weights, archivereading.WeightFour)
		case 3:
			weights = append(weights, archivereading.WeightThree)
		case 2:
			weights = append(weights, archivereading.WeightTwo)
		case 1:
			weights = append(weights, archivereading.WeightOne)
		}
	}
	if len(weights) == 0 {
		return archivereading.AllWeights()
	}
	return weights
}

func utf16Length(value string) int { return len(utf16.Encode([]rune(value))) }

// buildSearchRow projects one item with JS String/null semantics: null cells are
// empty, DateTime is UTC ISO with milliseconds, and numbers use String(value).
func buildSearchRow(item archivereading.DigestItem) []string {
	publishedAt := ""
	if item.PublishedAt != nil {
		publishedAt = formatISOTime(*item.PublishedAt)
	}
	eventID, sourceLabel, sourceURL, countryLabel := "", "", "", ""
	if item.EventID != nil {
		eventID = *item.EventID
	}
	if item.SourceLabel != nil {
		sourceLabel = *item.SourceLabel
	}
	if item.SourceURL != nil {
		sourceURL = *item.SourceURL
	}
	if item.CountryLabel != nil {
		countryLabel = *item.CountryLabel
	}
	origin := ""
	if item.MatchOrigin != nil {
		origin = string(*item.MatchOrigin)
	}
	relevance := ""
	if item.RelevanceScore != nil {
		relevance = formatJSNumber(*item.RelevanceScore)
	}
	title, summary := "", ""
	if item.Title != nil {
		title = *item.Title
	}
	if item.Summary != nil {
		summary = *item.Summary
	}
	return []string{
		item.ProcessedArticleID,
		title,
		summary,
		countryLabel,
		string(item.Region),
		string(item.Vertical),
		strconv.Itoa(item.Weight),
		publishedAt,
		sourceLabel,
		eventID,
		origin,
		relevance,
		sourceURL,
	}
}

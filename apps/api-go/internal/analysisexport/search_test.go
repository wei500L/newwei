package analysisexport

import (
	"testing"
	"time"

	"github.com/wei500L/newwei/apps/api-go/internal/archivereading"
)

func TestParseArchiveSearchInputDefaults(t *testing.T) {
	params := parseQueryParams("")
	input, err := parseArchiveSearchInput(params)
	if err != nil {
		t.Fatal(err)
	}
	if input.Region != archivereading.RegionAPAC {
		t.Fatalf("region = %s", input.Region)
	}
	if len(input.Weights) != 5 {
		t.Fatalf("weights = %v", input.Weights)
	}
	if input.Search != "" {
		t.Fatalf("search = %q", input.Search)
	}
	if input.AnchorDate.IsZero() {
		t.Fatal("anchor is zero")
	}
}

func TestParseArchiveSearchInputValues(t *testing.T) {
	params := parseQueryParams("archiveDate=2026-02-03&archiveRegion=middle_east&archiveWeights=5%2C3%2Cx&q=ai")
	input, err := parseArchiveSearchInput(params)
	if err != nil {
		t.Fatal(err)
	}
	if got := input.AnchorDate.Format("2006-01-02"); got != "2026-02-03" {
		t.Fatalf("anchor = %s", got)
	}
	if input.Region != archivereading.RegionMiddleEast {
		t.Fatalf("region = %s", input.Region)
	}
	if len(input.Weights) != 2 || input.Weights[0] != archivereading.WeightFive || input.Weights[1] != archivereading.WeightThree {
		t.Fatalf("weights = %v", input.Weights)
	}
	if input.Search != "" {
		t.Fatalf("one-character q must not search, got %q", input.Search)
	}

	params = parseQueryParams("q=ai")
	input, _ = parseArchiveSearchInput(params)
	if input.Search != "ai" {
		t.Fatalf("two-character q = %q", input.Search)
	}

	params = parseQueryParams("archiveWeights=9")
	input, _ = parseArchiveSearchInput(params)
	if len(input.Weights) != 5 {
		t.Fatalf("all-invalid weights = %v", input.Weights)
	}
}

func TestBuildSearchRowNullsAndNumbers(t *testing.T) {
	published := time.Date(2026, 2, 3, 4, 5, 6, 789000000, time.UTC)
	eventID := "evt"
	title := "title"
	relevance := 0.75
	origin := archivereading.MatchOriginHybrid
	row := buildSearchRow(archivereading.DigestItem{
		ProcessedArticleID: "pa-1",
		EventID:            &eventID,
		Title:              &title,
		Region:             archivereading.RegionAPAC,
		Vertical:           archivereading.VerticalEastSea,
		Weight:             4,
		PublishedAt:        &published,
		MatchOrigin:        &origin,
		RelevanceScore:     &relevance,
	})
	if len(row) != 13 {
		t.Fatalf("columns = %d", len(row))
	}
	if row[1] != "title" || row[2] != "" || row[3] != "" || row[7] != "2026-02-03T04:05:06.789Z" {
		t.Fatalf("row = %#v", row)
	}
	if row[10] != "HYBRID" || row[11] != "0.75" {
		t.Fatalf("origin/relevance = %#v", row)
	}
}

func TestSearchHeaderIsExact(t *testing.T) {
	want := []string{
		"processedArticleId", "title", "summary", "countryLabel", "region", "vertical",
		"weight", "publishedAt", "sourceLabel", "eventId", "matchOrigin",
		"relevanceScore", "sourceUrl",
	}
	for index, value := range want {
		if searchHeader[index] != value {
			t.Fatalf("header[%d] = %q, want %q", index, searchHeader[index], value)
		}
	}
}

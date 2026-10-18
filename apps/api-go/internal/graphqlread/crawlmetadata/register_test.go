package crawlmetadata

import (
	"context"
	"testing"
	"time"

	metadatasvc "github.com/wei500L/newwei/apps/api-go/internal/crawlmetadata"
	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/contract"
)

// TestRegisterAddsOnlyTheMetadataRootAndItsModels pins the registration
// boundary: one root and two models, never the neighbouring crawl task roots.
func TestRegisterAddsOnlyTheMetadataRootAndItsModels(t *testing.T) {
	reg := contract.NewRegistry()
	Register(reg, nil)

	root, ok := reg.Root("crawlMetadata")
	if !ok {
		t.Fatal("crawlMetadata root was not registered")
	}
	if root.Permission != "crawl.read" || root.AllowAuthenticated || len(root.AnyPermissions) != 0 {
		t.Fatalf("root = %+v", root)
	}
	if _, ok := reg.Root("crawlTasks"); ok {
		t.Fatal("crawlTasks belongs to settingscrawl and must not be re-registered")
	}
	if _, ok := reg.Root("crawlTask"); ok {
		t.Fatal("crawlTask belongs to settingscrawl and must not be re-registered")
	}
	if !reg.HasType("CrawlMetadataResultModel") || !reg.HasType("CrawlMetadataTagModel") {
		t.Fatal("both named models must be registered")
	}
	for _, field := range []string{
		"url", "status", "httpStatus", "fetchedAt", "title", "description",
		"keywords", "author", "metaTags", "openGraph", "jsonLd",
		"relevanceScore", "error",
	} {
		if !reg.HasField("CrawlMetadataResultModel", field) {
			t.Fatalf("CrawlMetadataResultModel is missing %s", field)
		}
	}
	for _, field := range []string{"name", "value"} {
		if !reg.HasField("CrawlMetadataTagModel", field) {
			t.Fatalf("CrawlMetadataTagModel is missing %s", field)
		}
	}
}

// TestCrawlMetadataInputNullIsNotAbsent pins the GraphQL null handling: an
// explicit null behaves like an omitted field, so the request still resolves to
// the sitemap branch and reports the missing domain.
func TestCrawlMetadataInputNullIsNotAbsent(t *testing.T) {
	reader := New(metadatasvc.NewService(nil, nil))
	for _, input := range []map[string]any{
		{},
		{"source": nil, "domain": nil},
		{"domain": ""},
	} {
		_, err := reader.CrawlMetadata(context.Background(), input)
		failure, ok := err.(*contract.Failure)
		if !ok || failure.Status != 400 || failure.Message != "domain is required when source is sitemap" {
			t.Fatalf("input %v error = %#v", input, err)
		}
	}
	_, err := reader.CrawlMetadata(context.Background(), map[string]any{"source": "urls"})
	failure, ok := err.(*contract.Failure)
	if !ok || failure.Status != 400 || failure.Message != "urls are required when source is urls" {
		t.Fatalf("error = %#v", err)
	}
}

// TestCrawlMetadataKeepsPerPageFailure tests the resolver boundary without any
// network: a localhost target is blocked by the production SSRF rules, so the
// call returns one failed item instead of a GraphQL error.
func TestCrawlMetadataKeepsPerPageFailure(t *testing.T) {
	reader := New(metadatasvc.NewService(nil, nil))
	results, err := reader.CrawlMetadata(context.Background(), map[string]any{
		"source": "urls",
		"urls":   []any{"http://localhost/secret"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(results) != 1 {
		t.Fatalf("results = %+v", results)
	}
	item := results[0]
	if item.Status != "failed" || item.Error == nil {
		t.Fatalf("item = %+v", item)
	}
	if item.MetaTags == nil || item.OpenGraph == nil || item.JSONLd == nil {
		t.Fatalf("list fields must be empty lists, not null: %+v", item)
	}
	if item.HTTPStatus != nil || item.FetchedAt != nil || item.Keywords != nil {
		t.Fatalf("a failed item must not invent optional values: %+v", item)
	}
}

// TestToGraphResultsMapsEveryOptionalToNull pins the toGraphMetadata
// projection: absent optionals become nil (GraphQL null) while the three list
// fields always stay lists.
func TestToGraphResultsMapsEveryOptionalToNull(t *testing.T) {
	status := 200
	fetched := time.Date(2024, 1, 2, 3, 4, 5, 0, time.UTC)
	keywords := []string{}
	models := toGraphResults([]metadatasvc.Result{{
		URL:        "https://example.com/a",
		Status:     metadatasvc.StatusSuccess,
		HTTPStatus: &status,
		FetchedAt:  &fetched,
		Keywords:   &keywords,
		MetaTags:   []metadatasvc.Tag{{Name: "a", Value: "b"}},
	}})
	if len(models) != 1 {
		t.Fatalf("models = %+v", models)
	}
	model := models[0]
	if model.HTTPStatus == nil || *model.HTTPStatus != 200 {
		t.Fatalf("httpStatus = %v", model.HTTPStatus)
	}
	if model.FetchedAt == nil || !model.FetchedAt.Equal(fetched) {
		t.Fatalf("fetchedAt = %v", model.FetchedAt)
	}
	if model.Title != nil || model.Description != nil || model.Author != nil ||
		model.RelevanceScore != nil || model.Error != nil {
		t.Fatalf("absent optionals must stay nil for GraphQL null: %+v", model)
	}
	if model.Keywords == nil || len(model.Keywords) != 0 {
		t.Fatalf("an empty keyword list must stay a list: %v", model.Keywords)
	}
	if model.OpenGraph == nil || len(model.OpenGraph) != 0 || model.JSONLd == nil {
		t.Fatalf("list fields must be non-nil: %+v", model)
	}
	if len(model.MetaTags) != 1 || model.MetaTags[0].Name != "a" {
		t.Fatalf("metaTags = %+v", model.MetaTags)
	}

	failed := toGraphResults([]metadatasvc.Result{{
		URL: "https://example.com/b", Status: metadatasvc.StatusFailed,
		MetaTags: []metadatasvc.Tag{}, OpenGraph: []metadatasvc.Tag{}, JSONLd: []string{},
	}})
	if failed[0].Keywords != nil {
		t.Fatal("a nil keyword slice must project as GraphQL null")
	}
}

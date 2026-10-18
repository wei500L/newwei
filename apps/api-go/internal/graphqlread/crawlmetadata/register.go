// Package crawlmetadata registers the crawlMetadata GraphQL query, the second
// entry of the web page metadata preview chain. It is a thin adapter over
// internal/crawlmetadata: the same service instance that answers POST
// /api/crawl-tasks/metadata answers this root.
//
// The package registers exactly the two named models the SDL declares
// (CrawlMetadataResultModel and CrawlMetadataTagModel) and the one root. It
// never registers the neighbouring crawlTasks/crawlTask roots, which belong to
// settingscrawl.
package crawlmetadata

import (
	"context"
	"errors"
	"net/http"
	"time"

	metadatasvc "github.com/wei500L/newwei/apps/api-go/internal/crawlmetadata"
	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/contract"
)

// TagModel is CrawlMetadataTagModel.
type TagModel struct {
	Name  string `graphql:"name"`
	Value string `graphql:"value"`
}

// ResultModel is CrawlMetadataResultModel. Nullable SDL fields use pointers so
// an absent value projects as GraphQL null; the three list fields are always
// rendered as lists.
type ResultModel struct {
	URL            string     `graphql:"url"`
	Status         string     `graphql:"status"`
	HTTPStatus     *float64   `graphql:"httpStatus"`
	FetchedAt      *time.Time `graphql:"fetchedAt"`
	Title          *string    `graphql:"title"`
	Description    *string    `graphql:"description"`
	Keywords       []string   `graphql:"keywords"`
	Author         *string    `graphql:"author"`
	MetaTags       []TagModel `graphql:"metaTags"`
	OpenGraph      []TagModel `graphql:"openGraph"`
	JSONLd         []string   `graphql:"jsonLd"`
	RelevanceScore *float64   `graphql:"relevanceScore"`
	Error          *string    `graphql:"error"`
}

// Reader adapts the metadata service to the root resolver signature.
type Reader struct {
	service *metadatasvc.Service
}

// New builds the reader around the shared metadata service.
func New(service *metadatasvc.Service) *Reader {
	return &Reader{service: service}
}

// Register records the two object types and the crawlMetadata root. The caller
// invokes it only when API_GO_GRAPHQL_READ_MODE and
// API_GO_GRAPHQL_CRAWL_METADATA_MODE are both go, outside settingscrawl.Register.
func Register(reg *contract.Registry, service *metadatasvc.Service) {
	if reg == nil {
		panic("graphqlread: crawlmetadata.Register requires a registry")
	}
	reader := New(service)
	reg.RegisterType("CrawlMetadataTagModel", TagModel{})
	reg.RegisterType("CrawlMetadataResultModel", ResultModel{})
	reg.RegisterRoot(contract.Root{
		Name:       "crawlMetadata",
		Permission: "crawl.read",
		Resolve: contract.Bind(func(ctx contract.Context) ([]ResultModel, error) {
			input, _ := contract.MapArg(ctx.Args, "input")
			return reader.CrawlMetadata(ctx.Ctx, input)
		}),
	})
}

// CrawlMetadata maps the CrawlMetadataInput argument onto the service input and
// runs the chain. Only absent and explicit null follow the source defaults; a
// present value is always taken verbatim.
func (r *Reader) CrawlMetadata(ctx context.Context, input map[string]any) ([]ResultModel, error) {
	extraction := metadatasvc.ExtractionInput{}
	if value, ok := contract.StringArg(input, "source"); ok {
		extraction.Source = value
	}
	if value, ok := contract.StringArg(input, "domain"); ok {
		extraction.Domain = value
	}
	if value, ok := contract.StringArg(input, "pattern"); ok {
		extraction.Pattern = value
	}
	if value, ok := contract.StringArg(input, "query"); ok {
		extraction.Query = value
	}
	if value, state := contract.Lookup(input, "urls"); state == contract.ArgValue {
		if items, ok := value.([]any); ok {
			urls := make([]string, 0, len(items))
			for _, item := range items {
				if text, ok := item.(string); ok {
					urls = append(urls, text)
				}
			}
			extraction.URLs = urls
		}
	}
	if value, ok := contract.IntArg(input, "maxUrls"); ok {
		extraction.MaxURLs = &value
	}
	if value, ok := contract.IntArg(input, "concurrency"); ok {
		extraction.Concurrency = &value
	}
	if value, state := contract.Lookup(input, "scoreThreshold"); state == contract.ArgValue {
		if number, ok := contract.AsFloat(value); ok {
			extraction.ScoreThreshold = &number
		}
	}
	extraction.ExtractJSONLd = boolArg(input, "extractJsonLd")
	extraction.ExtractOpenGraph = boolArg(input, "extractOpenGraph")
	extraction.ExtractStandardMeta = boolArg(input, "extractStandardMeta")

	results, err := r.service.Extract(ctx, extraction)
	if err != nil {
		// NestJS raises BadRequestException for the two input failures and the
		// exception filter renders it as a BAD_REQUEST field error with
		// http.status 400; every other failure stays a 500.
		var input *metadatasvc.InputError
		if errors.As(err, &input) {
			return nil, &contract.Failure{Message: input.Message, Status: http.StatusBadRequest}
		}
		return nil, err
	}
	return toGraphResults(results), nil
}

// boolArg reports a present boolean and nil for absent or null.
func boolArg(input map[string]any, name string) *bool {
	value, state := contract.Lookup(input, name)
	if state != contract.ArgValue {
		return nil
	}
	boolean, ok := value.(bool)
	if !ok {
		return nil
	}
	return &boolean
}

// toGraphResults applies toGraphMetadata: every optional field falls back to
// null, the three list fields stay lists and the date is an ISO string.
func toGraphResults(results []metadatasvc.Result) []ResultModel {
	out := make([]ResultModel, 0, len(results))
	for _, result := range results {
		model := ResultModel{
			URL:            result.URL,
			Status:         result.Status,
			FetchedAt:      result.FetchedAt,
			Title:          result.Title,
			Description:    result.Description,
			Author:         result.Author,
			MetaTags:       toGraphTags(result.MetaTags),
			OpenGraph:      toGraphTags(result.OpenGraph),
			JSONLd:         ensureStrings(result.JSONLd),
			RelevanceScore: result.RelevanceScore,
			Error:          result.Error,
		}
		if result.HTTPStatus != nil {
			status := float64(*result.HTTPStatus)
			model.HTTPStatus = &status
		}
		if result.Keywords != nil {
			model.Keywords = *result.Keywords
		}
		out = append(out, model)
	}
	return out
}

func toGraphTags(tags []metadatasvc.Tag) []TagModel {
	out := make([]TagModel, 0, len(tags))
	for _, tag := range tags {
		out = append(out, TagModel{Name: tag.Name, Value: tag.Value})
	}
	return out
}

func ensureStrings(values []string) []string {
	if values == nil {
		return []string{}
	}
	return values
}

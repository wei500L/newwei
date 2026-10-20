package crawltaskwrite

import (
	"testing"

	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/contract"
	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/settingscrawl"
)

// TestCrawlTaskModelRegisteredOnce covers the two registration paths the main
// wiring combines: the settings/crawl read registration already adds the
// CrawlTaskModel graph, and the narrow registration is only used when it did
// not. RegisterType is idempotent, so the assertion is that neither path panics
// and the mutation roots exist exactly once.
func TestCrawlTaskModelRegisteredOnce(t *testing.T) {
	narrow := contract.NewRegistry()
	settingscrawl.RegisterCrawlTaskModelTypes(narrow)
	Register(narrow, nil)
	if !narrow.HasType("CrawlTaskModel") || !narrow.HasType("CrawlResultModel") {
		t.Fatal("narrow registration must add the crawl task model graph")
	}
	for _, name := range RegisteredMutations {
		if _, ok := narrow.Mutation(name); !ok {
			t.Fatalf("mutation %s is not registered", name)
		}
	}

	// The read registration path already adds the same types. Registering the
	// CrawlTaskModel graph twice must remain a no-op rather than a duplicate.
	read := contract.NewRegistry()
	settingscrawl.Register(read, nil, settingscrawl.Options{})
	settingscrawl.RegisterCrawlTaskModelTypes(read)
	Register(read, nil)
	if !read.HasType("CrawlTaskModel") {
		t.Fatal("read registration must add the crawl task model graph")
	}
}

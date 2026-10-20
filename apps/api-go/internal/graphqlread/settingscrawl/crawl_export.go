package settingscrawl

import (
	"github.com/wei500L/newwei/apps/api-go/internal/crawlreadtelemetry"
	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/contract"
)

// RegisterCrawlTaskModelTypes records only the CrawlTask return model graph.
// The crawl-task ingest mutation returns CrawlTaskModel while the settings/crawl
// read roots are legacy, so this narrow port reuses the exported models without
// opening crawlTasks/crawlTask or any settings root.
func RegisterCrawlTaskModelTypes(reg *contract.Registry) {
	if reg == nil {
		panic("graphqlread: settingscrawl.RegisterCrawlTaskModelTypes requires a registry")
	}
	reg.RegisterType("CrawlTaskModel", CrawlTaskModel{})
	reg.RegisterType("CrawlMemoryStatsModel", CrawlMemoryStatsModel{})
	reg.RegisterType("CrawlExecutionSummaryModel", CrawlExecutionSummaryModel{})
	reg.RegisterType("CrawlResultModel", CrawlResultModel{})
	reg.RegisterType("CrawlLinkAnalysisModel", CrawlLinkAnalysisModel{})
	reg.RegisterType("CrawlLinkStatsModel", CrawlLinkStatsModel{})
	reg.RegisterType("CrawlLinkBucketModel", CrawlLinkBucketModel{})
	reg.RegisterType("CrawlLinkModel", CrawlLinkModel{})
}

// CrawlTaskModelFromView exposes the exact toGraphTask projection to the
// ingest resolver, so the update mutation and the crawlTask read root cannot
// disagree on config JSON, resultCount or nullable fields.
func CrawlTaskModelFromView(view crawlreadtelemetry.CrawlTaskView) CrawlTaskModel {
	return crawlTaskModelFromView(view)
}

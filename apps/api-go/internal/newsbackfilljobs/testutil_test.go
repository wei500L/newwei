package newsbackfilljobs

import "github.com/wei500L/newwei/apps/api-go/internal/newsnowclusteringops"

// domainJobForTest is the canonical payload used by the conversion tests.
func domainJobForTest() newsnowclusteringops.LlmBackfillJob {
	return newsnowclusteringops.LlmBackfillJob{
		JobType: newsnowclusteringops.LlmBackfillJobType,
		OrgID:   "org-1",
		ActorID: "user-1",
		GroupID: "group-1",
		TraceID: "trace-1",
		Trigger: "manual",
	}
}

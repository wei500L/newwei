package bullmqcleanup

import (
	"testing"
	"time"
)

// TestInventoryMatchesTrackedQueues pins the complete cleanable-queue list to
// the `cleanup.track(queue)` calls at baseline d4227721. QueueEvents tracks are
// not cleanable and must never appear here.
func TestInventoryMatchesTrackedQueues(t *testing.T) {
	want := []string{
		"assistant",
		"analysis",
		"archivePreparation",
		"classification_quality",
		"alerts",
		"crawl4ai",
		"crawl4ai-hot",
		"crawl4ai-normal",
		"frontier-llm-judge",
		"frontier-llm-learn",
		"news_event_clustering_recovery",
		"itemPipeline",
		"itemPipelineDlq",
		"situationMonitorSignals",
		"akshare-data",
	}
	specs := Inventory()
	if len(specs) != len(want) {
		t.Fatalf("inventory size = %d, want %d", len(specs), len(want))
	}
	for index, name := range want {
		if specs[index].Name != name {
			t.Fatalf("inventory[%d] = %q, want %q", index, specs[index].Name, name)
		}
	}
}

// TestInventoryRetentionProfiles pins the resolved KeepJobs values: every queue
// cleans failed jobs with BULLMQ_FAILED_JOB_RETENTION, and only itemPipelineDlq
// overrides failed plus waiting with BULLMQ_DLQ_JOB_RETENTION.
func TestInventoryRetentionProfiles(t *testing.T) {
	for _, spec := range Inventory() {
		if spec.Failed == nil {
			t.Fatalf("%s: failed retention is nil", spec.Name)
		}
		if spec.Name == "itemPipelineDlq" {
			if spec.Waiting == nil {
				t.Fatal("itemPipelineDlq: waiting retention is nil")
			}
			wantFailed := StateRetention{AgeSeconds: DLQRetentionAgeSeconds, Count: DLQRetentionCount}
			if *spec.Failed != wantFailed {
				t.Fatalf("itemPipelineDlq failed = %+v, want %+v", *spec.Failed, wantFailed)
			}
			if *spec.Waiting != wantFailed {
				t.Fatalf("itemPipelineDlq waiting = %+v, want %+v", *spec.Waiting, wantFailed)
			}
			continue
		}
		if spec.Waiting != nil {
			t.Fatalf("%s: waiting retention must be nil", spec.Name)
		}
		want := StateRetention{AgeSeconds: FailedRetentionAgeSeconds, Count: FailedRetentionCount}
		if *spec.Failed != want {
			t.Fatalf("%s failed = %+v, want %+v", spec.Name, *spec.Failed, want)
		}
	}
}

// TestRetentionConstants pins the values copied from bullmq-retention.ts.
func TestRetentionConstants(t *testing.T) {
	if FailedRetentionAgeSeconds != 7*24*60*60 || FailedRetentionCount != 10_000 {
		t.Fatalf("failed retention = %d/%d", FailedRetentionAgeSeconds, FailedRetentionCount)
	}
	if DLQRetentionAgeSeconds != 30*24*60*60 || DLQRetentionCount != 20_000 {
		t.Fatalf("dlq retention = %d/%d", DLQRetentionAgeSeconds, DLQRetentionCount)
	}
	if CleanBatchSize != 1_000 || CleanMaxBatches != 10 {
		t.Fatalf("batch size/max = %d/%d", CleanBatchSize, CleanMaxBatches)
	}
	if CleanInterval != time.Hour {
		t.Fatalf("interval = %v", CleanInterval)
	}
}

// TestQueueKeysUsesBullPrefix pins the default BullMQ key space. NestJS never
// passes an explicit prefix, and BULLMQ_NAMESPACE is a cache namespace.
func TestQueueKeysUsesBullPrefix(t *testing.T) {
	if got := queueKeys("itemPipelineDlq"); got != "bull:itemPipelineDlq:" {
		t.Fatalf("queue keys = %q", got)
	}
}

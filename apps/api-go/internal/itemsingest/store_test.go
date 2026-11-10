package itemsingest

import (
	"context"
	"database/sql"
	"errors"
	"strings"
	"testing"
	"time"
)

// deadCompensationFakeExecer records the compensation statements and can inject
// a failure on a chosen call, standing in for the mysql handle without a server.
type deadCompensationFakeExecer struct {
	queries []string
	args    [][]any
	failAt  int
}

func (f *deadCompensationFakeExecer) ExecContext(_ context.Context, query string, args ...any) (sql.Result, error) {
	f.queries = append(f.queries, query)
	f.args = append(f.args, args)
	if f.failAt != 0 && len(f.queries) == f.failAt {
		return nil, errors.New("mysql down")
	}
	return nil, nil
}

func TestApplyOutboxDeadCompensationWritesBothStatuses(t *testing.T) {
	jobID := "pipeline-1"
	payload := &OutboxPayload{OrgID: "org-1", ItemMetaID: "meta-1", RawItemID: "raw-1", PipelineJobID: &jobID}
	exec := &deadCompensationFakeExecer{}
	now := time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)
	if err := applyOutboxDeadCompensation(context.Background(), exec, payload, "boom", now); err != nil {
		t.Fatalf("compensation failed: %v", err)
	}
	if len(exec.queries) != 2 {
		t.Fatalf("queries = %v", exec.queries)
	}
	if !strings.Contains(exec.queries[0], "UPDATE ItemMeta") || !strings.Contains(exec.queries[0], "mongoRef = ?") {
		t.Fatalf("ItemMeta statement = %s", exec.queries[0])
	}
	if exec.args[0][1] != "meta-1" || exec.args[0][2] != "org-1" || exec.args[0][3] != "raw-1" {
		t.Fatalf("ItemMeta args = %v", exec.args[0])
	}
	if !strings.Contains(exec.queries[1], "UPDATE PipelineJob") {
		t.Fatalf("PipelineJob statement = %s", exec.queries[1])
	}
	if exec.args[1][0] != "boom" || exec.args[1][3] != jobID || exec.args[1][4] != "org-1" {
		t.Fatalf("PipelineJob args = %v", exec.args[1])
	}
}

func TestApplyOutboxDeadCompensationSkipsPipelineJobWithoutId(t *testing.T) {
	payload := &OutboxPayload{OrgID: "org-1", ItemMetaID: "meta-1", RawItemID: "raw-1"}
	exec := &deadCompensationFakeExecer{}
	if err := applyOutboxDeadCompensation(context.Background(), exec, payload, "boom", time.Now()); err != nil {
		t.Fatalf("compensation failed: %v", err)
	}
	if len(exec.queries) != 1 {
		t.Fatalf("queries = %v, want only the ItemMeta write", exec.queries)
	}
}

func TestApplyOutboxDeadCompensationReturnsErrors(t *testing.T) {
	for _, failAt := range []int{1, 2} {
		jobID := "pipeline-1"
		payload := &OutboxPayload{OrgID: "org-1", ItemMetaID: "meta-1", RawItemID: "raw-1", PipelineJobID: &jobID}
		exec := &deadCompensationFakeExecer{failAt: failAt}
		if err := applyOutboxDeadCompensation(context.Background(), exec, payload, "boom", time.Now()); err == nil {
			t.Fatalf("failAt=%d: want the write error returned", failAt)
		}
	}
}

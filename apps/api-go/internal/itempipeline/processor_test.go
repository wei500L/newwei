package itempipeline

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/wei500L/newwei/apps/api-go/internal/newspipeline"
)

type fakePipeline struct {
	called bool
	result newspipeline.ProcessResult
	err    error
}

func (f *fakePipeline) Process(_ context.Context, _ newspipeline.Job, _ newspipeline.RawItem) (newspipeline.ProcessResult, error) {
	f.called = true
	return f.result, f.err
}

func newTestProcessor(t *testing.T, pipeline Pipeline) *Processor {
	t.Helper()
	processor, err := NewProcessor(ProcessorOptions{Pipeline: pipeline})
	if err != nil {
		t.Fatalf("NewProcessor: %v", err)
	}
	return processor
}

func TestHandleValidatesRequiredJobData(t *testing.T) {
	cases := []struct {
		name    string
		payload Payload
		message string
	}{
		{"missing rawItemId", Payload{ItemMetaID: "m1", OrgID: "o1"}, "Queue job missing rawItemId or itemMetaId"},
		{"missing itemMetaId", Payload{RawItemID: "r1", OrgID: "o1"}, "Queue job missing rawItemId or itemMetaId"},
		{"missing orgId", Payload{RawItemID: "r1", ItemMetaID: "m1"}, "Queue job missing orgId"},
	}
	for _, testCase := range cases {
		pipeline := &fakePipeline{}
		processor := newTestProcessor(t, pipeline)
		_, err := processor.Handle(context.Background(), Job{ID: "job-1", Payload: testCase.payload, Data: json.RawMessage(`{}`)})
		if err == nil {
			t.Fatalf("%s: expected an error", testCase.name)
		}
		if err.Error() != testCase.message {
			t.Fatalf("%s: error = %q, want %q", testCase.name, err.Error(), testCase.message)
		}
		classified := ClassifyQueueError(err)
		if classified.Kind != ErrorKindPermanent || classified.Reason != "explicit-permanent" {
			t.Fatalf("%s: classified = %s/%s", testCase.name, classified.Kind, classified.Reason)
		}
		if pipeline.called {
			t.Fatalf("%s: pipeline must not run for an invalid payload", testCase.name)
		}
	}
}

func TestHandleFailureWritesTaskLogDataShape(t *testing.T) {
	// The failure listener must survive a nil database/mongo wiring (unit
	// tests) and still compute the DLQ decision from the classified error.
	pipeline := &fakePipeline{}
	processor := newTestProcessor(t, pipeline)
	job := Job{
		ID:      "job-1",
		Payload: Payload{RawItemID: "507f1f77bcf86cd799439011", ItemMetaID: "m1", OrgID: "o1"},
		Data:    json.RawMessage(`{"rawItemId":"507f1f77bcf86cd799439011","itemMetaId":"m1","orgId":"o1"}`),
		Opts:    JobOptions{Attempts: 5},
	}
	processor.HandleFailure(context.Background(), job, DecodeFailure(job, NewPermanentError("Raw item not found")))
	// No DB/Mongo/Redis is configured, so the only observable side effect is
	// that the call does not panic and does not require the DLQ producer.
}

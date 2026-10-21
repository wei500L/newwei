package queueops

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"testing"
)

// recordingAuditExecer records the statements the audit writer issues.
type recordingAuditExecer struct {
	calls     []recordedAuditCall
	auditErr  error
	outboxErr error
}

// recordedAuditCall is one recorded ExecContext call.
type recordedAuditCall struct {
	Query string
	Args  []any
}

func (r *recordingAuditExecer) ExecContext(_ context.Context, query string, args ...any) (sql.Result, error) {
	r.calls = append(r.calls, recordedAuditCall{Query: query, Args: args})
	switch {
	case strings.Contains(query, "AuditLogOutbox"):
		if r.outboxErr != nil {
			return nil, r.outboxErr
		}
	case strings.Contains(query, "AuditLog"):
		if r.auditErr != nil {
			return nil, r.auditErr
		}
	default:
		return nil, errors.New("unexpected statement: " + query)
	}
	return driver.RowsAffected(1), nil
}

func TestWriteAuditLogBestEffortInsertsAuditRow(t *testing.T) {
	exec := &recordingAuditExecer{}
	metadata := json.RawMessage(`{"queue":"itemPipeline","jobId":"job-1"}`)
	err := writeAuditLogBestEffort(context.Background(), exec, auditEntry{
		OrgID:    "org-a",
		ActorID:  "user-1",
		Resource: auditResource,
		Action:   actionJobRetry,
		Metadata: metadata,
	})
	if err != nil {
		t.Fatalf("write: %v", err)
	}
	if len(exec.calls) != 1 {
		t.Fatalf("calls = %d, want 1", len(exec.calls))
	}
	call := exec.calls[0]
	if !strings.Contains(call.Query, "INSERT INTO AuditLog (") {
		t.Fatalf("query = %s", call.Query)
	}
	if len(call.Args) != 7 {
		t.Fatalf("args = %d, want 7", len(call.Args))
	}
	id, ok := call.Args[0].(string)
	if !ok || !strings.HasPrefix(id, "c") || len(id) != 25 {
		t.Fatalf("id = %#v, want a cuid-shaped string", call.Args[0])
	}
	if call.Args[1] != "org-a" {
		t.Fatalf("orgId = %#v", call.Args[1])
	}
	actor, ok := call.Args[2].(*string)
	if !ok || actor == nil || *actor != "user-1" {
		t.Fatalf("actorId = %#v", call.Args[2])
	}
	if call.Args[3] != "queue" || call.Args[4] != actionJobRetry {
		t.Fatalf("resource/action = %#v/%#v", call.Args[3], call.Args[4])
	}
	stored, ok := call.Args[5].([]byte)
	if !ok || string(stored) != string(metadata) {
		t.Fatalf("metadata = %#v", call.Args[5])
	}
}

func TestWriteAuditLogBestEffortFallsBackToOutbox(t *testing.T) {
	exec := &recordingAuditExecer{auditErr: errors.New("audit table unavailable")}
	metadata := json.RawMessage(`{"queue":"itemPipeline","jobId":"job-1"}`)
	err := writeAuditLogBestEffort(context.Background(), exec, auditEntry{
		OrgID:    "org-a",
		ActorID:  "user-1",
		Resource: auditResource,
		Action:   actionJobDelete,
		Metadata: metadata,
	})
	if err != nil {
		t.Fatalf("write: %v", err)
	}
	if len(exec.calls) != 2 {
		t.Fatalf("calls = %d, want 2", len(exec.calls))
	}
	outbox := exec.calls[1]
	if !strings.Contains(outbox.Query, "INSERT INTO AuditLogOutbox") {
		t.Fatalf("query = %s", outbox.Query)
	}
	if len(outbox.Args) != 6 {
		t.Fatalf("args = %d, want 6", len(outbox.Args))
	}
	payload, ok := outbox.Args[2].([]byte)
	if !ok {
		t.Fatalf("payload type = %T", outbox.Args[2])
	}
	// The payload field set and order must match the NestJS writer so the retry
	// worker can replay the row unchanged.
	raw := string(payload)
	order := []string{`"orgId"`, `"actorId"`, `"resource"`, `"action"`, `"metadata"`, `"ipAddress"`, `"createdAt"`}
	position := -1
	for _, field := range order {
		index := strings.Index(raw, field)
		if index < 0 {
			t.Fatalf("payload misses %s: %s", field, raw)
		}
		if index <= position {
			t.Fatalf("payload field %s is out of order: %s", field, raw)
		}
		position = index
	}
	var decoded struct {
		OrgID     string          `json:"orgId"`
		ActorID   *string         `json:"actorId"`
		Resource  string          `json:"resource"`
		Action    string          `json:"action"`
		Metadata  json.RawMessage `json:"metadata"`
		IPAddress *string         `json:"ipAddress"`
		CreatedAt string          `json:"createdAt"`
	}
	if err := json.Unmarshal(payload, &decoded); err != nil {
		t.Fatalf("payload decode: %v", err)
	}
	if decoded.OrgID != "org-a" || decoded.Resource != "queue" || decoded.Action != actionJobDelete {
		t.Fatalf("payload = %+v", decoded)
	}
	if decoded.ActorID == nil || *decoded.ActorID != "user-1" {
		t.Fatalf("payload actor = %#v", decoded.ActorID)
	}
	if decoded.IPAddress != nil {
		t.Fatalf("payload ipAddress = %#v, want null", decoded.IPAddress)
	}
	if string(decoded.Metadata) != string(metadata) {
		t.Fatalf("payload metadata = %s", decoded.Metadata)
	}
	if !strings.HasSuffix(decoded.CreatedAt, "Z") || len(decoded.CreatedAt) != 24 {
		t.Fatalf("payload createdAt = %q", decoded.CreatedAt)
	}
}

func TestWriteAuditLogBestEffortReportsDoubleFailure(t *testing.T) {
	exec := &recordingAuditExecer{
		auditErr:  errors.New("audit table unavailable"),
		outboxErr: errors.New("outbox table unavailable"),
	}
	err := writeAuditLogBestEffort(context.Background(), exec, auditEntry{
		OrgID:    "org-a",
		ActorID:  "user-1",
		Resource: auditResource,
		Action:   actionQueuePause,
		Metadata: json.RawMessage(`{"queue":"itemPipeline","paused":true}`),
	})
	if err == nil {
		t.Fatalf("double failure reported as success")
	}
}

// ---- Service.audit through a stub MySQL driver ----

var registerAuditStubOnce sync.Once

// auditStubRecorder collects the statements the stub driver receives.
var auditStubRecorder = &recordingAuditExecer{}

type auditStubDriver struct{}

func (auditStubDriver) Open(string) (driver.Conn, error) { return auditStubConn{}, nil }

type auditStubConn struct{}

func (auditStubConn) Prepare(string) (driver.Stmt, error) {
	return nil, errors.New("audit stub: Prepare is not supported")
}

func (auditStubConn) Close() error { return nil }

func (auditStubConn) Begin() (driver.Tx, error) {
	return nil, errors.New("audit stub: transactions are not supported")
}

func (auditStubConn) ExecContext(ctx context.Context, query string, args []driver.NamedValue) (driver.Result, error) {
	values := make([]any, 0, len(args))
	for _, arg := range args {
		values = append(values, arg.Value)
	}
	return auditStubRecorder.ExecContext(ctx, query, values...)
}

func openAuditStubDB(t *testing.T, auditErr error) *sql.DB {
	t.Helper()
	registerAuditStubOnce.Do(func() {
		sql.Register("queueops_audit_stub", auditStubDriver{})
	})
	auditStubRecorder = &recordingAuditExecer{auditErr: auditErr}
	db, err := sql.Open("queueops_audit_stub", "")
	if err != nil {
		t.Fatalf("open stub db: %v", err)
	}
	t.Cleanup(func() {
		_ = db.Close()
	})
	return db
}

func TestServiceAuditJobWritesNamedMetadata(t *testing.T) {
	db := openAuditStubDB(t, nil)
	service := NewService(Options{DB: db})
	service.auditJob(context.Background(), Actor{OrgID: "org-a", UserID: "user-1"},
		actionJobPromote, "itemPipeline", "job-1")

	calls := auditStubRecorder.calls
	if len(calls) != 1 {
		t.Fatalf("calls = %d, want 1", len(calls))
	}
	metadata, ok := calls[0].Args[5].([]byte)
	if !ok {
		t.Fatalf("metadata type = %T", calls[0].Args[5])
	}
	if string(metadata) != `{"queue":"itemPipeline","jobId":"job-1"}` {
		t.Fatalf("metadata = %s", metadata)
	}
}

func TestServiceAuditFallsBackToOutbox(t *testing.T) {
	db := openAuditStubDB(t, errors.New("audit table unavailable"))
	service := NewService(Options{DB: db})
	service.auditClean(context.Background(), Actor{OrgID: "org-a", UserID: "user-1"},
		"itemPipeline", CleanStateCompleted, 0, 100, 7)

	calls := auditStubRecorder.calls
	if len(calls) != 2 {
		t.Fatalf("calls = %d, want 2 (audit then outbox)", len(calls))
	}
	metadata, ok := calls[1].Args[2].([]byte) // outbox payload
	if !ok {
		t.Fatalf("payload type = %T", calls[1].Args[2])
	}
	if !strings.Contains(string(metadata), `"action":"queue_clean"`) {
		t.Fatalf("outbox payload = %s", metadata)
	}
	if !strings.Contains(string(metadata), `"removed":7`) {
		t.Fatalf("outbox payload misses the clean metadata: %s", metadata)
	}
}

func TestServiceAuditWithoutDatabaseIsANoOp(t *testing.T) {
	service := NewService(Options{})
	service.auditJob(context.Background(), Actor{OrgID: "org-a"}, actionJobRetry, "itemPipeline", "job-1")
}

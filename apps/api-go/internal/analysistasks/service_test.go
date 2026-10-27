package analysistasks

import (
	"context"
	"testing"

	"github.com/wei500L/newwei/apps/api-go/internal/analysiscollab"
)

// createTaskBody runs the same DTO stage the handler uses, so the assertions
// below see exactly the Body the service receives in production.
func createTaskBody(t *testing.T, raw string) analysiscollab.Body {
	t.Helper()
	body, err := analysiscollab.ValidateBody([]byte(raw), analysiscollab.CreateTaskSpecs())
	if err != nil {
		t.Fatalf("validate create task body %s: %v", raw, err)
	}
	return body
}

// TestPrepareCreateFallsBackToNormalPriority covers createTask's
// `input.priority ?? AnalysisTaskPriority.normal`: an omitted priority and an
// explicit JSON null both create a normal card, because the NestJS DTO marks the
// field optional and the service only coalesces.
func TestPrepareCreateFallsBackToNormalPriority(t *testing.T) {
	actor := analysiscollab.Actor{ID: "user-1"}
	for _, raw := range []string{
		`{"title":"Corroborate claim"}`,
		`{"title":"Corroborate claim","priority":null}`,
	} {
		body := createTaskBody(t, raw)
		input, err := prepareCreate(context.Background(), nil, "org-1", actor, body)
		if err != nil {
			t.Fatalf("prepareCreate(%s) returned %v", raw, err)
		}
		if input.priority != analysiscollab.PriorityNormal {
			t.Fatalf("prepareCreate(%s) priority = %q, want %q", raw, input.priority, analysiscollab.PriorityNormal)
		}
	}
}

// TestPrepareCreateKeepsExplicitPriority makes sure the null fallback did not
// swallow a real enum value.
func TestPrepareCreateKeepsExplicitPriority(t *testing.T) {
	body := createTaskBody(t, `{"title":"Escalate","priority":"urgent"}`)
	input, err := prepareCreate(context.Background(), nil, "org-1", analysiscollab.Actor{ID: "user-1"}, body)
	if err != nil {
		t.Fatalf("prepareCreate returned %v", err)
	}
	if input.priority != analysiscollab.PriorityUrgent {
		t.Fatalf("priority = %q, want %q", input.priority, analysiscollab.PriorityUrgent)
	}
}

// TestPrepareUpdateRejectsNullPriority documents the intentional divergence:
// updateTask writes a null straight into a non-null column (Prisma failure), so
// the Go path answers 400 for the same body instead of a driver-level failure.
func TestPrepareUpdateRejectsNullPriority(t *testing.T) {
	body, err := analysiscollab.ValidateBody([]byte(`{"priority":null}`), analysiscollab.UpdateTaskSpecs())
	if err != nil {
		t.Fatalf("validate update task body: %v", err)
	}
	if _, err := prepareUpdate(context.Background(), nil, "org-1", analysiscollab.Actor{ID: "user-1"}, body); err == nil {
		t.Fatal("prepareUpdate with a null priority must fail")
	}
}

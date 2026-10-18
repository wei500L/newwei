package exec

import (
	"context"
	"testing"

	"github.com/vektah/gqlparser/v2/ast"
	"github.com/vektah/gqlparser/v2/parser"
	"github.com/vektah/gqlparser/v2/validator"

	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/contract"
	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/schema"
)

// TestBuildFieldSetResolvesAliasesFragmentsAndDirectives pins the read-only
// selection metadata: keys are canonical field names (aliases collapse), a
// fragment spread is expanded, and @skip/@include are already applied so a
// resolver never loads a field the caller excluded.
func TestBuildFieldSetResolvesAliasesFragmentsAndDirectives(t *testing.T) {
	loaded, err := schema.Load()
	if err != nil {
		t.Fatal(err)
	}
	source := `
		query ItemSelection($withRaw: Boolean!) {
			item(id: "x") {
				...ItemFields
				raw @include(if: $withRaw)
				processed {
					id
					resultJson @skip(if: true)
				}
			}
		}
		fragment ItemFields on ItemModel {
			myTitle: title
			meta { id }
		}`
	doc, err := parser.ParseQuery(&ast.Source{Name: "query", Input: source})
	if err != nil {
		t.Fatal(err)
	}
	// Validation annotates the AST with the directive and field definitions the
	// executor relies on, so @skip/@include can be evaluated.
	if errors := validator.Validate(loaded, doc); len(errors) > 0 {
		t.Fatalf("validation errors: %v", errors)
	}
	op := doc.Operations[0]
	selection := buildFieldSet(loaded, loaded.Query, op.SelectionSet, doc, map[string]any{"withRaw": false})

	item := selection.Child("item")
	if item == nil {
		t.Fatal("item selection missing")
	}
	if !item.Has("title") {
		t.Fatal("aliased fragment field must collapse onto the canonical name")
	}
	if !item.Has("meta") || !item.Child("meta").Has("id") {
		t.Fatal("fragment nested selection missing")
	}
	if item.Has("raw") {
		t.Fatal("@include(if: false) must not appear in the selection")
	}
	processed := item.Child("processed")
	if processed == nil || !processed.Has("id") {
		t.Fatal("processed selection missing")
	}
	if processed.Has("resultJson") {
		t.Fatal("@skip(if: true) must not appear in the selection")
	}

	selectionWithRaw := buildFieldSet(loaded, loaded.Query, op.SelectionSet, doc, map[string]any{"withRaw": true})
	if !selectionWithRaw.Child("item").Has("raw") {
		t.Fatal("@include(if: true) must appear in the selection")
	}
}

// TestExecutePassesSelectionToResolver pins the executor plumbing: the resolver
// receives the resolved selection of its own root field.
func TestExecutePassesSelectionToResolver(t *testing.T) {
	loaded, err := schema.Load()
	if err != nil {
		t.Fatal(err)
	}
	reg := contract.NewRegistry()
	reg.RegisterType("AlertChannelModel", alertChannel{})
	var captured *contract.FieldSet
	reg.RegisterRoot(contract.Root{
		Name:       "alertChannels",
		Permission: "alerts.read",
		Resolve: func(ctx contract.Context) (any, error) {
			captured = ctx.Selection
			return []alertChannel{}, nil
		},
	})
	engine := New(loaded, reg, 8, 2000, nil)
	plan := engine.PlanDocument(`query { channels: alertChannels { id } }`, nil, nil)
	if plan.Kind != KindExecute {
		t.Fatalf("plan kind %s", plan.Kind)
	}
	engine.Execute(context.Background(), plan, func(context.Context, string, string) (contract.Identity, error) {
		return contract.Identity{UserID: "user", OrgID: "org", Permissions: map[string]bool{"alerts.read": true}}, nil
	}, nil, false, 0, "schema", "")
	if captured == nil {
		t.Fatal("resolver did not receive a selection set")
	}
	if !captured.Has("id") {
		t.Fatal("aliased root field must collapse onto the canonical name")
	}
}

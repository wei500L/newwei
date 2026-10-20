package newsindicatorwrite

import (
	"context"
	"errors"
	"net/http"
	"testing"

	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/contract"
)

// TestRegisterAddsRefreshMutationAndPermission proves the mutation owns the
// settings.manage permission and appears exactly once.
func TestRegisterAddsRefreshMutationAndPermission(t *testing.T) {
	reg := contract.NewRegistry()
	Register(reg, nil, nil)
	root, ok := reg.Mutation("refreshNewsIndicatorAssociations")
	if !ok {
		t.Fatal("refreshNewsIndicatorAssociations is not registered")
	}
	if root.Permission != "settings.manage" {
		t.Fatalf("permission = %q", root.Permission)
	}
	if len(RegisteredMutations) != 1 || RegisteredMutations[0] != "refreshNewsIndicatorAssociations" {
		t.Fatalf("registered mutations = %v", RegisteredMutations)
	}
}

// TestRefreshFailureMapsToInternalGraphQLError proves a missing database is a
// 500 GraphQL failure, not a panic or a leaked internal message.
func TestRefreshFailureMapsToInternalGraphQLError(t *testing.T) {
	reg := contract.NewRegistry()
	Register(reg, nil, nil)
	root, ok := reg.Mutation("refreshNewsIndicatorAssociations")
	if !ok {
		t.Fatal("mutation is not registered")
	}
	value, err := root.Resolve(contract.Context{
		Ctx:      context.Background(),
		Identity: contract.Identity{UserID: "u1", OrgID: "org-1"},
	})
	if value != false {
		t.Fatalf("value = %v, want false", value)
	}
	var failure *contract.Failure
	if !errors.As(err, &failure) {
		t.Fatalf("err = %v, want *contract.Failure", err)
	}
	if failure.Status != http.StatusInternalServerError {
		t.Fatalf("status = %d", failure.Status)
	}
	if failure.Message != "Internal server error" {
		t.Fatalf("message = %q", failure.Message)
	}
}

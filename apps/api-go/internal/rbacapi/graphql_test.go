package rbacapi

import (
	"errors"
	"net/http"
	"testing"
)

func TestStatusOfMapsServiceErrors(t *testing.T) {
	status, message := StatusOf(newStatus(http.StatusConflict, "Role name already exists"))
	if status != http.StatusConflict || message != "Role name already exists" {
		t.Fatalf("conflict -> %d %q", status, message)
	}
	status, message = StatusOf(&inputError{Message: "At least one role is required"})
	if status != http.StatusBadRequest || message != "At least one role is required" {
		t.Fatalf("input -> %d %q", status, message)
	}
	status, message = StatusOf(errors.New("boom"))
	if status != http.StatusInternalServerError || message != "Internal server error" {
		t.Fatalf("unknown -> %d %q", status, message)
	}
	// A 5xx never leaks the internal message.
	status, message = StatusOf(newStatus(http.StatusInternalServerError, "database exploded"))
	if status != http.StatusInternalServerError || message != "Internal server error" {
		t.Fatalf("internal -> %d %q", status, message)
	}
}

func TestNormalizeRoleIDsTrimsDropsAndDeduplicates(t *testing.T) {
	got := normalizeRoleIDs([]string{" r1 ", "", "r2", "r1", "   ", "r2"})
	if len(got) != 2 || got[0] != "r1" || got[1] != "r2" {
		t.Fatalf("normalized %#v", got)
	}
	if empty := normalizeRoleIDs(nil); len(empty) != 0 {
		t.Fatalf("nil -> %#v", empty)
	}
}

func TestRoleViewFlattensPrismaRelationWrapper(t *testing.T) {
	description := "editor role"
	permissionDescription := "Read items"
	view := roleView(roleJSON{
		ID:          "r1",
		Name:        "editor",
		Description: &description,
		IsSystem:    true,
		Permissions: []rolePermissionJSON{{
			ID:           "rp1",
			RoleID:       "r1",
			PermissionID: "p1",
			Permission: permissionJSON{
				ID:          "p1",
				Name:        "items.read",
				Description: &permissionDescription,
			},
		}},
	})
	if view.ID != "r1" || view.Name != "editor" || !view.IsSystem {
		t.Fatalf("role %#v", view)
	}
	if len(view.Permissions) != 1 || view.Permissions[0].ID != "p1" || view.Permissions[0].Name != "items.read" {
		t.Fatalf("permissions %#v", view.Permissions)
	}
	if view.Permissions[0].Description == nil || *view.Permissions[0].Description != permissionDescription {
		t.Fatalf("permission description %#v", view.Permissions[0].Description)
	}
}

func TestUserViewFromMembershipCombinesActiveFlags(t *testing.T) {
	view := userViewFromMembership(membershipJSON{
		ID:       "m1",
		OrgID:    "o1",
		RoleID:   "r1",
		IsActive: false,
		User:     userJSON{ID: "u1", Email: "u@example.com", IsActive: true},
		Role: roleJSON{
			ID:          "r1",
			Name:        "admin",
			Permissions: []rolePermissionJSON{{Permission: permissionJSON{ID: "p1", Name: "org.write"}}},
		},
	}, linkedRoleIDs(membershipJSON{RoleID: "r1"}))
	if view.IsActive {
		t.Fatal("membership disabled but user reported active")
	}
	if view.ID != "u1" || view.PrimaryRoleID == nil || *view.PrimaryRoleID != "r1" {
		t.Fatalf("user view %#v", view)
	}
	if len(view.RoleIDs) != 1 || view.RoleIDs[0] != "r1" {
		t.Fatalf("role ids %#v", view.RoleIDs)
	}
	if len(view.Permissions) != 1 || view.Permissions[0] != "org.write" {
		t.Fatalf("permissions %#v", view.Permissions)
	}
}

// TestLinkedRoleIDsPrefersMembershipRoleLinks pins the roleIds fallback used by
// assignRole and setUserActive.
func TestLinkedRoleIDsPrefersMembershipRoleLinks(t *testing.T) {
	withLinks := linkedRoleIDs(membershipJSON{
		RoleID: "primary",
		Roles: []membershipRoleJSON{
			{RoleID: "r1"},
			{RoleID: ""},
			{RoleID: "r2"},
		},
	})
	if len(withLinks) != 2 || withLinks[0] != "r1" || withLinks[1] != "r2" {
		t.Fatalf("with links %#v", withLinks)
	}
	withoutLinks := linkedRoleIDs(membershipJSON{RoleID: "primary"})
	if len(withoutLinks) != 1 || withoutLinks[0] != "primary" {
		t.Fatalf("without links %#v", withoutLinks)
	}
	if empty := linkedRoleIDs(membershipJSON{}); len(empty) != 0 {
		t.Fatalf("empty %#v", empty)
	}
}

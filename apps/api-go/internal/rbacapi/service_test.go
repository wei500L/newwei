package rbacapi

import "testing"

// TestPermissionListKeepsOnlyStringEntries pins the MachineAccessToken
// permissions decoding: string elements survive, every other JSON type is
// dropped, and a non-array document grants nothing.
func TestPermissionListKeepsOnlyStringEntries(t *testing.T) {
	got := permissionList([]byte(`["roles.read",5,null,{"a":1},"users.read"]`))
	if len(got) != 2 || got[0] != "roles.read" || got[1] != "users.read" {
		t.Fatalf("permissions = %#v", got)
	}

	if empty := permissionList([]byte(`null`)); len(empty) != 0 {
		t.Fatalf("null document -> %#v", empty)
	}
	if empty := permissionList([]byte(`{"roles.read":true}`)); len(empty) != 0 {
		t.Fatalf("object document -> %#v", empty)
	}
	if empty := permissionList([]byte(`not json`)); len(empty) != 0 {
		t.Fatalf("invalid document -> %#v", empty)
	}
}

import {
  collectMembershipPermissionSet,
  collectMembershipRoleIds,
  collectMembershipRoles,
  hasMembershipPermission,
} from "./membership-permissions";

describe("membership-permissions", () => {
  it("falls back to the primary role when secondary roles are absent", () => {
    const membership = {
      roleId: "role-primary",
      role: {
        id: "role-primary",
        name: "primary",
        permissions: [{ permission: { name: "items.read" } }],
      },
      roles: [],
    };

    expect(collectMembershipRoles(membership)).toEqual([membership.role]);
    expect(collectMembershipRoleIds(membership)).toEqual(["role-primary"]);
    expect(Array.from(collectMembershipPermissionSet(membership))).toEqual([
      "items.read",
    ]);
  });

  it("uses explicit membership roles instead of the primary role when present", () => {
    const membership = {
      roleId: "role-primary",
      role: {
        id: "role-primary",
        name: "primary",
        permissions: [{ permission: { name: "items.read" } }],
      },
      roles: [
        {
          roleId: "role-ops",
          role: {
            id: "role-ops",
            name: "ops",
            permissions: [{ permission: { name: "settings.manage" } }],
          },
        },
      ],
    };

    expect(collectMembershipRoles(membership)).toEqual([
      membership.roles[0]!.role,
    ]);
    expect(collectMembershipRoleIds(membership)).toEqual(["role-ops"]);
    expect(Array.from(collectMembershipPermissionSet(membership))).toEqual([
      "settings.manage",
    ]);
  });

  it("deduplicates role ids and permissions while preserving insertion order", () => {
    const sharedPermission = { permission: { name: "items.read" } };
    const membership = {
      roleId: "role-primary",
      role: null,
      roles: [
        {
          roleId: "role-editor",
          role: {
            id: "role-editor",
            name: "editor",
            permissions: [
              sharedPermission,
              { permission: { name: "items.write" } },
            ],
          },
        },
        {
          roleId: "role-editor",
          role: {
            id: "role-editor-duplicate",
            name: "editor-copy",
            permissions: [sharedPermission],
          },
        },
        {
          roleId: "role-ops",
          role: {
            id: "role-ops",
            name: "ops",
            permissions: [{ permission: { name: "settings.manage" } }],
          },
        },
      ],
    };

    expect(collectMembershipRoleIds(membership)).toEqual([
      "role-editor",
      "role-ops",
    ]);
    expect(Array.from(collectMembershipPermissionSet(membership))).toEqual([
      "items.read",
      "items.write",
      "settings.manage",
    ]);
  });

  it("checks membership permissions against the aggregated set", () => {
    const membership = {
      roleId: "role-primary",
      role: {
        id: "role-primary",
        name: "primary",
        permissions: [{ permission: { name: "alerts.read" } }],
      },
      roles: null,
    };

    expect(hasMembershipPermission(membership, "alerts.read")).toBe(true);
    expect(hasMembershipPermission(membership, "items.read")).toBe(false);
  });
});

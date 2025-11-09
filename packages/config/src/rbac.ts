export const CORE_PERMISSIONS = [
  "org.read",
  "org.write",
  "users.read",
  "users.write",
  "roles.read",
  "roles.write",
  "permissions.read",
  "permissions.write",
  "items.read",
  "items.write",
  "queue.manage",
  "crawl.read",
  "crawl.write"
] as const;

export type CorePermission = (typeof CORE_PERMISSIONS)[number];

export interface DefaultRoleDefinition {
  name: string;
  description: string;
  permissions: CorePermission[];
}

export const DEFAULT_ROLES: DefaultRoleDefinition[] = [
  {
    name: "admin",
    description: "Full access across the administrative surface",
    permissions: [...CORE_PERMISSIONS]
  },
  {
    name: "manager",
    description: "Manage teams and items but limited system configuration",
    permissions: [
      "org.read",
      "users.read",
      "users.write",
      "roles.read",
      "permissions.read",
      "items.read",
      "items.write",
      "queue.manage",
      "crawl.read",
      "crawl.write"
    ]
  },
  {
    name: "analyst",
    description: "Read-only access to organizational and item data",
    permissions: ["org.read", "users.read", "roles.read", "items.read", "crawl.read"]
  }
];

export interface SeedUserDefinition {
  email: string;
  password: string;
  firstName: string;
  lastName: string;
  roles: string[];
}

export const DEFAULT_USERS: SeedUserDefinition[] = [
  {
    email: "admin@example.com",
    password: "Change_me123!",
    firstName: "Admin",
    lastName: "User",
    roles: ["admin"]
  }
];

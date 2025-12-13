export declare const CORE_PERMISSIONS: readonly ["org.read", "org.write", "settings.manage", "users.read", "users.write", "roles.read", "roles.write", "permissions.read", "permissions.write", "items.read", "items.write", "dashboards.read", "dashboards.write", "alerts.read", "alerts.manage", "analysis.read", "analysis.run", "queue.manage", "crawl.read", "crawl.write", "economicdata.read", "economicdata.manage", "akshare.fetch"];
export type CorePermission = (typeof CORE_PERMISSIONS)[number];
export interface DefaultRoleDefinition {
    name: string;
    description: string;
    permissions: CorePermission[];
    isSystem?: boolean;
}
export declare const DEFAULT_ROLES: DefaultRoleDefinition[];
export interface SeedUserDefinition {
    email: string;
    password: string;
    firstName: string;
    lastName: string;
    roles: string[];
}
export declare const DEFAULT_USERS: SeedUserDefinition[];
//# sourceMappingURL=rbac.d.ts.map
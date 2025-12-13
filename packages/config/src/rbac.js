"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_USERS = exports.DEFAULT_ROLES = exports.CORE_PERMISSIONS = void 0;
exports.CORE_PERMISSIONS = [
    "org.read",
    "org.write",
    "settings.manage",
    "users.read",
    "users.write",
    "roles.read",
    "roles.write",
    "permissions.read",
    "permissions.write",
    "items.read",
    "items.write",
    "dashboards.read",
    "dashboards.write",
    "alerts.read",
    "alerts.manage",
    "analysis.read",
    "analysis.run",
    "queue.manage",
    "crawl.read",
    "crawl.write",
    "economicdata.read",
    "economicdata.manage",
    "akshare.fetch"
];
exports.DEFAULT_ROLES = [
    {
        name: "admin",
        description: "Full access across the administrative surface",
        permissions: [...exports.CORE_PERMISSIONS],
        isSystem: true
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
            "dashboards.read",
            "dashboards.write",
            "alerts.read",
            "alerts.manage",
            "analysis.read",
            "analysis.run",
            "queue.manage",
            "crawl.read",
            "crawl.write",
            "economicdata.read",
            "akshare.fetch"
        ],
        isSystem: true
    },
    {
        name: "analyst",
        description: "Read-only access to organizational and item data",
        permissions: [
            "org.read",
            "users.read",
            "roles.read",
            "items.read",
            "dashboards.read",
            "alerts.read",
            "analysis.read",
            "crawl.read",
            "economicdata.read"
        ],
        isSystem: true
    }
];
exports.DEFAULT_USERS = [
    {
        email: "admin@example.com",
        password: "Change_me123!",
        firstName: "Admin",
        lastName: "User",
        roles: ["admin"]
    }
];
//# sourceMappingURL=rbac.js.map
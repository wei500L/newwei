// Package identityonboarding serves the sixteen registration, invitation and
// registration-application HTTP routes migrated from
// apps/api/src/modules/auth:
//
//	GET  /api/auth/admin/invites
//	POST /api/auth/admin/invites
//	POST /api/auth/admin/invites/:id/resend
//	POST /api/auth/admin/invites/:id/revoke
//	GET  /api/auth/admin/registration-applications
//	POST /api/auth/admin/registration-applications/:id/approve-join
//	POST /api/auth/admin/registration-applications/:id/reject-join
//	POST /api/auth/admin/registration-applications/:id/approve-org
//	POST /api/auth/admin/registration-applications/:id/reject-org
//	POST /api/auth/admin/registration-applications/:id/recover-org
//	POST /api/auth/admin/registration-applications/:id/resend-invite
//	POST /api/auth/register/applications
//	POST /api/auth/register/join-applications
//	GET  /api/auth/invitations/:token
//	POST /api/auth/invitations/:token/accept
//	POST /api/auth/invitations/:token/accept-authenticated
//
// The unit reuses the shared authentication chain (authn/authz/authhttp), the
// Node-compatible bcrypt helper and the profile-cache invalidation of
// accountsecurity, the real SMTP transport of authlogin through a narrow mail
// port, the organization bootstrap transaction of
// graphqlread/orgaccesswrite through a narrow port, and rbacapi for the
// permission re-derivation.
//
// Two behaviors are deliberately not copied from the source:
//
//   - the new-organization approval creates the administrator invitation through
//     a controlled internal path. The source reuses the ordinary invite guard,
//     which rejects the system admin role after the organization has already been
//     created, so the applicant could never join. The controlled path derives the
//     role from the organization and the application, is reachable only from the
//     platform-admin approval, and does not loosen the ordinary invite or
//     approve-join guards.
//   - a successful acceptance invalidates the profile cache of the user in the
//     default context and in every organization, so an existing account that
//     joins or has its roles replaced stops seeing the previous permission set
//     from /me.
//
// No route signs a session, starts a worker, sends a queued message or contacts
// an identity provider. Mail is delivered synchronously through SMTP after the
// approval database stage commits; a delivery failure is recorded in the
// approval progress instead of being returned as a rollback, so the console can
// distinguish a committed approval from a failed delivery and offer an explicit
// resend.
package identityonboarding

// Package accountdata implements the two remaining identity HTTP entries of the
// Go gateway:
//
//	POST /api/auth/avatar/presigned-url
//	GET  /api/auth/data-export
//
// The avatar endpoint only signs a PUT locally (no S3 request) with the
// configured bucket, credentials and TTL. The signature binds the declared
// content-length, so an object whose real size differs from the validated size
// is rejected by S3 instead of bypassing the 2 MB avatar limit.
//
// The export endpoint streams one JSON document. Small sections are loaded
// concurrently, while notifications, analysis comments and assistant runs are
// written row by row as they are read, so memory use no longer grows with the
// export size. Headers, filename and the rate limit are decided before the
// first body byte; the audit row (and its AuditLogOutbox fallback) is written
// only after the whole document has been produced.
//
// Both routes reuse the accountsecurity authentication chain (human JWT,
// Redis revocation list, MySQL membership re-derivation and mtk_ machine
// tokens) and the newsbehavior profile reader. Tenant scope always comes from
// the verified Identity (userId + orgId), never from the request body.
package accountdata

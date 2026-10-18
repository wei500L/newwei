// Package objectstorage is the narrow object-storage boundary of the api-go
// gateway. It turns one resolved storage configuration snapshot into an S3
// client, into presigned GET URLs and into the three operations the storage
// connection test performs (HeadBucket, PutObject, DeleteObject).
//
// The package owns no configuration lookup: every entry point receives a
// RuntimeConfig that a ConfigReader produced. The interface lives here rather
// than in the settings package so this package never imports
// infrastructuresettings, which imports this one for its diagnostics handler —
// no cycle.
//
// Only the official AWS SDK for Go v2 S3 client is used. The client is built
// from explicit static credentials, the configured region, an optional custom
// endpoint and the path-style switch; config.LoadDefaultConfig is deliberately
// never called, so no environment credential search and no instance-metadata
// probe can silently mask a missing configuration. Presigning happens locally
// (no network round trip) and presigned URLs are never logged.
//
// Every model here is a named struct with explicit fields; the package uses no
// any, interface{} or map values to carry business data.
package objectstorage

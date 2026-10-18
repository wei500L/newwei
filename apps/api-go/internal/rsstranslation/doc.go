// Package rsstranslation ports the synchronous RSS reader translation chain
// (apps/api/src/modules/items/items-rss-translation.service.ts) into the Go
// gateway.
//
// The chain resolves the newest completed processed document per item inside
// Mongo, projects the requested fields, translates them through either the
// DeepLX primary/fallback pair or the LLM gateway, and keeps two independent
// Redis caches in front of the upstream calls: the 7 day outer
// rss:translation:v1 cache and the 30 day inner
// situation-monitor:translation:v3 cache the situation monitor also uses.
//
// Every request records one daily metrics row and every real LLM attempt is
// observable through a named observer; both are best-effort side effects and
// never change the translation result. The package never writes the processed
// document, the read model, Elasticsearch, a queue or a notification.
package rsstranslation

// Package modelaccesssettings implements the Go takeover of the model service
// configuration, OpenAI key distribution and LiteLLM proxy load balancing
// closures (ten model access routes plus four load balancing routes).
//
// The model access routes are wired only when
// API_GO_MODEL_ACCESS_SETTINGS_MODE=go, and the load balancing routes only when
// API_GO_PROXY_LOAD_BALANCING_MODE=go. Both default to legacy (including the
// empty value), which keeps every request on the NestJS proxy, and each is
// rolled back by a single environment variable change. The two switches are
// independent: the load balancing routes always read the real OpenAI key
// configuration, whether or not the model access takeover is enabled.
//
// The package mirrors the NestJS contract one-for-one:
//
//   - routes 1-8 authenticate exactly like the other Go settings domains
//     (authhttp JWT verification + Redis blacklist + MySQL membership
//     re-derivation, plus the mtk_ machine-token path), and every global write
//     additionally requires the platform_admin global role inside the service,
//     because SystemSetting.key has no org dimension (MA1);
//   - routes 9-10 are the LiteLLM internal endpoints and are authenticated by
//     LITELLM_CONFIG_INTERNAL_TOKEN only: no JWT, no membership, no machine
//     token, constant-time comparison;
//   - request DTOs reproduce class-validator's default messages, its
//     independent-per-constraint evaluation and the exact order the global
//     ValidationPipe collects them in (declaration order, "; " joined, unknown
//     properties first);
//   - stored SystemSetting.value payloads are decoded into named structures
//     before use, including the three legacy OpenAI key shapes and the
//     system-settings:v1 AES-256-GCM envelope.
//
// Money paths never use weak types: this package contains no any, interface{},
// map[string]any or []any. JSON values whose shape is genuinely open (a stored
// SystemSetting.value, a Redis cache envelope) are decoded through
// json.RawMessage and immediately converted into named structs or named
// discriminated unions.
//
// Reads keep the original 30 second best-effort Redis cache contract; writes
// take a global MySQL session lock and re-read the authoritative MySQL row
// inside it (MA2/MA3), so a stale cache entry can never be used as a
// read-modify-write baseline.
package modelaccesssettings

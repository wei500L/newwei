package authfactors

import (
	"context"
	"encoding/json"
)

// This file is the narrow secret-codec port for callers outside the factor
// unit. The OIDC login unit needs to read the organization's stored
// clientSecret and to write/read the encrypted access and refresh tokens in the
// handoff row. Both operations must obey the exact same system-settings v1
// envelope and AuthSecurityService policy that the authenticated OIDC
// configuration and the MFA factor storage already use, so they are exported
// here instead of being reimplemented:
//
//   - a usable key and a non-disabled policy produce an AES-256-GCM envelope;
//   - an explicitly disabled policy or a missing key outside production may
//     store a plain JSON string (a documented policy result, not an error);
//   - a required key that is missing produces the shared error;
//   - a bare JSON string decodes as plaintext, a valid envelope decrypts with
//     the configured key, and a decryption failure is returned as an error
//     rather than as "no secret".
//
// No new cache key or settings protocol is introduced.

// EncodeLoginSecret encodes one plaintext secret and returns the JSON value to
// store in a Json column.
func (s *Service) EncodeLoginSecret(ctx context.Context, plain string) (json.RawMessage, error) {
	return s.encodeSecret(ctx, plain)
}

// DecodeLoginSecret decodes one Json column value. found=false means the value
// is absent or is not a shape the source would treat as a secret; an actual
// decryption failure is returned as an error.
func (s *Service) DecodeLoginSecret(ctx context.Context, raw []byte) (string, bool, error) {
	return s.decodeSecret(raw)
}

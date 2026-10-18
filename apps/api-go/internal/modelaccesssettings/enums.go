package modelaccesssettings

// settingsSource is the public "source" discriminator of the model service
// response (env|db) and of the OpenAI keys response (none|db).
type settingsSource string

const (
	// settingsSourceEnv means no model_service row is stored.
	settingsSourceEnv settingsSource = "env"
	// settingsSourceDB means a model_service or openai_keys row is stored.
	settingsSourceDB settingsSource = "db"
	// settingsSourceNone means no openai_keys row is stored. NestJS never
	// reports "env" for the OpenAI key response: LiteLLM's own environment
	// fallback is not part of this contract.
	settingsSourceNone settingsSource = "none"
)

// tokenSource reports where the effective model service token comes from.
type tokenSource string

const (
	// tokenSourceStored means the usable token came from the stored row.
	tokenSourceStored tokenSource = "stored"
	// tokenSourceEnv means the stored row has no usable token and
	// MODEL_SERVICE_INTERNAL_TOKEN is set.
	tokenSourceEnv tokenSource = "env"
	// tokenSourceNone means neither source yields a token.
	tokenSourceNone tokenSource = "none"
)

// appliedSource is the LiteLLM applied-status source reported by the proxy.
type appliedSource string

const (
	// appliedSourceDB means the proxy loaded the fingerprints from MySQL.
	appliedSourceDB appliedSource = "db"
	// appliedSourceEnv means the proxy loaded them from its own environment.
	appliedSourceEnv appliedSource = "env"
	// appliedSourceNone means the proxy reports that it applied no keys.
	appliedSourceNone appliedSource = "none"
)

// validAppliedSource reports whether a stored value is one of the three
// accepted applied sources; anything else normalizes to null.
func validAppliedSource(value string) (appliedSource, bool) {
	switch appliedSource(value) {
	case appliedSourceDB, appliedSourceEnv, appliedSourceNone:
		return appliedSource(value), true
	default:
		return "", false
	}
}

// secretKind discriminates the stored secret shapes of model_service
// .internalToken. The distinction between absent and null is load-bearing: a
// PUT that omits internalToken keeps the stored value, while an explicit null
// clears it.
type secretKind int

const (
	// secretAbsent means the JSON key was not present at all.
	secretAbsent secretKind = iota
	// secretNull means the JSON value was the literal null.
	secretNull
	// secretPlain means the value was a JSON string (legacy plaintext secret).
	secretPlain
	// secretEncrypted means the value was a system-settings:v1 envelope.
	secretEncrypted
	// secretOther means the value was any other JSON shape. It is preserved
	// verbatim but never treated as a usable secret.
	secretOther
)

// openAiKeyKind discriminates the three stored OpenAI key entry shapes.
type openAiKeyKind int

const (
	// openAiKeyUnusable means the entry was null/false/0 or an unrecognized
	// object: NestJS skips it in every algorithm.
	openAiKeyUnusable openAiKeyKind = iota
	// openAiKeyLegacyPlain means the entry was a bare JSON string.
	openAiKeyLegacyPlain
	// openAiKeyLegacyEncrypted means the entry was a bare system-settings:v1
	// envelope.
	openAiKeyLegacyEncrypted
	// openAiKeyWrapped means the entry was {fingerprint, value}.
	openAiKeyWrapped
)

package apidocs

import (
	"fmt"
	"strings"
)

// swaggerEnabledEnv is the environment variable NestJS validates for the docs
// surface. It is a NestJS switch, not one of the API_GO_* switches.
const swaggerEnabledEnv = "SWAGGER_ENABLED"

// SwaggerEnabled resolves the NestJS SWAGGER_ENABLED switch from the raw
// environment. The cmd/api wiring passes os.Getenv and cfg.NodeEnv, so the
// takeover reads exactly the variables the NestJS process reads.
//
// The rules mirror apps/api/src/modules/config/env.schema.ts:7-24 and
// 505-515:
//
//   - envBoolean trims and lower-cases the value, maps "true", "1", "yes", "y"
//     and "on" to true, maps "false", "0", "no", "n" and "off" to false, and
//     treats an empty (or whitespace-only) string as unset;
//   - an unset value falls back to the zod default, which is
//     process.env.NODE_ENV === "production" ? false : true — an exact,
//     untrimmed comparison against "production";
//   - any other spelling fails the zod schema, which makes NestJS refuse to
//     boot. Returning an error keeps the api-go takeover equally strict instead
//     of silently serving docs with a guessed value.
//
// The config.service.ts fallback (`?? false`) cannot trigger here: the schema
// default always applies before the service reads the value.
func SwaggerEnabled(getenv func(string) string, nodeEnv string) (bool, error) {
	raw := ""
	if getenv != nil {
		raw = strings.TrimSpace(getenv(swaggerEnabledEnv))
	}
	switch strings.ToLower(raw) {
	case "":
		return nodeEnv != "production", nil
	case "true", "1", "yes", "y", "on":
		return true, nil
	case "false", "0", "no", "n", "off":
		return false, nil
	default:
		return false, fmt.Errorf("%s=%q is not a boolean (NestJS envBoolean rejects it)", swaggerEnabledEnv, raw)
	}
}

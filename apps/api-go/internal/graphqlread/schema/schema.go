// Package schema embeds the NestJS GraphQL SDL and loads it with gqlparser.
//
// apps/api/schema.gql is the authority. The copy in this directory is checked
// byte-for-byte against that file by TestEmbeddedSchemaMatchesAPI. A reduced
// schema is not used for validation: unimplemented fields stay in the SDL and
// fail closed at ownership time instead of being reported as unknown.
package schema

import (
	"crypto/sha256"
	_ "embed"
	"encoding/hex"
	"fmt"

	"github.com/vektah/gqlparser/v2"
	"github.com/vektah/gqlparser/v2/ast"
)

//go:embed schema.gql
var source string

// Version is the SHA-256 of the embedded SDL. Response-cache keys include it
// so a schema change cannot serve a stale projection.
var Version = sha256Hex(source)

// Source returns the embedded SDL text.
func Source() string { return source }

// Load parses and validates the embedded SDL. The library is
// github.com/vektah/gqlparser/v2 v2.5.62.
func Load() (*ast.Schema, error) {
	loaded, err := gqlparser.LoadSchema(&ast.Source{Name: "schema.gql", Input: source})
	if err != nil {
		return nil, fmt.Errorf("graphqlread: load schema.gql: %w", err)
	}
	if loaded.Query == nil {
		return nil, fmt.Errorf("graphqlread: schema.gql has no Query type")
	}
	return loaded, nil
}

func sha256Hex(text string) string {
	sum := sha256.Sum256([]byte(text))
	return hex.EncodeToString(sum[:])
}

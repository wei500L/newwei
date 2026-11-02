// Package schema embeds the GraphQL SDL that both the Go runtime and the Web
// codegen consume, and loads it with gqlparser.
//
// The embedded schema.gql in this directory is the authoritative SDL for the
// Go runtime: the GraphQL executor, the root-coverage gate and the Web codegen
// (apps/web/codegen.cjs) all read it. It was copied byte-for-byte from the
// Nest generator output at the migration baseline; see PROVENANCE.md for the
// source SHA and generation boundary, and the CI "Contract copies in sync"
// step that keeps the copy equal to the Nest generator while the legacy app
// still exists. A reduced schema is not used for validation: unimplemented
// fields stay in the SDL and fail closed at ownership time instead of being
// reported as unknown.
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

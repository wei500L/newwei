package kgimpact

import "time"

// GraphQL object fields use the SDL names. Pointers are nullable.
// A nil slice of a non-null list is projected as an empty list.

type knowledgeGraphNodeModel struct {
	ID         string `graphql:"id" json:"id"`
	Name       string `graphql:"name" json:"name"`
	Type       string `graphql:"type" json:"type"`
	Properties any    `graphql:"properties" json:"properties"`
}

type knowledgeGraphEdgeModel struct {
	ID         string  `graphql:"id" json:"id"`
	From       string  `graphql:"from" json:"from"`
	To         string  `graphql:"to" json:"to"`
	Type       string  `graphql:"type" json:"type"`
	Weight     float64 `graphql:"weight" json:"weight"`
	Confidence float64 `graphql:"confidence" json:"confidence"`
	Properties any     `graphql:"properties" json:"properties"`
}

type knowledgeGraphExplainChainModel struct {
	Reason string                    `graphql:"reason" json:"reason"`
	Nodes  []knowledgeGraphNodeModel `graphql:"nodes" json:"nodes"`
	Edges  []knowledgeGraphEdgeModel `graphql:"edges" json:"edges"`
}

type knowledgeGraphImpactCandidateModel struct {
	Entity knowledgeGraphNodeModel           `graphql:"entity" json:"entity"`
	Score  float64                           `graphql:"score" json:"score"`
	Kind   string                            `graphql:"kind" json:"kind"`
	Chains []knowledgeGraphExplainChainModel `graphql:"chains" json:"chains"`
}

type knowledgeGraphImpactAnalysisModel struct {
	Scenario    string                               `graphql:"scenario" json:"scenario"`
	Seed        knowledgeGraphNodeModel              `graphql:"seed" json:"seed"`
	Candidates  []knowledgeGraphImpactCandidateModel `graphql:"candidates" json:"candidates"`
	Metadata    any                                  `graphql:"metadata" json:"metadata"`
	GeneratedAt time.Time                            `graphql:"generatedAt" json:"-"`
}

// impactCacheEntry is the Redis JSON shape. It mirrors the object Nest caches
// (generatedAt is an ISO-8601 string) so either side can read the other's key.
type impactCacheEntry struct {
	Scenario    string                               `json:"scenario"`
	Seed        knowledgeGraphNodeModel              `json:"seed"`
	Candidates  []knowledgeGraphImpactCandidateModel `json:"candidates"`
	Metadata    any                                  `json:"metadata"`
	GeneratedAt string                               `json:"generatedAt"`
}

type entityImpactNodeModel struct {
	ID       string  `graphql:"id"`
	Name     string  `graphql:"name"`
	Category string  `graphql:"category"`
	Type     string  `graphql:"type"`
	Value    float64 `graphql:"value"`
}

type entityImpactLinkModel struct {
	Source string  `graphql:"source"`
	Target string  `graphql:"target"`
	Value  float64 `graphql:"value"`
	Type   string  `graphql:"type"`
}

type entityImpactMetadataModel struct {
	TotalNodes  int       `graphql:"totalNodes"`
	TotalLinks  int       `graphql:"totalLinks"`
	GeneratedAt time.Time `graphql:"generatedAt"`
}

type entityImpactGraphModel struct {
	Nodes    []entityImpactNodeModel   `graphql:"nodes"`
	Links    []entityImpactLinkModel   `graphql:"links"`
	Metadata entityImpactMetadataModel `graphql:"metadata"`
}

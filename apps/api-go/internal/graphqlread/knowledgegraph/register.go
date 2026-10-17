// Package knowledgegraph serves the knowledge-graph and entity-360 read
// queries.
//
// Registered roots: getKnowledgeGraphSubgraph, articleEntityLinks,
// knowledgeGraphEdgeEvidence, entityIntelligenceCard,
// entityIntelligenceEvidence, knowledgeEntityByName.
//
// orgId and permissions always come from the server-derived membership. The
// executor already rejects mtk_ machine tokens for GraphQL reads.
//
// knowledgeGraphEvidenceReviewQueue, reviewKnowledgeGraphEvidence, the three
// impact queries, getEntityImpactGraph, and the settings reads/writes stay on
// NestJS. Selecting any of them makes the whole document fall back to Nest.
package knowledgegraph

import (
	"database/sql"

	"github.com/redis/go-redis/v9"

	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/contract"
)

// Register adds the six read roots and every object type they project.
func Register(reg *contract.Registry, db *sql.DB, redisClient *redis.Client) {
	if reg == nil {
		panic("graphqlread: knowledgegraph.Register requires a registry")
	}

	reg.RegisterType("KnowledgeGraphNodeModel", KnowledgeGraphNodeModel{})
	reg.RegisterType("KnowledgeGraphEdgeModel", KnowledgeGraphEdgeModel{})
	reg.RegisterType("KnowledgeGraphMetadataModel", KnowledgeGraphMetadataModel{})
	reg.RegisterType("KnowledgeGraphModel", KnowledgeGraphModel{})
	reg.RegisterType("ArticleEntityLinkModel", ArticleEntityLinkModel{})
	reg.RegisterType("KnowledgeGraphEdgeEvidenceArticleModel", KnowledgeGraphEdgeEvidenceArticleModel{})
	reg.RegisterType("KnowledgeGraphEdgeEvidenceItemModel", KnowledgeGraphEdgeEvidenceItemModel{})
	reg.RegisterType("EntityIntelligenceMetricsModel", EntityIntelligenceMetricsModel{})
	reg.RegisterType("EntityIntelligenceRelationshipModel", EntityIntelligenceRelationshipModel{})
	reg.RegisterType("EntitySentimentSnapshotModel", EntitySentimentSnapshotModel{})
	reg.RegisterType("EntityIntelligenceCardModel", EntityIntelligenceCardModel{})
	reg.RegisterType("EntityIntelligenceEventModel", EntityIntelligenceEventModel{})
	reg.RegisterType("EntityIntelligenceArticleModel", EntityIntelligenceArticleModel{})
	reg.RegisterType("EntityIntelligenceEvidenceArticleModel", EntityIntelligenceEvidenceArticleModel{})
	reg.RegisterType("EntityIntelligenceEvidenceModel", EntityIntelligenceEvidenceModel{})

	svc := &service{db: db, redis: redisClient}
	reg.RegisterRoot(contract.Root{Name: "getKnowledgeGraphSubgraph", Permission: "dashboards.read", Resolve: svc.getKnowledgeGraphSubgraph})
	reg.RegisterRoot(contract.Root{Name: "articleEntityLinks", Permission: "items.read", Resolve: svc.articleEntityLinks})
	reg.RegisterRoot(contract.Root{Name: "knowledgeGraphEdgeEvidence", Permission: "items.read", Resolve: svc.knowledgeGraphEdgeEvidence})
	reg.RegisterRoot(contract.Root{Name: "entityIntelligenceCard", Permission: "dashboards.read", Resolve: svc.entityIntelligenceCard})
	reg.RegisterRoot(contract.Root{Name: "entityIntelligenceEvidence", Permission: "dashboards.read", Resolve: svc.entityIntelligenceEvidence})
	reg.RegisterRoot(contract.Root{Name: "knowledgeEntityByName", Permission: "dashboards.read", Resolve: svc.knowledgeEntityByName})
}

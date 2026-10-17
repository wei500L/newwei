// Package kgimpact serves the knowledge-graph impact-conduction and
// entity co-occurrence/correlation GraphQL read roots.
//
// Registered roots: getExecutiveChangeImpact, getCommodityMoveImpact,
// getPolicyEventImpact, getEntityImpactGraph. Each requires dashboards.read and
// derives orgId from the server-side identity. The machine token (mtk_) is
// rejected by the shared GraphQL read executor's authentication chain.
//
// The impact roots read org-scoped knowledge settings, walk KnowledgeEdge, and
// cache the mapped analysis in Redis with Nest's key. getEntityImpactGraph
// reads Mongo processeditems and MySQL economic data.
package kgimpact

import (
	"database/sql"

	"github.com/redis/go-redis/v9"
	"go.mongodb.org/mongo-driver/v2/mongo"

	"github.com/wei500L/newwei/apps/api-go/internal/graphqlread/contract"
)

// Register adds the four read roots and the object types they project.
func Register(reg *contract.Registry, db *sql.DB, mongoDB *mongo.Database, redisClient *redis.Client) {
	if reg == nil {
		panic("kgimpact: nil registry")
	}
	reg.RegisterType("KnowledgeGraphNodeModel", knowledgeGraphNodeModel{})
	reg.RegisterType("KnowledgeGraphEdgeModel", knowledgeGraphEdgeModel{})
	reg.RegisterType("KnowledgeGraphExplainChainModel", knowledgeGraphExplainChainModel{})
	reg.RegisterType("KnowledgeGraphImpactCandidateModel", knowledgeGraphImpactCandidateModel{})
	reg.RegisterType("KnowledgeGraphImpactAnalysisModel", knowledgeGraphImpactAnalysisModel{})
	reg.RegisterType("EntityImpactGraphModel", entityImpactGraphModel{})
	reg.RegisterType("EntityImpactNodeModel", entityImpactNodeModel{})
	reg.RegisterType("EntityImpactLinkModel", entityImpactLinkModel{})
	reg.RegisterType("EntityImpactMetadataModel", entityImpactMetadataModel{})

	reader := &store{db: db, mongo: mongoDB, redis: redisClient}
	reg.RegisterRoot(contract.Root{
		Name:       "getExecutiveChangeImpact",
		Permission: "dashboards.read",
		Resolve:    reader.getExecutiveChangeImpact,
	})
	reg.RegisterRoot(contract.Root{
		Name:       "getCommodityMoveImpact",
		Permission: "dashboards.read",
		Resolve:    reader.getCommodityMoveImpact,
	})
	reg.RegisterRoot(contract.Root{
		Name:       "getPolicyEventImpact",
		Permission: "dashboards.read",
		Resolve:    reader.getPolicyEventImpact,
	})
	reg.RegisterRoot(contract.Root{
		Name:       "getEntityImpactGraph",
		Permission: "dashboards.read",
		Resolve:    reader.getEntityImpactGraph,
	})
}

package newseventsingest

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"math"
	"strings"
)

// unknownLanguageGroupKey is the `${language ?? "unknown"}` group prefix.
const unknownLanguageGroupKey = "unknown"

// batchSignalDocument is one article of the batch with its signal and vector.
type batchSignalDocument struct {
	Entry          ProcessedArticleRecord
	Signal         NewsSignal
	Embedding      []float64
	EmbeddingModel *string
}

// bertopicResult is the processBatch summary the caller logs.
type bertopicResult struct {
	ProcessedArticles int
	Assigned          int
	QueuedForManual   int
}

// processBatch mirrors NewsEventsBertopicService.processBatch: articles without
// a vector, without a model or without clusterable text are assigned one by one,
// the rest are grouped by `language::embeddingModel`, chunked and clustered, and
// every group smaller than the minimum falls back to sequential assignment.
func (a *assigner) processBatch(ctx context.Context, orgID string, batch []ProcessedArticleRecord, settings Settings) (bertopicResult, error) {
	documents := a.buildBatchSignalDocuments(batch)

	assigned := 0
	queuedForManual := 0

	immediateFallback, groups := partitionBatchDocuments(documents)

	count, err := a.assignSequentially(ctx, orgID, immediateFallback, settings)
	if err != nil {
		return bertopicResult{}, err
	}
	assigned += count

	// Iterate the recorded key order, never the map: the NestJS `Map` insertion
	// order decides which group is clustered first.
	for _, key := range groups.keys {
		group := groups.groups[key]
		if len(group) < settings.BertopicMinItemsPerGroup {
			count, err := a.assignSequentially(ctx, orgID, group, settings)
			if err != nil {
				return bertopicResult{}, err
			}
			assigned += count
			continue
		}

		for _, chunk := range chunkDocuments(group, settings.BertopicMaxItemsPerRequest) {
			if len(chunk) < settings.BertopicMinItemsPerGroup {
				count, err := a.assignSequentially(ctx, orgID, chunk, settings)
				if err != nil {
					return bertopicResult{}, err
				}
				assigned += count
				continue
			}
			result, err := a.clusterChunk(ctx, orgID, chunk, settings)
			if err != nil {
				return bertopicResult{}, err
			}
			assigned += result.Assigned
			queuedForManual += result.QueuedForManual
		}
	}

	return bertopicResult{
		ProcessedArticles: len(batch),
		Assigned:          assigned,
		QueuedForManual:   queuedForManual,
	}, nil
}

// partitionBatchDocuments splits the batch into the articles that must be
// assigned one by one (no vector, no model or no clusterable text) and the
// insertion-ordered groups keyed by `language::embeddingModel`. The
// `${language ?? "unknown"}` prefix and the group order are part of the contract.
func partitionBatchDocuments(documents []batchSignalDocument) ([]batchSignalDocument, *orderedGroups) {
	groups := newOrderedGroups()
	immediateFallback := make([]batchSignalDocument, 0, len(documents))
	for _, document := range documents {
		if len(document.Embedding) == 0 || document.EmbeddingModel == nil || !hasClusterableText(document) {
			immediateFallback = append(immediateFallback, document)
			continue
		}
		language := unknownLanguageGroupKey
		if document.Signal.Language != nil {
			language = *document.Signal.Language
		}
		groups.append(language+"::"+*document.EmbeddingModel, document)
	}
	return immediateFallback, groups
}

// clusterChunk mirrors clusterChunk: one cluster request, the representative
// assignment, the member assignment through the requested-event path, the
// outlier/unhandled sequential fallback, the success TaskLog and the failure
// record.
func (a *assigner) clusterChunk(ctx context.Context, orgID string, chunk []batchSignalDocument, settings Settings) (bertopicResult, error) {
	requestID, err := randomUUID()
	if err != nil {
		return bertopicResult{}, err
	}
	var language *string
	var embeddingModel *string
	if len(chunk) > 0 {
		language = chunk[0].Signal.Language
		embeddingModel = chunk[0].EmbeddingModel
	}

	documents := make([]TopicClusteringDocument, 0, len(chunk))
	for _, item := range chunk {
		documents = append(documents, TopicClusteringDocument{
			ID:        item.Signal.ProcessedArticleID,
			Text:      toClusterText(item),
			Embedding: item.Embedding,
		})
	}
	response, clusterErr := a.model.ClusterTopicsOrThrow(ctx, topicClusteringRequest{
		Documents:    documents,
		MinTopicSize: settings.BertopicMinTopicSize,
		RequestID:    requestID,
	})
	if clusterErr != nil {
		a.recordFailure(ctx, clusteringFailureInput{
			OrgID:          orgID,
			ClusteringMode: string(ClusteringModeBertopicPrimary),
			FailureReason:  clusteringFailureReasonRequestFailed,
			FailureMessage: clusterErr.Error(),
			RequestID:      &requestID,
			Language:       language,
			EmbeddingModel: embeddingModel,
			Items:          chunk,
			Metadata:       clusteringFailureMetadata{RequestID: requestID, DocumentCount: len(chunk)},
			Now:            a.clock(),
		})
		return bertopicResult{Assigned: 0, QueuedForManual: len(chunk)}, nil
	}

	assigned := 0
	byProcessedArticleID := make(map[string]batchSignalDocument, len(chunk))
	for _, item := range chunk {
		byProcessedArticleID[item.Signal.ProcessedArticleID] = item
	}
	handledIDs := make(map[string]struct{}, len(chunk))

	for _, cluster := range response.Clusters {
		representative, found := byProcessedArticleID[cluster.RepresentativeID]
		if !found {
			continue
		}
		handledIDs[cluster.RepresentativeID] = struct{}{}
		anchor, err := a.AssignNewsSignalToEvent(ctx, orgID, representative.Signal, settings)
		if err != nil {
			return bertopicResult{}, err
		}
		if anchor.Created {
			assigned++
		}

		for _, memberID := range cluster.ItemIDs {
			if memberID == cluster.RepresentativeID {
				continue
			}
			member, found := byProcessedArticleID[memberID]
			if !found {
				continue
			}
			handledIDs[memberID] = struct{}{}
			similarity := 0.0
			if len(representative.Embedding) > 0 && len(member.Embedding) > 0 {
				similarity = cosineSimilarity(representative.Embedding, member.Embedding)
			}
			if jsTrim(anchor.EventID) != "" && similarity >= settings.VectorMinScore {
				specific, err := a.AssignNewsSignalToSpecificEventWithSettings(ctx, orgID, anchor.EventID, member.Signal, settings, &similarity, assignmentMethodManual)
				if err != nil {
					return bertopicResult{}, err
				}
				if specific.Created {
					assigned++
				}
				continue
			}
			sequential, err := a.AssignNewsSignalToEvent(ctx, orgID, member.Signal, settings)
			if err != nil {
				return bertopicResult{}, err
			}
			if sequential.Created {
				assigned++
			}
		}
	}

	outlierIDs := make(map[string]struct{}, len(response.OutlierIDs))
	for _, outlierID := range response.OutlierIDs {
		outlierIDs[outlierID] = struct{}{}
	}
	sequentialFallback := make([]batchSignalDocument, 0, len(chunk))
	for _, item := range chunk {
		if _, isOutlier := outlierIDs[item.Signal.ProcessedArticleID]; isOutlier {
			sequentialFallback = append(sequentialFallback, item)
			continue
		}
		if _, handled := handledIDs[item.Signal.ProcessedArticleID]; !handled {
			sequentialFallback = append(sequentialFallback, item)
		}
	}
	count, err := a.assignSequentially(ctx, orgID, sequentialFallback, settings)
	if err != nil {
		return bertopicResult{}, err
	}
	assigned += count

	a.writeClusterTaskLog(ctx, orgID, requestID, language, embeddingModel, len(chunk), response)
	return bertopicResult{Assigned: assigned, QueuedForManual: 0}, nil
}

// writeClusterTaskLog writes the bertopic_cluster TaskLog. A write failure is a
// warning: the assignment already committed.
func (a *assigner) writeClusterTaskLog(ctx context.Context, orgID, requestID string, language, embeddingModel *string, documentCount int, response TopicClusteringResponse) {
	now := a.clock()
	data := bertopicClusterLogData{
		RequestID:      requestID,
		Language:       language,
		EmbeddingModel: embeddingModel,
		ClusterCount:   len(response.Clusters),
		OutlierCount:   len(response.OutlierIDs),
		DocumentCount:  documentCount,
	}
	if diagnostics, present, err := jsonLeafToBSONDocument(response.Diagnostics); err == nil && present {
		data.Diagnostics = diagnostics
	}
	encoded, err := marshalDocument(data)
	if err != nil {
		return
	}
	_ = a.store.insertTaskLog(ctx, taskLogDocument{
		Queue:     taskLogQueueNewsEvents,
		JobID:     requestID,
		OrgID:     orgID,
		Stage:     bertopicClusterStage,
		Status:    taskLogStatusCompleted,
		Data:      encoded,
		CreatedAt: now,
		UpdatedAt: now,
	})
}

// buildBatchSignalDocuments mirrors buildBatchSignalDocuments. The result and
// the summary vector both come from the O1 batch prefetch, so no per-article
// Mongo read happens here.
func (a *assigner) buildBatchSignalDocuments(batch []ProcessedArticleRecord) []batchSignalDocument {
	documents := make([]batchSignalDocument, 0, len(batch))
	for _, entry := range batch {
		processedItemID := jsNormalizeOptionalString(entry.CleanedMarkdownRef)
		var processedItemResult []byte
		var embedding []float64
		var embeddingModel *string
		if processedItemID != nil {
			if leaf, found := a.leaves[*processedItemID]; found {
				processedItemResult = leaf.Result
				if vector := leaf.summaryVector(); vector != nil {
					embedding = vector.Embedding
					model := vector.Model
					embeddingModel = &model
				}
			}
		}
		documents = append(documents, batchSignalDocument{
			Entry: entry,
			Signal: BuildNewsSignalFromProcessedArticle(BuildNewsSignalInput{
				ProcessedArticle:    entry,
				ProcessedItemResult: processedItemResult,
				Now:                 a.clock(),
			}),
			Embedding:      embedding,
			EmbeddingModel: embeddingModel,
		})
	}
	return documents
}

// assignSequentially mirrors assignSequentially and returns the created count.
func (a *assigner) assignSequentially(ctx context.Context, orgID string, documents []batchSignalDocument, settings Settings) (int, error) {
	assigned := 0
	for _, document := range documents {
		result, err := a.AssignNewsSignalToEvent(ctx, orgID, document.Signal, settings)
		if err != nil {
			return assigned, err
		}
		if result.Created {
			assigned++
		}
	}
	return assigned, nil
}

// hasClusterableText mirrors hasClusterableText.
func hasClusterableText(document batchSignalDocument) bool {
	return toClusterText(document) != ""
}

// toClusterText mirrors toClusterText: the trimmed title and summary, blanks
// dropped, joined with a blank line.
func toClusterText(document batchSignalDocument) string {
	parts := make([]string, 0, 2)
	for _, part := range []*string{document.Signal.Title, document.Signal.Summary} {
		if part == nil {
			continue
		}
		trimmed := jsTrim(*part)
		if trimmed == "" {
			continue
		}
		parts = append(parts, trimmed)
	}
	return strings.Join(parts, "\n\n")
}

// cosineSimilarity mirrors cosineSimilarity index by index: the dot product and
// both squared norms accumulate in one pass, and the denominator is the product
// of the two square roots (not the square root of the product). Different or
// empty lengths return 0.
func cosineSimilarity(left, right []float64) float64 {
	if len(left) == 0 || len(right) == 0 || len(left) != len(right) {
		return 0
	}
	dot := 0.0
	normLeft := 0.0
	normRight := 0.0
	for index := 0; index < len(left); index++ {
		dot += left[index] * right[index]
		normLeft += left[index] * left[index]
		normRight += right[index] * right[index]
	}
	denominator := math.Sqrt(normLeft) * math.Sqrt(normRight)
	if denominator > 0 {
		return dot / denominator
	}
	return 0
}

// chunkDocuments mirrors chunkDocuments: the size is at least 1 and the chunks
// keep the input order.
func chunkDocuments(items []batchSignalDocument, size int) [][]batchSignalDocument {
	normalizedSize := size
	if normalizedSize < 1 {
		normalizedSize = 1
	}
	chunks := make([][]batchSignalDocument, 0, (len(items)+normalizedSize-1)/normalizedSize)
	for index := 0; index < len(items); index += normalizedSize {
		end := index + normalizedSize
		if end > len(items) {
			end = len(items)
		}
		chunks = append(chunks, items[index:end])
	}
	return chunks
}

// orderedGroups is an insertion-ordered group list: the `Map` iteration order of
// the NestJS implementation decides which group runs first.
type orderedGroups struct {
	keys   []string
	groups map[string][]batchSignalDocument
}

// newOrderedGroups builds an empty group list.
func newOrderedGroups() *orderedGroups {
	return &orderedGroups{groups: make(map[string][]batchSignalDocument)}
}

// append adds one document to its group, creating the group on first use.
func (g *orderedGroups) append(key string, document batchSignalDocument) {
	existing, found := g.groups[key]
	if !found {
		g.keys = append(g.keys, key)
		g.groups[key] = []batchSignalDocument{document}
		return
	}
	g.groups[key] = append(existing, document)
}

// randomUUID returns a lowercase v4 UUID, matching randomUUID().
func randomUUID() (string, error) {
	var buffer [16]byte
	if _, err := rand.Read(buffer[:]); err != nil {
		return "", err
	}
	buffer[6] = (buffer[6] & 0x0f) | 0x40
	buffer[8] = (buffer[8] & 0x3f) | 0x80
	encoded := hex.EncodeToString(buffer[:])
	return encoded[0:8] + "-" + encoded[8:12] + "-" + encoded[12:16] + "-" + encoded[16:20] + "-" + encoded[20:32], nil
}

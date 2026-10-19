package accountdata

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"strings"

	"github.com/wei500L/newwei/apps/api-go/internal/accountsecurity"
)

// ServeDataExport produces the attachment for the authenticated caller.
//
// The order is deliberate: the rate limit and every bounded read happen before
// the first header/body byte, so an exhausted quota or a failed small section
// still answers a normal JSON error. The large arrays are then streamed; once
// the body has started a failure can only abort the connection (a JSON error
// would corrupt the attachment), and that path deliberately writes no audit
// row because the download never completed.
func (s *Service) ServeDataExport(w http.ResponseWriter, r *http.Request, identity *accountsecurity.Identity) {
	if identity == nil {
		return
	}
	ctx := r.Context()
	if err := s.enforceDataExportRateLimit(ctx, identity.OrgID, identity.UserID); err != nil {
		writeServiceError(w, r, err)
		return
	}
	exportedAt := s.now().UTC()
	exportedAtText := exportedAt.Format(jsDateLayout)
	small, err := s.loadSmall(ctx, identity.OrgID, identity.UserID)
	if err != nil {
		writeServiceError(w, r, err)
		return
	}
	filename := "wei-user-data-" + resolveOrgSlug(small.membership) + "-" + exportedAtText[:10] + ".json"

	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Pragma", "no-cache")
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Content-Disposition", `attachment; filename="`+filename+`"`)
	w.WriteHeader(http.StatusOK)

	counter := &countingWriter{writer: w}
	buffered := bufio.NewWriterSize(counter, 32*1024)
	stream := &jsonStream{writer: buffered}
	counts, err := s.writeExportBody(stream, ctx, identity, exportedAtText, small, s.exportStreams())
	if err == nil {
		err = stream.err
	}
	if err == nil {
		err = buffered.Flush()
	}
	if err != nil {
		log.Printf("accountdata: data export stream aborted: %v", err)
		// http.ErrAbortHandler makes net/http close the connection without a
		// terminating chunk, so the client sees a failed download instead of a
		// truncated but "valid" JSON file.
		panic(http.ErrAbortHandler)
	}

	s.writeExportAuditLog(ctx, identity, s.RequestIP(r), counter.count, counts)
}

// countingWriter counts the bytes actually written to the client so the audit
// byteLength matches the produced attachment byte for byte.
type countingWriter struct {
	writer io.Writer
	count  int64
}

func (w *countingWriter) Write(p []byte) (int, error) {
	written, err := w.writer.Write(p)
	w.count += int64(written)
	return written, err
}

// exportStreams groups the cursor reads of the large arrays. It is a value
// (not an interface) so the writer can be exercised with fixtures without a
// database while production passes the real cursor implementations.
type exportStreams struct {
	savedViews    func(context.Context, string, string, func(exportSavedView) error) error
	threads       func(context.Context, string, string, func(exportAnalysisThread) error) error
	comments      func(context.Context, string, string, func(exportAnalysisComment) error) error
	notifications func(context.Context, string, string, func(exportNotification) error) error
	assistantRuns func(context.Context, string, string, func(AssistantRun) error) error
}

// exportStreams wires the MySQL cursors and the Mongo source.
func (s *Service) exportStreams() exportStreams {
	return exportStreams{
		savedViews:    s.forEachSavedView,
		threads:       s.forEachAnalysisThread,
		comments:      s.forEachAnalysisComment,
		notifications: s.forEachNotification,
		assistantRuns: s.forEachAssistantRun,
	}
}

// writeExportBody emits `JSON.stringify(payload, null, 2) + "\n"` without
// materialising the large arrays.
func (s *Service) writeExportBody(stream *jsonStream, ctx context.Context, identity *accountsecurity.Identity, exportedAt string, small *smallSections, streams exportStreams) (recordCount, error) {
	counts := recordCount{}
	stream.write("{\n  \"format\": ")
	stream.value(0, exportFormat)
	stream.write(",\n  \"version\": ")
	stream.value(0, exportVersion)
	stream.write(",\n  \"exportedAt\": ")
	stream.value(0, exportedAt)
	stream.write(",\n  \"subject\": {\n    \"userId\": ")
	stream.value(0, identity.UserID)
	stream.write(",\n    \"orgId\": ")
	stream.value(0, identity.OrgID)
	stream.write("\n  },\n  \"sections\": {\n")

	stream.write("    \"account\": ")
	stream.value(2, small.account)
	stream.write(",\n    \"membership\": ")
	stream.value(2, small.membership)
	stream.write(",\n    \"userSettings\": ")
	writeArrayValues(stream, 2, small.userSettings, &counts.UserSettings)
	stream.write(",\n    \"contentSubscriptions\": ")
	writeArrayValues(stream, 2, small.contentSubscriptions, &counts.ContentSubscriptions)
	stream.write(",\n    \"newsBehavior\": ")
	stream.value(2, small.newsBehavior)
	stream.write(",\n    \"digest\": ")
	stream.value(2, small.digest)

	stream.write(",\n    \"analysisWorkspace\": {\n      \"savedViews\": ")
	if err := streamArray(stream, 3, func(yield func(exportSavedView) error) error {
		return streams.savedViews(ctx, identity.OrgID, identity.UserID, yield)
	}, &counts.SavedViews); err != nil {
		return counts, err
	}
	stream.write(",\n      \"threads\": ")
	if err := streamArray(stream, 3, func(yield func(exportAnalysisThread) error) error {
		return streams.threads(ctx, identity.OrgID, identity.UserID, yield)
	}, &counts.AnalysisThreads); err != nil {
		return counts, err
	}
	stream.write(",\n      \"comments\": ")
	if err := streamArray(stream, 3, func(yield func(exportAnalysisComment) error) error {
		return streams.comments(ctx, identity.OrgID, identity.UserID, yield)
	}, &counts.AnalysisComments); err != nil {
		return counts, err
	}
	stream.write("\n    },\n    \"notifications\": ")
	if err := streamArray(stream, 2, func(yield func(exportNotification) error) error {
		return streams.notifications(ctx, identity.OrgID, identity.UserID, yield)
	}, &counts.Notifications); err != nil {
		return counts, err
	}
	stream.write(",\n    \"assistantRuns\": ")
	if err := streamArray(stream, 2, func(yield func(AssistantRun) error) error {
		return streams.assistantRuns(ctx, identity.OrgID, identity.UserID, yield)
	}, &counts.AssistantRuns); err != nil {
		return counts, err
	}
	stream.write("\n  }\n}\n")
	return counts, stream.err
}

// writeArrayValues writes a small in-memory array with the same indentation the
// one-shot JSON.stringify(payload, null, 2) produces.
func writeArrayValues[T any](stream *jsonStream, depth int, values []T, count *int) {
	if stream.err != nil {
		return
	}
	*count = len(values)
	if len(values) == 0 {
		stream.write("[]")
		return
	}
	stream.write("[\n")
	for index, item := range values {
		if index > 0 {
			stream.write(",\n")
		}
		stream.write(indentString(depth + 1))
		stream.value(depth+1, item)
	}
	stream.write("\n" + indentString(depth) + "]")
}

// streamArray writes an array whose elements arrive from a cursor. It keeps the
// exact byte layout of writeArrayValues while never holding more than one
// decoded row.
func streamArray[T any](stream *jsonStream, depth int, iterate func(func(T) error) error, count *int) error {
	if stream.err != nil {
		return stream.err
	}
	stream.write("[")
	written := 0
	err := iterate(func(item T) error {
		if written == 0 {
			stream.write("\n")
		} else {
			stream.write(",\n")
		}
		stream.write(indentString(depth + 1))
		stream.value(depth+1, item)
		written++
		return stream.err
	})
	if err != nil {
		return err
	}
	if written == 0 {
		stream.write("]")
	} else {
		stream.write("\n" + indentString(depth) + "]")
	}
	*count = written
	return stream.err
}

// jsonStream writes the JSON.stringify(payload, null, 2) layout sequentially.
// Each value is encoded with HTML escaping disabled (JSON.stringify never
// escapes <, > or &) and then re-indented to its absolute depth.
type jsonStream struct {
	writer *bufio.Writer
	err    error
}

func (s *jsonStream) write(text string) {
	if s.err != nil {
		return
	}
	if _, err := s.writer.WriteString(text); err != nil {
		s.err = err
	}
}

func (s *jsonStream) value(depth int, value any) {
	if s.err != nil {
		return
	}
	var encoded strings.Builder
	encoder := json.NewEncoder(&encoded)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(value); err != nil {
		s.err = err
		return
	}
	compact := strings.TrimSuffix(encoded.String(), "\n")
	var indented strings.Builder
	if err := json.Indent(&indented, []byte(compact), "", "  "); err != nil {
		s.err = err
		return
	}
	prefix := indentString(depth)
	s.write(strings.ReplaceAll(indented.String(), "\n", "\n"+prefix))
}

// indentString is the two-space indentation JSON.stringify uses per depth.
func indentString(depth int) string {
	if depth <= 0 {
		return ""
	}
	return strings.Repeat("  ", depth)
}

// resolveOrgSlug mirrors resolveOrgSlug: org.slug, then org.id, then "org",
// followed by sanitizeFilenameSegment.
func resolveOrgSlug(membership *exportMembership) string {
	value := "org"
	if membership != nil && membership.Org != nil {
		value = membership.Org.Slug
	}
	return sanitizeFilenameSegment(value)
}

// sanitizeFilenameSegment mirrors
// `value.trim().replace(/[^a-zA-Z0-9-_]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64) || "org"`.
func sanitizeFilenameSegment(value string) string {
	trimmed := strings.TrimSpace(value)
	var builder strings.Builder
	builder.Grow(len(trimmed))
	inRun := false
	for _, char := range trimmed {
		allowed := (char >= 'a' && char <= 'z') || (char >= 'A' && char <= 'Z') ||
			(char >= '0' && char <= '9') || char == '-' || char == '_'
		if allowed {
			builder.WriteRune(char)
			inRun = false
			continue
		}
		if !inRun {
			builder.WriteByte('-')
			inRun = true
		}
	}
	sanitized := strings.Trim(builder.String(), "-")
	if len(sanitized) > 64 {
		sanitized = sanitized[:64]
	}
	if sanitized == "" {
		return "org"
	}
	return sanitized
}

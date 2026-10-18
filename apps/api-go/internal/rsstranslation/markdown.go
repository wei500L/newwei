package rsstranslation

import (
	"regexp"
	"strings"
	"unicode/utf16"
)

// Markdown chunking constants copied from ItemsRssTranslationService.
const (
	maxTranslationTextChars = 12_000
	maxMarkdownChars        = 120_000
	markdownChunkMaxChars   = 1_600
	maxMarkdownChunks       = 80
)

var markdownParagraphSplit = regexp.MustCompile("\n{2,}")

// jsLength returns the JavaScript String.prototype.length of value, i.e. the
// number of UTF-16 code units. Go's len() counts bytes, so it must never be
// used for the NestJS text limits.
func jsLength(value string) int {
	count := 0
	for _, r := range value {
		if r > 0xFFFF {
			count += 2
		} else {
			count++
		}
	}
	return count
}

// jsSlice mirrors String.prototype.slice(start, end) for non-negative bounds.
// A boundary that splits a surrogate pair decodes the lone surrogate to the
// Unicode replacement character, matching how the value would be re-encoded.
func jsSlice(value string, start, end int) string {
	units := utf16.Encode([]rune(value))
	if start < 0 {
		start = 0
	}
	if end > len(units) {
		end = len(units)
	}
	if start >= end {
		return ""
	}
	return string(utf16.Decode(units[start:end]))
}

// splitMarkdownIntoChunks ports splitMarkdownIntoChunks: paragraphs are split
// on runs of blank lines, long paragraphs fall through splitLongChunk, and the
// remaining paragraphs are packed under markdownChunkMaxChars with blank-line
// joins.
func splitMarkdownIntoChunks(markdown string) []string {
	rawParagraphs := markdownParagraphSplit.Split(markdown, -1)
	paragraphs := make([]string, 0, len(rawParagraphs))
	for _, entry := range rawParagraphs {
		trimmed := strings.TrimSpace(entry)
		if trimmed != "" {
			paragraphs = append(paragraphs, trimmed)
		}
	}
	if len(paragraphs) == 0 {
		return []string{markdown}
	}

	chunks := make([]string, 0, len(paragraphs))
	current := ""
	flushCurrent := func() {
		normalized := strings.TrimSpace(current)
		if normalized != "" {
			chunks = append(chunks, normalized)
		}
		current = ""
	}

	for _, paragraph := range paragraphs {
		if jsLength(paragraph) > markdownChunkMaxChars {
			flushCurrent()
			for _, entry := range splitLongChunk(paragraph) {
				if entry != "" {
					chunks = append(chunks, entry)
				}
			}
			continue
		}
		candidate := paragraph
		if current != "" {
			candidate = current + "\n\n" + paragraph
		}
		if jsLength(candidate) > markdownChunkMaxChars {
			flushCurrent()
			current = paragraph
		} else {
			current = candidate
		}
	}
	flushCurrent()
	if len(chunks) > 0 {
		return chunks
	}
	return []string{markdown}
}

// splitLongChunk ports splitLongChunk: one over-long paragraph is first split
// on single newlines and then hard-sliced every markdownChunkMaxChars UTF-16
// units.
func splitLongChunk(text string) []string {
	rawParts := strings.Split(text, "\n")
	parts := make([]string, 0, len(rawParts))
	for _, entry := range rawParts {
		trimmed := strings.TrimSpace(entry)
		if trimmed != "" {
			parts = append(parts, trimmed)
		}
	}
	if len(parts) == 0 {
		return []string{text}
	}

	chunks := make([]string, 0, len(parts))
	current := ""
	for _, part := range parts {
		partLength := jsLength(part)
		if partLength > markdownChunkMaxChars {
			if strings.TrimSpace(current) != "" {
				chunks = append(chunks, strings.TrimSpace(current))
				current = ""
			}
			for index := 0; index < partLength; index += markdownChunkMaxChars {
				chunks = append(chunks, strings.TrimSpace(jsSlice(part, index, index+markdownChunkMaxChars)))
			}
			continue
		}
		candidate := part
		if current != "" {
			candidate = current + "\n" + part
		}
		if jsLength(candidate) > markdownChunkMaxChars {
			if strings.TrimSpace(current) != "" {
				chunks = append(chunks, strings.TrimSpace(current))
			}
			current = part
		} else {
			current = candidate
		}
	}
	if strings.TrimSpace(current) != "" {
		chunks = append(chunks, strings.TrimSpace(current))
	}
	return chunks
}

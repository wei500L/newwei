import { describe, expect, it } from 'vitest';

import { normalizeStreamingMarkdown } from '../lib/markdown-streaming';

describe('normalizeStreamingMarkdown', () => {
  it('keeps text unchanged when not streaming', () => {
    const input = '```ts\nconst x = 1;';
    expect(normalizeStreamingMarkdown(input, false)).toBe(input);
  });

  it('keeps text unchanged when fences are balanced', () => {
    const input = '```ts\nconst x = 1;\n```';
    expect(normalizeStreamingMarkdown(input, true)).toBe(input);
  });

  it('auto-closes unbalanced fences while streaming', () => {
    const input = '```ts\nconst x = 1;';
    const output = normalizeStreamingMarkdown(input, true);

    expect(output).toContain('```ts');
    expect(output.endsWith('\n```')).toBe(true);
  });

  it('does not treat inline backticks as fence boundaries', () => {
    const input = '```md\nA literal ``` inside the fenced text\n';
    const output = normalizeStreamingMarkdown(input, true);
    expect(output.endsWith('\n```')).toBe(true);
  });

  it('does not treat fenced-open examples as closing fences', () => {
    const input = '```md\n````json\n';
    const output = normalizeStreamingMarkdown(input, true);
    expect(output).toBe(`${input}\`\`\``);
  });

  it('treats valid closing fences as closed when length is >= opener', () => {
    const input = '```md\ncode\n````\n';
    expect(normalizeStreamingMarkdown(input, true)).toBe(input);
  });

  it('closes with the same marker and length for tilde fences', () => {
    const input = '~~~~\nmermaid-ish\n';
    const output = normalizeStreamingMarkdown(input, true);
    expect(output).toBe(`${input}~~~~`);
  });

  it('ignores escaped fence markers', () => {
    const input = '\\```not-a-fence';
    expect(normalizeStreamingMarkdown(input, true)).toBe(input);
  });
});

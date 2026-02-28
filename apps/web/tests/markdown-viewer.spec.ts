import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { MarkdownViewer } from '../components/markdown-viewer';

describe('MarkdownViewer', () => {
  it('keeps default variant typography close to previous behavior', () => {
    const html = renderToStaticMarkup(
      createElement(MarkdownViewer, {
        markdown: '# Title\n\n- item',
      }),
    );

    expect(html).toContain('text-xl font-semibold');
    expect(html).toContain('text-sm leading-6 text-foreground');
  });

  it('applies chat variant styles when requested', () => {
    const html = renderToStaticMarkup(
      createElement(MarkdownViewer, {
        markdown: '# Title\n\nParagraph with [link](https://example.com)',
        variant: 'chat',
      }),
    );

    expect(html).toContain('text-2xl font-semibold');
    expect(html).toContain('break-all text-sky-700');
  });

  it('keeps mermaid as code block during streaming', () => {
    const html = renderToStaticMarkup(
      createElement(MarkdownViewer, {
        markdown: '```mermaid\ngraph TD;\nA-->B;',
        enableMermaid: true,
        isStreaming: true,
        variant: 'chat',
      }),
    );

    expect(html).toContain('graph TD;');
    expect(html).not.toContain('Rendering mermaid chart...');
  });

  it('routes mermaid blocks to mermaid renderer when not streaming', () => {
    const html = renderToStaticMarkup(
      createElement(MarkdownViewer, {
        markdown: '```mermaid\ngraph TD;\nA-->B;\n```',
        enableMermaid: true,
        variant: 'chat',
      }),
    );

    expect(html).toContain('Rendering mermaid chart...');
    expect(html).toContain('rounded-xl border border-slate-200');
    expect(html).toContain('bg-white/95 p-3');
    expect(html).not.toContain('bg-slate-950');
  });
});

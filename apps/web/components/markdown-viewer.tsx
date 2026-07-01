'use client';

import React, { isValidElement, memo, type ReactNode, useMemo } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

import { normalizeStreamingMarkdown } from '@/lib/markdown-streaming';
import { safeHttpUrl } from '@/lib/url';

import { MarkdownMermaid } from './markdown-mermaid';

export type MarkdownViewerVariant = 'default' | 'chat';

export interface MarkdownViewerProps {
  markdown: string;
  className?: string;
  enableMermaid?: boolean;
  isStreaming?: boolean;
  variant?: MarkdownViewerVariant;
}

interface MarkdownVariantClasses {
  container: string;
  h1: string;
  h2: string;
  h3: string;
  h4: string;
  paragraph: string;
  ul: string;
  ol: string;
  li: string;
  blockquote: string;
  link: string;
  mermaidWrapper: string;
  pre: string;
  blockCode: string;
  inlineCode: string;
  tableWrap: string;
  table: string;
  th: string;
  td: string;
  hr: string;
}

const DEFAULT_CLASSES: MarkdownVariantClasses = {
  container: 'min-w-0 max-w-full',
  h1: 'mt-4 mb-2 text-xl font-semibold',
  h2: 'mt-4 mb-2 text-lg font-semibold',
  h3: 'mt-3 mb-2 text-base font-semibold',
  h4: 'mt-3 mb-2 text-base font-semibold',
  paragraph: 'my-2 text-base leading-7 text-foreground',
  ul: 'my-2 list-disc space-y-1 pl-5 text-base leading-7 text-foreground',
  ol: 'my-2 list-decimal space-y-1 pl-5 text-base leading-7 text-foreground',
  li: 'text-base leading-7 text-foreground',
  blockquote: 'my-3 border-l-4 border-slate-300 pl-4 text-base italic text-slate-600',
  link: 'underline decoration-slate-300 underline-offset-2',
  mermaidWrapper: 'my-3 max-w-full overflow-auto rounded-lg border border-slate-200 bg-white p-3',
  pre: 'my-3 max-w-full overflow-auto rounded-lg bg-slate-950/5 p-4 text-xs leading-5 text-foreground',
  blockCode: 'font-mono text-[12px] text-foreground',
  inlineCode: 'rounded bg-slate-950/5 px-1 py-0.5 font-mono text-[12px] text-foreground',
  tableWrap: 'my-3 max-w-full overflow-auto rounded-lg border border-slate-200',
  table: 'w-full border-collapse text-sm',
  th: 'border-b bg-slate-50 px-3 py-2 text-left text-xs font-semibold',
  td: 'border-b px-3 py-2 text-sm',
  hr: 'my-4 border-slate-200',
};

const CHAT_CLASSES: MarkdownVariantClasses = {
  container: 'min-w-0 max-w-full text-[15px] leading-7 text-slate-800 dark:text-slate-200',
  h1: 'mb-3 mt-6 text-2xl font-semibold leading-tight text-slate-900 first:mt-0 dark:text-slate-100',
  h2: 'mb-3 mt-5 text-xl font-semibold leading-tight text-slate-900 first:mt-0 dark:text-slate-100',
  h3: 'mb-2 mt-4 text-lg font-semibold leading-tight text-slate-900 first:mt-0 dark:text-slate-100',
  h4: 'mb-2 mt-3 text-base font-semibold leading-tight text-slate-900 first:mt-0 dark:text-slate-100',
  paragraph: 'my-3 break-words text-[15px] leading-7 text-slate-800 dark:text-slate-200',
  ul: 'my-3 list-disc space-y-1.5 pl-6 text-[15px] leading-7 text-slate-800 marker:text-slate-500 dark:text-slate-200 dark:marker:text-slate-400',
  ol: 'my-3 list-decimal space-y-1.5 pl-6 text-[15px] leading-7 text-slate-800 marker:text-slate-500 dark:text-slate-200 dark:marker:text-slate-400',
  li: 'break-words text-[15px] leading-7 text-slate-800 dark:text-slate-200',
  blockquote:
    'my-4 border-l-4 border-slate-300/90 bg-slate-50/70 px-4 py-2 text-[15px] italic leading-7 text-slate-700 dark:border-slate-600 dark:bg-slate-900/70 dark:text-slate-300',
  link: 'break-all text-sky-700 underline decoration-sky-300 decoration-2 underline-offset-2 hover:text-sky-800 dark:text-sky-300 dark:decoration-sky-500/70 dark:hover:text-sky-200',
  mermaidWrapper:
    'my-4 max-w-full overflow-x-auto rounded-xl border border-slate-200 bg-white/95 p-3 shadow-[0_8px_18px_rgba(15,23,42,0.08)] dark:border-slate-700 dark:bg-slate-900/85 dark:shadow-[0_10px_20px_rgba(2,6,23,0.5)]',
  pre: 'my-4 max-w-full overflow-x-auto rounded-xl border border-slate-200 bg-[linear-gradient(180deg,#0b1324_0%,#0a1222_100%)] px-4 py-3 text-xs leading-6 text-slate-100 shadow-[inset_0_1px_0_rgba(148,163,184,0.18)] dark:border-slate-700 dark:bg-[linear-gradient(180deg,#020617_0%,#0b1324_100%)]',
  blockCode: 'font-mono text-[12px] leading-6 text-slate-100',
  inlineCode: 'rounded bg-slate-950/10 px-1.5 py-0.5 font-mono text-[12px] leading-5 text-slate-700 dark:bg-slate-200/10 dark:text-slate-200',
  tableWrap:
    'my-4 max-w-full overflow-x-auto rounded-xl border border-slate-200 bg-white/92 shadow-[0_8px_18px_rgba(15,23,42,0.06)] dark:border-slate-700 dark:bg-slate-900/76 dark:shadow-[0_10px_20px_rgba(2,6,23,0.45)]',
  table: 'w-full border-collapse text-sm leading-6',
  th: 'border-b border-slate-200 bg-slate-50 px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-slate-700 dark:border-slate-700 dark:bg-slate-900/60 dark:text-slate-200',
  td: 'border-b border-slate-100 px-3 py-2 align-top text-[14px] text-slate-800 dark:border-slate-800 dark:text-slate-200',
  hr: 'my-5 border-slate-200 dark:border-slate-700',
};

const MARKDOWN_REMARK_PLUGINS = [remarkGfm];

function resolveVariantClasses(variant: MarkdownViewerVariant): MarkdownVariantClasses {
  return variant === 'chat' ? CHAT_CLASSES : DEFAULT_CLASSES;
}

function extractText(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') {
    return String(node);
  }

  if (Array.isArray(node)) {
    return node.map((item) => extractText(item)).join('');
  }

  return '';
}

function resolveLanguage(className?: string): string | null {
  if (!className) {
    return null;
  }

  const match = className.match(/language-([^\s]+)/i);
  return match?.[1]?.toLowerCase() ?? null;
}

export const MarkdownViewer = memo(function MarkdownViewer({
  markdown,
  className,
  enableMermaid = false,
  isStreaming = false,
  variant = 'default',
}: MarkdownViewerProps) {
  const normalizedMarkdown = useMemo(
    () => normalizeStreamingMarkdown(markdown, isStreaming),
    [markdown, isStreaming],
  );
  const classes = resolveVariantClasses(variant);
  const markdownComponents = useMemo<Components>(
    () => ({
      h1: ({ children }) => <h1 className={classes.h1}>{children}</h1>,
      h2: ({ children }) => <h2 className={classes.h2}>{children}</h2>,
      h3: ({ children }) => <h3 className={classes.h3}>{children}</h3>,
      h4: ({ children }) => <h4 className={classes.h4}>{children}</h4>,
      p: ({ children }) => <p className={classes.paragraph}>{children}</p>,
      ul: ({ children }) => <ul className={classes.ul}>{children}</ul>,
      ol: ({ children }) => <ol className={classes.ol}>{children}</ol>,
      li: ({ children }) => <li className={classes.li}>{children}</li>,
      blockquote: ({ children }) => <blockquote className={classes.blockquote}>{children}</blockquote>,
      a: ({ href, children }) => {
        const safe = safeHttpUrl(href);
        if (!safe) {
          return <span className='text-inherit'>{children}</span>;
        }

        return (
          <a href={safe} target='_blank' rel='noreferrer' className={classes.link}>
            {children}
          </a>
        );
      },
      pre: ({ children }) => {
        const childNodes = Array.isArray(children) ? children : [children];
        const isMermaidBlock = childNodes.some((node) => {
          if (!isValidElement<{ className?: string }>(node)) {
            return false;
          }
          if (typeof node.props.className !== 'string') {
            return false;
          }
          return (
            node.props.className.includes('markdown-mermaid') ||
            node.props.className.includes('language-mermaid')
          );
        });

        if (isMermaidBlock) {
          return <div className={classes.mermaidWrapper}>{children}</div>;
        }

        return <pre className={classes.pre}>{children}</pre>;
      },
      code: ({ className: codeClassName, children }) => {
        const language = resolveLanguage(codeClassName);
        const isBlock = Boolean(language);

        if (isBlock && language === 'mermaid' && enableMermaid && !isStreaming) {
          return <MarkdownMermaid className='markdown-mermaid' chart={extractText(children)} />;
        }

        if (isBlock) {
          return <code className={classes.blockCode}>{children}</code>;
        }

        return <code className={classes.inlineCode}>{children}</code>;
      },
      table: ({ children }) => (
        <div className={classes.tableWrap}>
          <table className={classes.table}>{children}</table>
        </div>
      ),
      th: ({ children }) => <th className={classes.th}>{children}</th>,
      td: ({ children }) => <td className={classes.td}>{children}</td>,
      hr: () => <hr className={classes.hr} />,
    }),
    [classes, enableMermaid, isStreaming],
  );

  return (
    <div className={`${classes.container} ${className ?? ''}`}>
      <ReactMarkdown
        remarkPlugins={MARKDOWN_REMARK_PLUGINS}
        components={markdownComponents}
      >
        {normalizedMarkdown}
      </ReactMarkdown>
    </div>
  );
});

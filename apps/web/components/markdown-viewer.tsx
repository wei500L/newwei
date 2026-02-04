"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { safeHttpUrl } from "@/lib/url";

export interface MarkdownViewerProps {
  markdown: string;
  className?: string;
}

export function MarkdownViewer({ markdown, className }: MarkdownViewerProps) {
  return (
    <div className={className}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: ({ children }) => <h1 className="mt-4 mb-2 text-xl font-semibold">{children}</h1>,
          h2: ({ children }) => <h2 className="mt-4 mb-2 text-lg font-semibold">{children}</h2>,
          h3: ({ children }) => <h3 className="mt-3 mb-2 text-base font-semibold">{children}</h3>,
          h4: ({ children }) => <h4 className="mt-3 mb-2 text-sm font-semibold">{children}</h4>,
          p: ({ children }) => <p className="my-2 text-sm leading-6 text-foreground">{children}</p>,
          ul: ({ children }) => <ul className="my-2 list-disc space-y-1 pl-5 text-sm leading-6 text-foreground">{children}</ul>,
          ol: ({ children }) => <ol className="my-2 list-decimal space-y-1 pl-5 text-sm leading-6 text-foreground">{children}</ol>,
          li: ({ children }) => <li className="text-sm leading-6 text-foreground">{children}</li>,
          blockquote: ({ children }) => (
            <blockquote className="my-3 border-l-4 border-slate-300 pl-4 text-sm italic text-slate-600">
              {children}
            </blockquote>
          ),
          a: ({ href, children }) => {
            const safe = safeHttpUrl(href);
            if (!safe) {
              return <span className="text-foreground">{children}</span>;
            }
            return (
              <a href={safe} target="_blank" rel="noreferrer" className="underline decoration-slate-300 underline-offset-2">
                {children}
              </a>
            );
          },
          pre: ({ children }) => (
            <pre className="my-3 overflow-auto rounded-lg bg-slate-950/5 p-4 text-xs leading-5 text-foreground">
              {children}
            </pre>
          ),
          code: ({ className, children }) => {
            const isBlock = typeof className === "string" && className.includes("language-");
            return isBlock ? (
              <code className="font-mono text-[12px] text-foreground">{children}</code>
            ) : (
              <code className="rounded bg-slate-950/5 px-1 py-0.5 font-mono text-[12px] text-foreground">
                {children}
              </code>
            );
          },
          table: ({ children }) => (
            <div className="my-3 overflow-auto rounded-lg border border-slate-200">
              <table className="w-full border-collapse text-sm">{children}</table>
            </div>
          ),
          th: ({ children }) => <th className="border-b bg-slate-50 px-3 py-2 text-left text-xs font-semibold">{children}</th>,
          td: ({ children }) => <td className="border-b px-3 py-2 text-sm">{children}</td>,
        }}
      >
        {markdown}
      </ReactMarkdown>
    </div>
  );
}

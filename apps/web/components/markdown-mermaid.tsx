'use client';

import React, { useEffect, useId, useMemo, useRef, useState } from 'react';

interface MarkdownMermaidProps {
  chart: string;
  className?: string;
}

type MermaidApi = typeof import('mermaid').default;

let mermaidApi: MermaidApi | null = null;

async function getMermaidApi(): Promise<MermaidApi> {
  if (mermaidApi) {
    return mermaidApi;
  }

  const module = await import('mermaid');
  module.default.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    theme: 'neutral',
  });
  mermaidApi = module.default;
  return mermaidApi;
}

export function MarkdownMermaid({ chart, className }: MarkdownMermaidProps) {
  const [svgDataUrl, setSvgDataUrl] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const instanceId = useId().replace(/:/g, '');
  const renderCountRef = useRef(0);
  const trimmedChart = useMemo(() => chart.trim(), [chart]);

  useEffect(() => {
    let cancelled = false;

    if (!trimmedChart) {
      setSvgDataUrl('');
      setError('Empty mermaid chart.');
      return;
    }

    const render = async () => {
      try {
        const renderId = `markdown-mermaid-${instanceId}-${renderCountRef.current++}`;
        const api = await getMermaidApi();
        const rendered = await api.render(renderId, trimmedChart);
        if (!cancelled) {
          const encoded = encodeURIComponent(rendered.svg);
          setSvgDataUrl(`data:image/svg+xml;charset=utf-8,${encoded}`);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) {
          setSvgDataUrl('');
          setError(err instanceof Error ? err.message : 'Failed to render mermaid chart.');
        }
      }
    };

    void render();

    return () => {
      cancelled = true;
    };
  }, [instanceId, trimmedChart]);

  if (error) {
    return (
      <span className={`block rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700 ${className ?? ''}`}>
        Mermaid render error: {error}
      </span>
    );
  }

  if (!svgDataUrl) {
    return (
      <span className={`block rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-500 ${className ?? ''}`}>
        Rendering mermaid chart...
      </span>
    );
  }

  return (
    <span className={`markdown-mermaid block w-full overflow-x-auto ${className ?? ''}`}>
      <img src={svgDataUrl} alt='Mermaid diagram' className='block h-auto max-w-full' loading='lazy' />
    </span>
  );
}

import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const webRoot = path.resolve(__dirname, '..');

const read = (relativePath: string) =>
  fs.readFileSync(path.resolve(webRoot, relativePath), 'utf8');

describe('ops detail open affordances', () => {
  it('keeps crawl monitor request details behind an explicit helper and row affordance', () => {
    const source = read('app/(app)/admin/ops/crawl-monitor/crawl-monitor-content.tsx');

    expect(source).toContain('const openRequestDetails = useCallback(');
    expect(source).toContain('aria-label={t("crawl.monitor.details.openRequest"');
    expect(source).toContain('onRow={requestRowProps}');
  });

  it('guards crawl monitor websocket handshakes with an explicit timeout', () => {
    const source = read('app/(app)/admin/ops/crawl-monitor/crawl-monitor-content.tsx');

    expect(source).toContain('const WS_CONNECT_TIMEOUT_MS = 10_000;');
    expect(source).toContain('const wsConnectTimeoutId = useRef<number | null>(null);');
    expect(source).toContain('ws.readyState !== WebSocket.CONNECTING');
    expect(source).toContain('t("crawl.monitor.ws.timeout"');
  });

  it('keeps events archive detail opening wired through a reusable drawer helper', () => {
    const source = read('app/(app)/events-archive/events-archive-content.tsx');

    expect(source).toContain('const openArchiveDetail = useCallback(');
    expect(source).toContain('role="button"');
    expect(source).toContain('tabIndex={0}');
    expect(source).toContain('aria-haspopup="dialog"');
  });
});

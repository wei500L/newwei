import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const webRoot = path.resolve(__dirname, '..');

const read = (relativePath: string) =>
  fs.readFileSync(path.resolve(webRoot, relativePath), 'utf8');

describe('crawl task fetching wiring', () => {
  it('routes crawl task list ops refreshes through the shared helper', () => {
    const source = read('app/(app)/crawl/crawl-tasks.tsx');

    expect(source).toContain('getCrawlTasksOpsRefreshDecision');
    expect(source).not.toContain(
      'record.source !== "pipeline" && record.source !== "crawl"',
    );
  });

  it('keeps crawl task detail on a controlled Apollo hot path', () => {
    const source = read('app/(app)/crawl/[taskId]/task-detail.tsx');

    expect(source).toContain('fetchPolicy: "cache-and-network"');
    expect(source).toContain('nextFetchPolicy: "cache-first"');
    expect(source).not.toContain('fetchPolicy: "network-only"');
    expect(source).toContain('opsSocketBootstrappingRef');
  });

  it('removes automatic task-log refreshes while keeping manual refresh', () => {
    const source = read('app/(app)/crawl/[taskId]/task-detail.tsx');

    expect(source).not.toContain('void loadTaskLogs({ silent: true });');
    expect(source).toContain('onClick={() => void loadTaskLogs()}');
  });

  it('keeps task-log row expansion controlled across refetches', () => {
    const source = read('app/(app)/crawl/[taskId]/task-detail.tsx');

    expect(source).toContain(
      'const [expandedTaskLogKeys, setExpandedTaskLogKeys] = useState<string[]>([]);',
    );
    expect(source).toContain('expandedRowKeys: expandedTaskLogKeys');
    expect(source).toContain('expandRowByClick: true');
  });

  it('uses explicit router navigation for task detail links in list and table views', () => {
    const source = read('app/(app)/crawl/crawl-tasks.tsx');

    expect(source).toContain('const openTaskDetail = (taskId: string) => {');
    expect(source).toContain('router.push(`/admin/ops/crawl-tasks/${taskId}`);');
    expect(source).not.toContain('<Link href={`/admin/ops/crawl-tasks/${record.id}`}>');
  });

  it('defers ops socket connects until listeners are registered', () => {
    const listSource = read('app/(app)/crawl/crawl-tasks.tsx');
    const detailSource = read('app/(app)/crawl/[taskId]/task-detail.tsx');

    expect(listSource).toContain('autoConnect: false');
    expect(listSource).toContain('const connectTimer = window.setTimeout(() => {');
    expect(listSource).toContain('window.clearTimeout(connectTimer);');
    expect(detailSource).toContain('autoConnect: false');
    expect(detailSource).toContain('const connectTimer = window.setTimeout(() => {');
    expect(detailSource).toContain('window.clearTimeout(connectTimer);');
  });

  it('surfaces localized ops realtime errors instead of silently degrading', () => {
    const listSource = read('app/(app)/crawl/crawl-tasks.tsx');
    const detailSource = read('app/(app)/crawl/[taskId]/task-detail.tsx');

    for (const source of [listSource, detailSource]) {
      expect(source).toContain('const [opsLiveError, setOpsLiveError] = useState<string | null>(null);');
      expect(source).toContain('formatRealtimeSocketError');
      expect(source).toContain('keyPrefix: "crawl.liveUpdates.connectionError"');
      expect(source).toContain('socket.on("ops:error", handleServerError);');
      expect(source).toContain('t("crawl.liveUpdates.error"');
      expect(source).toContain('t("crawl.liveUpdates.alertTitle"');
    }
  });
});

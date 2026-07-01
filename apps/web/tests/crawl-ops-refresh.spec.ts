import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  getCrawlTaskDetailOpsRefreshDecision,
  getCrawlTasksOpsRefreshDecision,
} from '../lib/crawl-ops-refresh';

const webRoot = path.resolve(__dirname, '..');

describe('crawl ops refresh decisions', () => {
  it('refreshes the crawl task list and queue stats for crawl terminal events', () => {
    expect(
      getCrawlTasksOpsRefreshDecision({
        source: 'crawl',
        event: 'COMPLETED',
        jobId: 'task-1',
      }),
    ).toEqual({ tasks: true, queue: true });
  });

  it('ignores crawl progress events on the task list', () => {
    expect(
      getCrawlTasksOpsRefreshDecision({
        source: 'crawl',
        event: 'PROGRESS',
        jobId: 'task-1',
      }),
    ).toBeNull();
  });

  it('ignores pipeline events on the task list', () => {
    expect(
      getCrawlTasksOpsRefreshDecision({
        source: 'pipeline',
        event: 'FAILED',
        jobId: 'pipeline-1',
      }),
    ).toBeNull();
  });

  it('refreshes the crawl task detail for matching crawl task ids', () => {
    expect(
      getCrawlTaskDetailOpsRefreshDecision(
        {
          source: 'crawl',
          event: 'ACTIVE',
          taskId: 'task-1',
          jobId: 'task-1-run-2',
        },
        { taskId: 'task-1', pipelineJobId: 'pipeline-1' },
      ),
    ).toEqual({ task: true });
  });

  it('refreshes the crawl task detail for matching pipeline job ids', () => {
    expect(
      getCrawlTaskDetailOpsRefreshDecision(
        {
          source: 'pipeline',
          event: 'FAILED',
          jobId: 'job-1',
          pipelineJobId: 'pipeline-1',
        },
        { taskId: 'task-1', pipelineJobId: 'pipeline-1' },
      ),
    ).toEqual({ task: true });
  });

  it('ignores unrelated and progress events on the task detail', () => {
    expect(
      getCrawlTaskDetailOpsRefreshDecision(
        {
          source: 'crawl',
          event: 'PROGRESS',
          taskId: 'task-1',
          jobId: 'task-1-run-2',
        },
        { taskId: 'task-1', pipelineJobId: 'pipeline-1' },
      ),
    ).toBeNull();

    expect(
      getCrawlTaskDetailOpsRefreshDecision(
        {
          source: 'pipeline',
          event: 'COMPLETED',
          jobId: 'job-1',
          pipelineJobId: 'pipeline-2',
        },
        { taskId: 'task-1', pipelineJobId: 'pipeline-1' },
      ),
    ).toBeNull();
  });

  it('shows sampled adaptive queue metrics in the crawl ops UI', () => {
    const source = fs.readFileSync(
      path.resolve(webRoot, 'app/(app)/crawl/crawl-tasks.tsx'),
      'utf8',
    );

    expect(source).toContain('t("crawl.ops.adaptiveMetrics")');
    expect(source).toContain('latencySampleCount');
    expect(source).toContain('samplingMode');
  });
});

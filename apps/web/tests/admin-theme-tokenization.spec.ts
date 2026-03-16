import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const webRoot = path.resolve(__dirname, '..');

const read = (relativePath: string) =>
  fs.readFileSync(path.resolve(webRoot, relativePath), 'utf8');

describe('admin theme tokenization regressions', () => {
  it('drives admin console surfaces through semantic css variables', () => {
    const source = read('app/(app)/admin/admin-content.module.css');

    expect(source).toContain('--admin-metric-border');
    expect(source).toContain('--admin-link-border');
    expect(source).toContain('--admin-collapse-border');
    expect(source).toContain(':global(.dark) .adminShell');
    expect(source).toContain('border: 1px solid var(--admin-link-border);');
    expect(source).toContain('box-shadow: var(--admin-link-shadow-hover);');
  });

  it('keeps settings panels on theme tokens instead of hardcoded helper colors', () => {
    const archiveSource = read('components/settings/archive-preparation-settings-panel.tsx');
    const assistantSafetySource = read('components/settings/assistant-safety-settings-panel.tsx');
    const llmGatewaySource = read('components/settings/llm-gateway-settings-panel.tsx');

    expect(archiveSource).not.toContain('border-slate');
    expect(archiveSource).toContain('border-[var(--border)]');

    expect(assistantSafetySource).toContain('token.colorError');
    expect(assistantSafetySource).not.toContain('#cf1322');

    expect(llmGatewaySource).toContain('helpIconStyle');
    expect(llmGatewaySource).toContain('token.colorTextSecondary');
    expect(llmGatewaySource).not.toContain('color: "#999"');
  });

  it('uses antd theme tokens for remaining admin inline status colors', () => {
    const qualitySource = read('app/(app)/admin/quality/quality-content.tsx');
    const logsSource = read('app/(app)/admin/logs/admin-logs-content.tsx');
    const crawlMonitorSource = read('app/(app)/admin/ops/crawl-monitor/crawl-monitor-content.tsx');

    expect(qualitySource).toContain('token.colorPrimary');
    expect(qualitySource).toContain('token.colorError');
    expect(qualitySource).not.toContain('#1677ff');
    expect(qualitySource).not.toContain('#cf1322');

    expect(logsSource).toContain('token.colorError');
    expect(logsSource).not.toContain('#cf1322');

    expect(crawlMonitorSource).toContain('chartTheme.colors.foreground');
    expect(crawlMonitorSource).toContain('chartTheme.colors.tooltipBg');
    expect(crawlMonitorSource).toContain('chartTheme.colors.tooltipText');
    expect(crawlMonitorSource).toContain('chartTheme.colors.border');
    expect(crawlMonitorSource).not.toContain('#94a3b8');
    expect(crawlMonitorSource).not.toContain('#0b1220');
    expect(crawlMonitorSource).not.toContain('#e2e8f0');
    expect(crawlMonitorSource).not.toContain('#f0f0f0');
  });
});

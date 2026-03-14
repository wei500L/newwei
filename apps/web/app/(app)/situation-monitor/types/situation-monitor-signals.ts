import type { SituationMonitorMatchResult } from './situation-monitor-monitors';

export interface TelegramSignalItem {
  id: string;
  source: "telegram";
  channel: string;
  channelTitle: string;
  url: string;
  ts: string;
  text: string;
  topic: string;
  tags: string[];
  earlySignal: boolean;
}

export interface SituationTelegramFeedResponse {
  source: "telegram";
  scope: "global";
  earlySignal: true;
  configured: boolean;
  enabled: boolean;
  channelSet: string;
  count: number;
  updatedAt: string | null;
  items: TelegramSignalItem[];
  monitorMatches?: SituationMonitorMatchResult[];
  error?: string;
}

export interface OrefAlert {
  id: string;
  cat: string;
  title: string;
  data: string[];
  desc: string;
  alertDate: string;
}

export interface OrefHistoryEntry {
  alerts: OrefAlert[];
  timestamp: string;
}

export interface SituationOrefAlertsResponse {
  scope: "global";
  configured: boolean;
  alerts: OrefAlert[];
  historyCount24h: number;
  totalHistoryCount: number;
  timestamp: string;
  monitorMatches?: SituationMonitorMatchResult[];
  error?: string;
}

export interface SituationOrefHistoryResponse {
  scope: "global";
  configured: boolean;
  history: OrefHistoryEntry[];
  historyCount24h: number;
  totalHistoryCount: number;
  timestamp: string;
  monitorMatches?: SituationMonitorMatchResult[];
  error?: string;
}

export interface SituationTelegramRealtimePayload {
  count: number;
  updatedAt: string;
  items: TelegramSignalItem[];
}

export interface SituationOrefRealtimePayload {
  alerts: OrefAlert[];
  historyCount24h: number;
  totalHistoryCount: number;
  updatedAt: string;
}

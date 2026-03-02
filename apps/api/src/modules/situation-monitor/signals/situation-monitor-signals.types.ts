export interface TelegramChannelConfig {
  handle: string;
  label?: string;
  topic?: string;
  tier?: number;
  enabled?: boolean;
  region?: string;
  maxMessages?: number;
}

export interface TelegramSignalItem {
  id: string;
  source: 'telegram';
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
  source: 'telegram';
  earlySignal: true;
  configured: boolean;
  enabled: boolean;
  count: number;
  updatedAt: string | null;
  items: TelegramSignalItem[];
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
  configured: boolean;
  alerts: OrefAlert[];
  historyCount24h: number;
  totalHistoryCount: number;
  timestamp: string;
  error?: string;
}

export interface SituationOrefHistoryResponse {
  configured: boolean;
  history: OrefHistoryEntry[];
  historyCount24h: number;
  totalHistoryCount: number;
  timestamp: string;
  error?: string;
}

export type SituationMonitorRealtimeEventType =
  | 'situation:telegram.update'
  | 'situation:oref.update';

export interface SituationMonitorRealtimeEvent<T = unknown> {
  type: SituationMonitorRealtimeEventType;
  timestamp: string;
  payload: T;
}

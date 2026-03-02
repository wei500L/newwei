export const SITUATION_MONITOR_SIGNALS_QUEUE_NAME = 'situationMonitorSignals';
export const SITUATION_MONITOR_SIGNALS_QUEUE = Symbol('SITUATION_MONITOR_SIGNALS_QUEUE');
export const SITUATION_MONITOR_SIGNALS_QUEUE_EVENTS = Symbol('SITUATION_MONITOR_SIGNALS_QUEUE_EVENTS');

export const SITUATION_MONITOR_TELEGRAM_STATE_CACHE_KEY =
  'situation-monitor:signals:telegram:state:v1';
export const SITUATION_MONITOR_OREF_ALERTS_CACHE_KEY =
  'situation-monitor:signals:oref:alerts:v1';
export const SITUATION_MONITOR_OREF_HISTORY_CACHE_KEY =
  'situation-monitor:signals:oref:history:v1';

export const TELEGRAM_POLL_JOB_NAME = 'telegram-poll';
export const OREF_POLL_JOB_NAME = 'oref-poll';

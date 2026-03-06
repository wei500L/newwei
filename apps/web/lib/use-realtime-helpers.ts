import { useCallback, useEffect, useRef } from "react";

type TimerHandle = ReturnType<typeof setTimeout>;

export function useTimedValueDeduper(windowMs: number, maxEntries = 100) {
  const entriesRef = useRef<Array<{ value: string; timestamp: number }>>([]);

  return useCallback(
    (value: string, now = Date.now()) => {
      const cutoff = now - windowMs;
      const recentEntries = entriesRef.current.filter((entry) => entry.timestamp >= cutoff);
      const isDuplicate = recentEntries.some((entry) => entry.value === value);
      if (isDuplicate) {
        entriesRef.current = recentEntries;
        return false;
      }
      recentEntries.push({ value, timestamp: now });
      if (recentEntries.length > maxEntries) {
        recentEntries.splice(0, recentEntries.length - maxEntries);
      }
      entriesRef.current = recentEntries;
      return true;
    },
    [maxEntries, windowMs],
  );
}

export function useScheduledAction(action: () => void, delayMs: number) {
  const actionRef = useRef(action);
  const timerRef = useRef<TimerHandle | null>(null);

  useEffect(() => {
    actionRef.current = action;
  }, [action]);

  const cancel = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const flush = useCallback(() => {
    cancel();
    actionRef.current();
  }, [cancel]);

  const schedule = useCallback(() => {
    if (timerRef.current) {
      return;
    }
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      actionRef.current();
    }, delayMs);
  }, [delayMs]);

  useEffect(() => cancel, [cancel]);

  return { schedule, flush, cancel };
}

interface UseBufferedBatchOptions<T> {
  delayMs: number;
  onFlush: (items: T[]) => void;
  dedupeKey?: (item: T) => string | null | undefined;
  maxSeenKeys?: number;
}

export function useBufferedBatch<T>({
  delayMs,
  onFlush,
  dedupeKey,
  maxSeenKeys = 200,
}: UseBufferedBatchOptions<T>) {
  const onFlushRef = useRef(onFlush);
  const pendingRef = useRef<T[]>([]);
  const timerRef = useRef<TimerHandle | null>(null);
  const seenKeysRef = useRef<string[]>([]);

  useEffect(() => {
    onFlushRef.current = onFlush;
  }, [onFlush]);

  const clear = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    pendingRef.current = [];
  }, []);

  const flush = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const items = pendingRef.current.splice(0);
    if (items.length === 0) {
      return;
    }
    onFlushRef.current(items);
  }, []);

  const resetSeen = useCallback(() => {
    seenKeysRef.current = [];
  }, []);

  const add = useCallback(
    (item: T) => {
      if (dedupeKey) {
        const key = dedupeKey(item);
        if (key) {
          if (seenKeysRef.current.includes(key)) {
            return false;
          }
          seenKeysRef.current.push(key);
          if (seenKeysRef.current.length > maxSeenKeys) {
            seenKeysRef.current.splice(0, seenKeysRef.current.length - maxSeenKeys);
          }
        }
      }

      pendingRef.current.push(item);
      if (!timerRef.current) {
        timerRef.current = setTimeout(() => {
          timerRef.current = null;
          const items = pendingRef.current.splice(0);
          if (items.length > 0) {
            onFlushRef.current(items);
          }
        }, delayMs);
      }
      return true;
    },
    [dedupeKey, delayMs, maxSeenKeys],
  );

  useEffect(() => {
    return () => {
      clear();
      resetSeen();
    };
  }, [clear, resetSeen]);

  return { add, flush, clear, resetSeen };
}

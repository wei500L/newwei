"use client";

import { useEffect, useState } from "react";

export function useSharedNowTick(intervalMs = 60_000): number {
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    if (
      !Number.isFinite(intervalMs) ||
      intervalMs <= 0 ||
      typeof window === "undefined"
    ) {
      return;
    }

    const timer = window.setInterval(() => {
      setNowMs(Date.now());
    }, intervalMs);

    return () => {
      window.clearInterval(timer);
    };
  }, [intervalMs]);

  return nowMs;
}

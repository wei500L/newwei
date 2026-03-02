"use client";

import { useEffect, useMemo, useState, type RefObject } from "react";

const DEFAULT_IDLE_MS = 5 * 60 * 1000;

export interface MediaActivationState {
  active: boolean;
  visible: boolean;
  idle: boolean;
  hidden: boolean;
}

export function useMediaActivation(
  elementRef: RefObject<HTMLElement | null>,
  idleMs = DEFAULT_IDLE_MS,
): MediaActivationState {
  const [visible, setVisible] = useState(true);
  const [idle, setIdle] = useState(false);
  const [hidden, setHidden] = useState(
    typeof document !== "undefined" ? document.hidden : false,
  );

  useEffect(() => {
    const element = elementRef.current;
    if (!element || typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        setVisible(entries.some((entry) => entry.isIntersecting));
      },
      { threshold: 0.1 },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [elementRef]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    let timer: ReturnType<typeof setTimeout> | null = null;
    const activityEvents: (keyof WindowEventMap)[] = [
      "mousedown",
      "keydown",
      "scroll",
      "touchstart",
      "mousemove",
    ];

    const resetIdleTimer = () => {
      setIdle(false);
      if (timer) {
        clearTimeout(timer);
      }
      timer = setTimeout(() => {
        setIdle(true);
      }, idleMs);
    };

    const onVisibilityChange = () => {
      const isHidden = document.hidden;
      setHidden(isHidden);
      if (isHidden) {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        setIdle(true);
      } else {
        resetIdleTimer();
      }
    };

    document.addEventListener("visibilitychange", onVisibilityChange);
    for (const eventName of activityEvents) {
      window.addEventListener(eventName, resetIdleTimer, { passive: true });
    }

    resetIdleTimer();

    return () => {
      if (timer) {
        clearTimeout(timer);
      }
      document.removeEventListener("visibilitychange", onVisibilityChange);
      for (const eventName of activityEvents) {
        window.removeEventListener(eventName, resetIdleTimer);
      }
    };
  }, [idleMs]);

  return useMemo(
    () => ({
      active: visible && !idle && !hidden,
      visible,
      idle,
      hidden,
    }),
    [hidden, idle, visible],
  );
}

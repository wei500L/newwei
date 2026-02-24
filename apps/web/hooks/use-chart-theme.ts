"use client";

import { useEffect, useState } from "react";
import { theme } from "antd";
import { useTheme } from "@/hooks/use-theme";

export interface ChartTheme {
  echartsTheme: string;
  colors: {
    primary: string;
    bullish: string;
    bearish: string;
    destructive: string;
    accent: string;
    background: string;
    foreground: string;
    border: string;
    grid: string;
    tooltipBg: string;
    tooltipText: string;
    secondary: string;
  };
  fontFamily: string;
}

const DEFAULT_THEME: ChartTheme = {
  echartsTheme: "smart-light",
  colors: {
    primary: "#1f3b7b",
    bullish: "#1b9e77",
    bearish: "#d95f02",
    destructive: "#dc2626",
    accent: "#d97706",
    background: "transparent",
    foreground: "#475569",
    border: "#e2e8f0",
    grid: "rgba(15, 23, 42, 0.08)",
    tooltipBg: "#0f172a",
    tooltipText: "#f8fafc",
    secondary: "#e2e8f0"
  },
  fontFamily: "var(--font-mono), monospace",
};

export function useChartTheme(): ChartTheme {
  const { token } = theme.useToken();
  const { isDark } = useTheme();
  const [chartTheme, setChartTheme] = useState<ChartTheme>(DEFAULT_THEME);

  useEffect(() => {
    // Helper to get CSS variable value
    const getVar = (name: string, fallback: string) => {
      if (typeof window === 'undefined') return fallback;
      const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
      return value || fallback;
    };

    setChartTheme({
      echartsTheme: isDark ? "smart-dark" : "smart-light",
      colors: {
        primary: getVar("--primary", isDark ? "#6f9bff" : "#1f3b7b"),
        bullish: getVar("--bullish", isDark ? "#34d399" : "#1b9e77"),
        bearish: getVar("--bearish", isDark ? "#fb923c" : "#d95f02"),
        destructive: getVar("--destructive", isDark ? "#f87171" : "#dc2626"),
        accent: getVar("--accent", isDark ? "#f59e0b" : "#d97706"),
        background: "transparent",
        foreground: getVar("--foreground", isDark ? "#cbd5e1" : "#475569"),
        border: getVar("--border", isDark ? "#334155" : "#e2e8f0"),
        grid: isDark ? "rgba(148, 163, 184, 0.22)" : "rgba(15, 23, 42, 0.08)",
        tooltipBg: isDark ? "rgba(2, 6, 23, 0.92)" : "#0f172a",
        tooltipText: isDark ? "#e2e8f0" : "#f8fafc",
        secondary: getVar("--secondary", isDark ? "#1e293b" : "#e2e8f0")
      },
      fontFamily: "var(--font-mono), monospace",
    });
  }, [isDark, token]);

  return chartTheme;
}

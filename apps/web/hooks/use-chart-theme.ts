"use client";

import { theme } from "antd";
import { useEffect, useState } from "react";

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
    destructive: "#b91c1c",
    accent: "#b45309",
    background: "transparent",
    foreground: "#5a6270",
    border: "#e3dfd6",
    grid: "rgba(22, 27, 38, 0.08)",
    tooltipBg: "#161b26",
    tooltipText: "#faf8f3",
    secondary: "#f0ede6"
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
        grid: isDark ? "rgba(232, 228, 218, 0.14)" : "rgba(22, 27, 38, 0.08)",
        tooltipBg: isDark ? "rgba(13, 17, 23, 0.94)" : "#161b26",
        tooltipText: isDark ? "#e8e4da" : "#faf8f3",
        secondary: getVar("--secondary", isDark ? "#1e293b" : "#e2e8f0")
      },
      fontFamily: "var(--font-mono), monospace",
    });
  }, [isDark, token]);

  return chartTheme;
}

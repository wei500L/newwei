"use client";

import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type PropsWithChildren,
} from "react";

export type ThemeMode = "light" | "dark";

const THEME_STORAGE_KEY = "theme";

const isThemeMode = (value: string | null): value is ThemeMode =>
  value === "light" || value === "dark";

const getStoredTheme = (): ThemeMode | null => {
  if (typeof window === "undefined") return null;

  try {
    const storedTheme = window.localStorage.getItem(THEME_STORAGE_KEY);
    return isThemeMode(storedTheme) ? storedTheme : null;
  } catch {
    return null;
  }
};

const getSystemTheme = (): ThemeMode => {
  if (typeof window === "undefined") return "light";
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
};

const getThemeFromDocument = (): ThemeMode | null => {
  if (typeof document === "undefined") return null;

  const root = document.documentElement;
  if (root.classList.contains("dark")) return "dark";
  if (root.style.colorScheme === "dark") return "dark";
  if (root.style.colorScheme === "light") return "light";

  return null;
};

const resolveTheme = (): ThemeMode =>
  getThemeFromDocument() ?? getStoredTheme() ?? getSystemTheme();

const applyThemeToDocument = (nextTheme: ThemeMode) => {
  if (typeof document === "undefined") return;

  const root = document.documentElement;
  root.classList.toggle("dark", nextTheme === "dark");
  root.style.colorScheme = nextTheme;
};

const persistTheme = (nextTheme: ThemeMode) => {
  if (typeof window === "undefined") return;

  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, nextTheme);
  } catch {
    // Ignore localStorage write failures (private mode, quota limits, etc).
  }
};

interface ThemeContextValue {
  theme: ThemeMode;
  isDark: boolean;
  setTheme: (nextTheme: ThemeMode) => void;
  toggleTheme: () => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: PropsWithChildren) {
  const [theme, setThemeState] = useState<ThemeMode>("light");

  const setTheme = useCallback((nextTheme: ThemeMode) => {
    persistTheme(nextTheme);
    applyThemeToDocument(nextTheme);
    setThemeState(nextTheme);
  }, []);

  const toggleTheme = useCallback(() => {
    setThemeState((currentTheme) => {
      const nextTheme: ThemeMode = currentTheme === "dark" ? "light" : "dark";
      persistTheme(nextTheme);
      applyThemeToDocument(nextTheme);
      return nextTheme;
    });
  }, []);

  useEffect(() => {
    const initialTheme = resolveTheme();
    setThemeState((currentTheme) =>
      currentTheme === initialTheme ? currentTheme : initialTheme
    );
    applyThemeToDocument(initialTheme);

    if (typeof window === "undefined") return undefined;

    const handleStorage = (event: StorageEvent) => {
      if (event.key !== THEME_STORAGE_KEY) return;

      const nextTheme = isThemeMode(event.newValue)
        ? event.newValue
        : getSystemTheme();
      setThemeState(nextTheme);
      applyThemeToDocument(nextTheme);
    };

    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const handleSystemThemeChange = (event: MediaQueryListEvent) => {
      if (getStoredTheme()) return;

      const nextTheme: ThemeMode = event.matches ? "dark" : "light";
      setThemeState(nextTheme);
      applyThemeToDocument(nextTheme);
    };

    window.addEventListener("storage", handleStorage);
    mediaQuery.addEventListener("change", handleSystemThemeChange);

    return () => {
      window.removeEventListener("storage", handleStorage);
      mediaQuery.removeEventListener("change", handleSystemThemeChange);
    };
  }, []);

  const value = useMemo<ThemeContextValue>(
    () => ({
      theme,
      isDark: theme === "dark",
      setTheme,
      toggleTheme,
    }),
    [setTheme, theme, toggleTheme]
  );

  return createElement(ThemeContext.Provider, { value }, children);
}

export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error("useTheme must be used within ThemeProvider");
  }

  return context;
}

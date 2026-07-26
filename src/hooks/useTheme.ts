import { useCallback, useEffect, useState } from "react";

export type DeskTheme = "dark" | "light";

const KEY = "desk-theme";

function readTheme(): DeskTheme {
  try {
    const v = localStorage.getItem(KEY);
    if (v === "light" || v === "dark") return v;
  } catch {
    /* ignore */
  }
  return "dark";
}

export function applyTheme(theme: DeskTheme): void {
  document.documentElement.setAttribute("data-theme", theme);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", theme === "light" ? "#f2f4f6" : "#0a0f14");
}

/** Call once before React paint to avoid flash. */
export function initThemeFromStorage(): DeskTheme {
  const theme = readTheme();
  applyTheme(theme);
  return theme;
}

export function useTheme() {
  const [theme, setThemeState] = useState<DeskTheme>(() => readTheme());

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  const setTheme = useCallback((next: DeskTheme) => {
    setThemeState(next);
    try {
      localStorage.setItem(KEY, next);
    } catch {
      /* ignore */
    }
    applyTheme(next);
  }, []);

  const toggleLight = useCallback(() => {
    setTheme(theme === "light" ? "dark" : "light");
  }, [setTheme, theme]);

  return {
    theme,
    lightOn: theme === "light",
    setTheme,
    toggleLight,
  };
}

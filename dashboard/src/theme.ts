import { useEffect, useState } from "react";

export type Theme = "light" | "dark";
const KEY = "bootink-theme";

export function getStoredTheme(): Theme {
  try {
    const t = localStorage.getItem(KEY);
    if (t === "light" || t === "dark") return t;
  } catch {
    /* ignore */
  }
  // Default to light mode until the user picks one.
  return "light";
}

export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
}

// Apply immediately at module load so there's no light flash before React mounts.
applyTheme(getStoredTheme());

/** Hook: current theme + a toggle that persists and applies it app-wide. */
export function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(getStoredTheme);

  useEffect(() => {
    applyTheme(theme);
    try {
      localStorage.setItem(KEY, theme);
    } catch {
      /* ignore */
    }
  }, [theme]);

  return [theme, () => setTheme((t) => (t === "dark" ? "light" : "dark"))];
}

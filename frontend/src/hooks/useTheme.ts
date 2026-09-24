"use client";

// ─── Theme: class strategy, persisted, applied pre-paint by the boot script ──

import { useCallback, useEffect, useState } from "react";

export type Theme = "light" | "dark";

const STORAGE_KEY = "elcara-theme";

export function useTheme() {
  const [theme, setTheme] = useState<Theme>("light");

  useEffect(() => {
    const stored =
      typeof window !== "undefined"
        ? (localStorage.getItem(STORAGE_KEY) as Theme | null)
        : null;

    const applied =
      stored ??
      (document.documentElement.classList.contains("dark") ? "dark" : "light");

    setTheme(applied);
    document.documentElement.classList.toggle("dark", applied === "dark");
  }, []);

  const toggle = useCallback(() => {
    setTheme((current) => {
      const next: Theme = current === "dark" ? "light" : "dark";

      document.documentElement.classList.toggle("dark", next === "dark");

      try {
        localStorage.setItem(STORAGE_KEY, next);
      } catch {
        // storage unavailable — theme still applies for the session
      }

      return next;
    });
  }, []);

  return { theme, toggle };
}

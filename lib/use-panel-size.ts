"use client";

import { useCallback, useEffect, useState } from "react";

// A single panel's size (width or height, in px) — persisted to
// localStorage so a user's preferred layout survives a reload, clamped to
// [min, max] so a drag (or a stale localStorage value from a since-shrunk
// browser window) can never push a panel to something unusable.
export function usePanelSize(key: string, defaultPx: number, min: number, max: number) {
  const [size, setSize] = useState(defaultPx);

  useEffect(() => {
    try {
      const saved = localStorage.getItem(`monke_panel_${key}`);
      // eslint-disable-next-line react-hooks/set-state-in-effect -- restoring a persisted UI preference on mount, not deriving from props/state
      if (saved) setSize(Math.max(min, Math.min(max, Number(saved))));
    } catch {
      // localStorage unavailable (private browsing) — just keep the default.
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const resizeBy = useCallback(
    (deltaPx: number) => {
      setSize((prev) => {
        const next = Math.max(min, Math.min(max, prev + deltaPx));
        try {
          localStorage.setItem(`monke_panel_${key}`, String(next));
        } catch {
          // ignore
        }
        return next;
      });
    },
    [key, min, max]
  );

  return [size, resizeBy] as const;
}

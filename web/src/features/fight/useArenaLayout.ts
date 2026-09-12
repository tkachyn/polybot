/**
 * Arena layout toggle (handoff section 4: `layout` grid | lanes), persisted in
 * localStorage "sm.layout". Default: VITE_DEFAULT_LAYOUT, else "grid".
 */
import { useCallback, useState } from "react";
import { readStorage, writeStorage } from "../../state/storage";

export type ArenaLayout = "grid" | "lanes";

export const LAYOUT_STORAGE_KEY = "sm.layout";

export function parseLayout(value: unknown): ArenaLayout | null {
  return value === "grid" || value === "lanes" ? value : null;
}

/** Build-time default (`VITE_DEFAULT_LAYOUT`), else "grid". */
export function defaultLayout(): ArenaLayout {
  let configured: unknown;
  try {
    configured = import.meta.env.VITE_DEFAULT_LAYOUT;
  } catch {
    configured = undefined;
  }
  return parseLayout(configured) ?? "grid";
}

function readLayout(): ArenaLayout {
  try {
    return parseLayout(readStorage(LAYOUT_STORAGE_KEY)) ?? defaultLayout();
  } catch {
    return defaultLayout();
  }
}

export function useArenaLayout(): [ArenaLayout, (next: ArenaLayout) => void] {
  const [layout, setLayoutState] = useState<ArenaLayout>(readLayout);
  const setLayout = useCallback((next: ArenaLayout) => {
    setLayoutState(next);
    try {
      writeStorage(LAYOUT_STORAGE_KEY, next);
    } catch {
      // The in-memory choice still applies for this session.
    }
  }, []);
  return [layout, setLayout];
}

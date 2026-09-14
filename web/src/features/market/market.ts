/**
 * Market status copy and small hooks shared by the rail's panels.
 */
import { useEffect, useRef } from "react";
import type { FightDetail, MarketStatusDTO } from "@contract";

/** Why price buttons and the confirm CTA are disabled; null when trading is open. */
export function tradingBlockedReason(status: MarketStatusDTO): string | null {
  switch (status) {
    case "open":
      return null;
    case "frozen":
      return "Trading frozen";
    case "resolved":
    case "unresolved":
      return "Market settled";
  }
}

/** The tag beside the slip's price: only an open market's price is live. */
export function slipPriceLabel(status: MarketStatusDTO): "Live" | "Frozen" | "Closed" {
  if (status === "open") return "Live";
  return status === "frozen" ? "Frozen" : "Closed";
}

/** Footer status line. Upcoming fights trade pre-fight. */
export function marketStatusText(fight: Pick<FightDetail, "marketStatus" | "status">): { label: string; open: boolean } {
  switch (fight.marketStatus) {
    case "open":
      return { label: fight.status === "upcoming" ? "Pre-fight trading" : "Trading open", open: true };
    case "frozen":
      return { label: "Trading frozen", open: false };
    case "resolved":
      return { label: "Market settled", open: false };
    case "unresolved":
      return { label: "Market voided", open: false };
  }
}

/**
 * Calls `handler` on Escape anywhere in the document while `enabled`.
 * Handlers deeper in the tree (e.g. the chart clearing its crosshair) can
 * claim the key with `event.preventDefault()`.
 */
export function useEscape(handler: () => void, enabled = true): void {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    if (!enabled) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) ref.current();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [enabled]);
}

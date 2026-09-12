import type { FightDetail, PricePoint, Side } from "@contract";

/** The open bet slip: which outcome and side, at the price clicked. */
export type Slip = { racerId: string; side: Side; price: number };

export type MarketRailProps = {
  fight: FightDetail;
  priceHistory: PricePoint[];
  slip: Slip | null;
  onSlipChange: (slip: Slip | null) => void;
};

import type { FightDetail, OrderAction, PricePoint, Side } from "@contract";

/** The open bet slip: which outcome and side, at the price clicked. */
export type Slip = { racerId: string; side: Side; price: number };

export type ChartSabotageMarker = {
  racerId: string;
  at: number;
  label: string;
};

export type ChartTradeMarker = {
  id: string;
  racerId: string;
  at: number;
  price: number;
  action: OrderAction;
  side: Side;
  quantity: number;
};

export type MarketRailProps = {
  fight: FightDetail;
  priceHistory: PricePoint[];
  slip: Slip | null;
  onSlipChange: (slip: Slip | null) => void;
};

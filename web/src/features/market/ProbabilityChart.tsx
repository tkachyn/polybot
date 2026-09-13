/**
 * Win-probability chart: one line per agent (identity colour), y axis
 * 0–100¢, time x axis, dashed terracotta line at the sabotage moment, a
 * legend with current prices and a hover/keyboard crosshair. Inline SVG
 * sized by ResizeObserver. The window is always the whole fight.
 *
 * `collapsed` renders only a compact legend strip (monogram + price), for
 * when the order form needs the chart's space.
 */
import { useMemo, useRef, useState, useEffect, useId, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import type { AgentIdentity, PricePoint } from "@contract";
import { AgentMonogram, PriceCents } from "../../components";
import { agentStyle, agentVisual, rosterVisuals, type AgentVisual } from "../../lib/agents";
import { cx } from "../../lib/cx";
import { formatCents, formatCompactMoney, formatLogTime, formatTimeOfDay } from "../../lib/format";
import { useNow } from "../../state/clock";
import type { ChartSabotageMarker, ChartTradeMarker } from "./types";
import { Y_TICKS, buildChartWindow, isMarkerInWindow, linearScale, nearestIndex, seriesPath, timeTicks, tradeMarkerChartPrice, type ChartRange } from "./chart";
import styles from "./ProbabilityChart.module.css";

/** Structurally satisfied by FightAgentSummary / FightAgentDetail. */
export type ChartAgent = { racerId: string; agent: AgentIdentity; yes: number };

export type ProbabilityChartProps = {
  /** Racer order; `yes` is the live price shown in the legend and at the line ends. */
  agents: readonly ChartAgent[];
  /** Oldest first (useFightDetail().priceHistory). */
  priceHistory: readonly PricePoint[];
  /** sabotage.firedAt: draws the dashed terracotta marker. */
  sabotageAt?: number | null;
  sabotageLabel?: string;
  /** Per-racer hit times; unlike sabotageAt, these are not simultaneous. */
  sabotageMarkers?: readonly ChartSabotageMarker[];
  /** Current user's executed orders, plotted at their execution price/time. */
  tradeMarkers?: readonly ChartTradeMarker[];
  /** Freeze the right edge here (e.g. finishedAt of a settled fight). Null = live, ticking. */
  endAt?: number | null;
  /** Only the compact legend strip. */
  collapsed?: boolean;
  /** Window to plot. Defaults to the whole fight; there is no range picker. */
  range?: ChartRange;
  /**
   * The market's running volume. Every increase floats the amount that just
   * traded over the plot, so money moving into the market is visible at the
   * moment the agents shift it.
   */
  volume?: number;
  title?: ReactNode;
  className?: string;
};

const MARGIN = { top: 16, right: 34, bottom: 18, left: 6 } as const;
/** Minimum px between x tick labels. */
const TICK_SPACING_PX = 72;

function useElementSize(el: HTMLElement | null): { width: number; height: number } {
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    if (!el) return;
    const apply = (w: number, h: number) =>
      setSize((prev) => (prev.width === w && prev.height === h ? prev : { width: w, height: h }));
    const rect = el.getBoundingClientRect();
    apply(Math.floor(rect.width), Math.floor(rect.height));
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect;
      if (box) apply(Math.floor(box.width), Math.floor(box.height));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [el]);
  return size;
}

export function ProbabilityChart({
  agents,
  priceHistory,
  sabotageAt = null,
  sabotageLabel = "Sabotage",
  sabotageMarkers = [],
  tradeMarkers = [],
  endAt = null,
  collapsed = false,
  range = "all",
  volume,
  title = "Win probability",
  className,
}: ProbabilityChartProps) {

  const visuals = useMemo(() => {
    const roster = rosterVisuals(agents.map((a) => a.agent));
    return agents.map((a, i) => roster[i] ?? agentVisual(a.agent));
  }, [agents]);

  if (collapsed) {
    return (
      <section className={cx(styles.chart, styles.collapsed, className)} aria-label="Current prices">
        <ul className={styles.strip}>
          {agents.map((a, i) => (
            <li key={a.racerId} className={styles.stripItem} title={a.agent.name}>
              <AgentMonogram agent={visuals[i] ?? a.agent} size="xs" />
              <span className="sr-only">{a.agent.name}</span>
              <PriceCents value={a.yes} size="md" flash />
            </li>
          ))}
        </ul>
      </section>
    );
  }

  return (
    <section className={cx(styles.chart, styles.expanded, className)}>
      <div className={styles.head}>
        <h3 className={cx("label", styles.title)}>{title}</h3>
      </div>
      <ul className={styles.legend} aria-label="Legend">
        {agents.map((a, i) => (
          <li key={a.racerId} className={styles.legendItem} style={agentStyle(visuals[i] ?? a.agent)}>
            <span className={styles.key} aria-hidden="true" />
            <span className={styles.legendName} title={a.agent.name}>
              {a.agent.name}
            </span>
            <PriceCents value={a.yes} size="sm" flash className={styles.legendPrice} />
          </li>
        ))}
      </ul>
      <Plot
        agents={agents}
        visuals={visuals}
        priceHistory={priceHistory}
        range={range}
        endAt={endAt}
        sabotageAt={sabotageAt}
        sabotageLabel={sabotageLabel}
        sabotageMarkers={sabotageMarkers}
        tradeMarkers={tradeMarkers}
        volume={volume}
      />
    </section>
  );
}

type PlotProps = {
  agents: readonly ChartAgent[];
  visuals: readonly AgentVisual[];
  priceHistory: readonly PricePoint[];
  range: ChartRange;
  endAt: number | null;
  sabotageAt: number | null;
  sabotageLabel: string;
  sabotageMarkers: readonly ChartSabotageMarker[];
  tradeMarkers: readonly ChartTradeMarker[];
  volume?: number;
};

/** One amount floating over the plot, with the lane it rises in. */
type MoneyFlash = {
  id: number;
  amount: number;
  lane: number;
  /** The racer whose price moved most on this trade; null if none did. */
  racerId: string | null;
};

/** How long an amount stays on screen. Must match the CSS animation. */
const MONEY_FLASH_MS = 2600;
/** Vertical lanes, so amounts arriving together do not stack on one line. */
const MONEY_LANES = 5;
/** Where the lowest lane sits, clear of the x-axis labels. */
const MONEY_BASE_PX = 26;
/** Gap between lanes. */
const MONEY_LANE_PX = 16;

/**
 * Lane offsets in px, squeezed to fit short plots. The rail's chart is half
 * the height of the lobby's, and fixed offsets there would put the top lane
 * in the middle of the plot instead of at its foot.
 */
function moneyLaneOffset(lane: number, plotHeight: number): number {
  if (plotHeight <= 0) return MONEY_BASE_PX + lane * MONEY_LANE_PX;
  const base = Math.min(MONEY_BASE_PX, plotHeight * 0.12);
  const step = Math.min(MONEY_LANE_PX, Math.max(7, plotHeight * 0.055));
  return base + lane * step;
}

/**
 * Turns a running volume total into one flash per increase. Only the delta is
 * shown: that is the money that just traded, not the total already in.
 *
 * The flash is attributed to whichever racer's price moved most across the
 * same step, so the amount appears in the colour of the line it just moved.
 */
function useMoneyFlow(volume: number | undefined, prices: Record<string, number>): MoneyFlash[] {
  const [flashes, setFlashes] = useState<MoneyFlash[]>([]);
  const previous = useRef<number | undefined>(undefined);
  const nextId = useRef(0);
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
  // The latest prices, and the prices as of the last flash, so the mover is
  // measured over the same step as the volume delta.
  const latestPrices = useRef(prices);
  const pricesAtLastFlash = useRef(prices);
  const lastMover = useRef<string | null>(null);
  latestPrices.current = prices;

  // Clear every pending removal on unmount; a flash outliving the chart would
  // set state on a gone component.
  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending) clearTimeout(timer);
      pending.clear();
    };
  }, []);

  useEffect(() => {
    if (typeof volume !== "number" || !Number.isFinite(volume)) return;
    const before = previous.current;
    previous.current = volume;
    // The first reading is the volume already traded, not a new trade.
    if (typeof before !== "number" || volume <= before) return;

    const current = latestPrices.current;
    const since = pricesAtLastFlash.current;
    pricesAtLastFlash.current = current;
    let racerId: string | null = null;
    let biggest = 0;
    let leader: string | null = null;
    let best = -1;
    for (const [id, price] of Object.entries(current)) {
      const moved = Math.abs(price - (since[id] ?? price));
      if (moved > biggest) {
        biggest = moved;
        racerId = id;
      }
      if (price > best) {
        best = price;
        leader = id;
      }
    }
    // A trade too small to shift a rounded price still belongs to someone:
    // keep the last line that moved, else the one the market favours.
    if (!racerId) racerId = lastMover.current ?? leader;
    else lastMover.current = racerId;

    const id = nextId.current;
    nextId.current += 1;
    setFlashes((list) => [...list, { id, amount: volume - before, lane: id % MONEY_LANES, racerId }]);

    const timer = setTimeout(() => {
      timers.current.delete(timer);
      setFlashes((list) => list.filter((flash) => flash.id !== id));
    }, MONEY_FLASH_MS);
    timers.current.add(timer);
  }, [volume]);

  return flashes;
}

/** The SVG body. Split out so the per-second tick re-renders only this. */
function Plot({
  agents,
  visuals,
  priceHistory,
  range,
  endAt,
  sabotageAt,
  sabotageLabel,
  sabotageMarkers,
  tradeMarkers,
  volume,
}: PlotProps) {
  const frozen = endAt !== null;
  const now = useNow(1000, !frozen);
  const end = frozen ? endAt : now;
  const [box, setBox] = useState<HTMLDivElement | null>(null);
  const { width, height } = useElementSize(box);
  const [hoverX, setHoverX] = useState<number | null>(null);
  const descId = useId();

  const current = useMemo(() => Object.fromEntries(agents.map((a) => [a.racerId, a.yes])), [agents]);
  const moneyFlow = useMoneyFlow(volume, current);
  const win = useMemo(() => buildChartWindow({ history: priceHistory, range, end, current }), [priceHistory, range, end, current]);

  const innerW = Math.max(0, width - MARGIN.left - MARGIN.right);
  const innerH = Math.max(0, height - MARGIN.top - MARGIN.bottom);
  const left = MARGIN.left;
  const right = MARGIN.left + innerW;
  const top = MARGIN.top;
  const bottom = MARGIN.top + innerH;
  const x = linearScale(win.start, win.end, left, right);
  const y = linearScale(0, 1, bottom, top);
  const drawable = innerW > 0 && innerH > 0;

  // racerId → identity colour, so a flash matches its line.
  const moneyColors = useMemo(
    () => Object.fromEntries(agents.map((a, i) => [a.racerId, (visuals[i] ?? agentVisual(a.agent)).color])),
    [agents, visuals],
  );

  const series = drawable
    ? agents.map((a, i) => ({ agent: a, color: (visuals[i] ?? agentVisual(a.agent)).color, path: seriesPath(win.points, a.racerId, x, y) }))
    : [];
  const { step, ticks } = timeTicks(win.start, win.end, Math.max(2, Math.floor(innerW / TICK_SPACING_PX)));
  const tickLabel = step < 60_000 ? formatLogTime : formatTimeOfDay;

  const hoverIndex =
    hoverX === null || innerW === 0 ? -1 : nearestIndex(win.points, win.start + ((hoverX - left) / innerW) * (win.end - win.start));
  const hoverPoint = hoverIndex >= 0 ? win.points[hoverIndex] : undefined;
  const hoverPx = hoverPoint ? x(hoverPoint.t) : 0;
  const hoverIsNow = !frozen && hoverPoint !== undefined && hoverIndex === win.points.length - 1 && hoverPoint.t === win.end;

  const visibleSabotageMarkers = sabotageMarkers.filter((marker) =>
    isMarkerInWindow(marker.at, win.start, win.end),
  );
  const showSabotage = visibleSabotageMarkers.length === 0 &&
    sabotageAt !== null &&
    Number.isFinite(sabotageAt) &&
    sabotageAt >= win.start &&
    sabotageAt <= win.end;
  const sabotageX = showSabotage ? x(sabotageAt) : 0;
  const sabotageAnchorEnd = sabotageX > right - 64;
  const visibleTradeMarkers = tradeMarkers.filter((marker) =>
    isMarkerInWindow(marker.at, win.start, win.end) &&
    Number.isFinite(marker.price) &&
    marker.price >= 0 &&
    marker.price <= 1,
  );

  const onPointerMove = (event: PointerEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    setHoverX(event.clientX - rect.left);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const count = win.points.length;
    if (count === 0) return;
    const at = hoverIndex < 0 ? count - 1 : hoverIndex;
    let next: number | null = null;
    if (event.key === "ArrowLeft") next = hoverIndex < 0 ? count - 1 : Math.max(0, at - 1);
    else if (event.key === "ArrowRight") next = Math.min(count - 1, at + 1);
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = count - 1;
    else if (event.key === "Escape" && hoverX !== null) {
      event.preventDefault();
      setHoverX(null);
      return;
    }
    if (next === null) return;
    event.preventDefault();
    const point = win.points[next];
    if (point) setHoverX(x(point.t));
  };

  const summary = `Win probability over time. Now: ${agents.map((a) => `${a.agent.name} ${formatCents(a.yes)}`).join(", ")}.`;
  const tooltipRows = hoverPoint
    ? agents
        .map((a, i) => ({ a, visual: visuals[i] ?? agentVisual(a.agent), value: hoverPoint.prices[a.racerId] }))
        .filter((row): row is typeof row & { value: number } => typeof row.value === "number")
        .sort((p, q) => q.value - p.value)
    : [];

  return (
    <div
      ref={setBox}
      className={styles.plot}
      tabIndex={0}
      role="group"
      aria-label="Price chart. Use arrow keys to inspect prices over time."
      aria-describedby={descId}
      onKeyDown={onKeyDown}
      onBlur={() => setHoverX(null)}
    >
      <span id={descId} className="sr-only">
        {summary}
      </span>
      {drawable && (
        <svg
          className={styles.svg}
          width={width}
          height={height}
          viewBox={`0 0 ${width} ${height}`}
          aria-hidden="true"
          onPointerMove={onPointerMove}
          onPointerDown={onPointerMove}
          onPointerLeave={() => setHoverX(null)}
        >
          <g>
            {Y_TICKS.map((v) => (
              <g key={v}>
                <line className={styles.gridLine} x1={left} x2={right} y1={Math.round(y(v)) + 0.5} y2={Math.round(y(v)) + 0.5} />
                <text className={styles.axisText} x={right + 6} y={y(v)} dy="0.32em">
                  {formatCents(v)}
                </text>
              </g>
            ))}
            {ticks.map((t) => {
              const px = x(t);
              const anchor = px < left + 18 ? "start" : px > right - 18 ? "end" : "middle";
              return (
                <text key={t} className={styles.axisText} x={px} y={height - 4} textAnchor={anchor}>
                  {tickLabel(t)}
                </text>
              );
            })}
          </g>

          {showSabotage && (
            <g>
              <line className={styles.sabotageLine} x1={sabotageX} x2={sabotageX} y1={top - 2} y2={bottom} />
              <text
                className={styles.sabotageText}
                x={sabotageAnchorEnd ? sabotageX - 4 : sabotageX + 4}
                y={top - 5}
                textAnchor={sabotageAnchorEnd ? "end" : "start"}
              >
                {sabotageLabel.toUpperCase()}
              </text>
            </g>
          )}

          {visibleSabotageMarkers.map((marker, index) => {
            const markerX = x(marker.at);
            const agentIndex = agents.findIndex((agent) => agent.racerId === marker.racerId);
            const color = agentIndex >= 0 ? (visuals[agentIndex] ?? agentVisual(agents[agentIndex]!.agent)).color : undefined;
            const anchorEnd = markerX > right - 100;
            return (
              <g key={`${marker.racerId}-${marker.at}-${index}`}>
                <line
                  className={styles.sabotageLine}
                  x1={markerX}
                  x2={markerX}
                  y1={top - 2}
                  y2={bottom}
                  style={color ? { stroke: color } : undefined}
                />
                <text
                  className={styles.sabotageText}
                  x={anchorEnd ? markerX - 4 : markerX + 4}
                  y={top + 10 + (index % 3) * 12}
                  textAnchor={anchorEnd ? "end" : "start"}
                  style={color ? { fill: color } : undefined}
                >
                  {marker.label.toUpperCase()}
                </text>
              </g>
            );
          })}

          {visibleTradeMarkers.map((marker) => {
            const markerX = x(marker.at);
            const markerY = y(tradeMarkerChartPrice(marker.side, marker.price));
            const markerClass = marker.action === "buy" ? styles.tradeMarkerBuy : styles.tradeMarkerSell;
            return (
              <g
                key={marker.id}
                className={cx(styles.tradeMarker, markerClass)}
                transform={`translate(${markerX} ${markerY})`}
              >
                <circle className={styles.tradeMarkerCircle} r={8} />
                <text className={styles.tradeMarkerLetter} textAnchor="middle" dominantBaseline="central">
                  {marker.action === "buy" ? "B" : "S"}
                </text>
                <title>
                  {marker.action === "buy" ? "Bought" : "Sold"} {marker.quantity} {marker.side.toUpperCase()} shares
                </title>
              </g>
            );
          })}

          <g>
            {series.map(({ agent, color, path }) =>
              path.count > 1 ? <path key={agent.racerId} className={styles.line} d={path.d} stroke={color} /> : null,
            )}
          </g>
          <g>
            {series.map(({ agent, color, path }) =>
              path.last ? <circle key={agent.racerId} className={styles.dot} cx={path.last.x} cy={path.last.y} r={4} fill={color} /> : null,
            )}
          </g>

          {hoverPoint && (
            <g>
              <line className={styles.crosshair} x1={Math.round(hoverPx) + 0.5} x2={Math.round(hoverPx) + 0.5} y1={top} y2={bottom} />
              {tooltipRows.map(({ a, visual, value }) => (
                <circle key={a.racerId} className={styles.dot} cx={hoverPx} cy={y(value)} r={4} fill={visual.color} />
              ))}
            </g>
          )}
        </svg>
      )}

      {(visibleSabotageMarkers.length > 0 || visibleTradeMarkers.length > 0) && (
        <div className="sr-only" aria-label="Chart events">
          {visibleSabotageMarkers.map((marker, index) => (
            <span key={`sabotage-${marker.racerId}-${marker.at}-${index}`}>
              {marker.label} at {formatLogTime(marker.at)}.
            </span>
          ))}
          {visibleTradeMarkers.map((marker) => (
            <span key={`trade-${marker.id}`}>
              {marker.action === "buy" ? "Bought" : "Sold"} {marker.quantity} {marker.side.toUpperCase()} shares at {formatCents(marker.price)} at {formatLogTime(marker.at)}.
            </span>
          ))}
        </div>
      )}

      {moneyFlow.length > 0 && (
        <div className={styles.moneyFlow} aria-hidden="true">
          {moneyFlow.map((flash) => (
            <span
              key={flash.id}
              className={styles.money}
              style={{
                // Stacked just above the x axis, so every amount rises from
                // the foot of the plot rather than out of the middle of it.
                bottom: `${moneyLaneOffset(flash.lane, height)}px`,
                color: (flash.racerId && moneyColors[flash.racerId]) || undefined,
              }}
            >
              +{formatCompactMoney(flash.amount)}
            </span>
          ))}
        </div>
      )}

      {drawable && win.historyCount === 0 && <p className={styles.empty}>Price history appears once trading starts.</p>}

      {drawable && hoverPoint && tooltipRows.length > 0 && (
        <div
          className={styles.tooltip}
          style={hoverPx > width / 2 ? { right: width - hoverPx + 10 } : { left: hoverPx + 10 }}
          aria-live="polite"
        >
          <p className={cx("label", "label-sm", "num")}>{hoverIsNow ? "Now" : formatLogTime(hoverPoint.t)}</p>
          {tooltipRows.map(({ a, visual, value }) => (
            <p key={a.racerId} className={styles.tipRow} style={agentStyle(visual)}>
              <span className={styles.key} aria-hidden="true" />
              <span className={cx("num", styles.tipValue)}>{formatCents(value)}</span>
              <span className={styles.tipName}>{a.agent.name}</span>
            </p>
          ))}
        </div>
      )}
    </div>
  );
}

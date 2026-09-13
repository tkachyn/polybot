/**
 * The arena: layout toggle plus the quadrant grid, the stacked lanes, or one
 * expanded agent. Owns `focus` (handoff section 4); switching layout clears it.
 */
import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import type { FightAgentDetail, FightDetail } from "@contract";
import type { StreamStatus } from "../../api/stream";
import { AgentMonogram, ConnectionIndicator, IconGrid, IconLanes, SegmentedControl } from "../../components";
import { cx } from "../../lib/cx";
import type { Slip } from "../market/types";
import { AgentLane } from "./AgentLane";
import { AgentPane } from "./AgentPane";
import { gridRows, isEditableTarget, leaderView, sabotageMarkers, visualFor, type RosterVisuals } from "./fightView";
import { FocusView } from "./FocusView";
import { useArenaLayout, type ArenaLayout } from "./useArenaLayout";
import { ViewerConcealedContext, ViewerLayer, ViewerLayerContext } from "./viewerLayer";
import styles from "./Arena.module.css";

export type ArenaProps = {
  fight: FightDetail;
  roster: RosterVisuals;
  slip: Slip | null;
  streamStatus: StreamStatus;
  className?: string;
};

const LAYOUT_OPTIONS = [
  {
    value: "grid" as const,
    title: "Quadrant grid",
    label: (
      <span className={styles.toggleLabel}>
        <IconGrid size={12} /> Grid
      </span>
    ),
  },
  {
    value: "lanes" as const,
    title: "Stacked lanes",
    label: (
      <span className={styles.toggleLabel}>
        <IconLanes size={12} /> Lanes
      </span>
    ),
  },
];

export function Arena({ fight, roster, slip, streamStatus, className }: ArenaProps) {
  const [layout, setLayout] = useArenaLayout();
  const [focus, setFocus] = useState<string | null>(null);
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const restoreTo = useRef<string | null>(null);

  const focused = focus ? (fight.agents.find((a) => a.racerId === focus) ?? null) : null;
  const markers = sabotageMarkers(fight);
  const leader = leaderView(fight);
  const leaderAgent = leader.racerId === null ? undefined : fight.agents.find((a) => a.racerId === leader.racerId);

  const setButton = useCallback((racerId: string, el: HTMLButtonElement | null) => {
    if (el) buttons.current.set(racerId, el);
    else buttons.current.delete(racerId);
  }, []);

  const open = useCallback((racerId: string) => setFocus(racerId), []);

  const close = useCallback(() => {
    restoreTo.current = focus;
    setFocus(null);
  }, [focus]);

  const changeLayout = (next: ArenaLayout) => {
    restoreTo.current = null;
    setLayout(next);
    setFocus(null);
  };

  // Esc closes the expanded view (unless a text field is handling it).
  useEffect(() => {
    if (!focus) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || isEditableTarget(event.target)) return;
      event.preventDefault();
      close();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [focus, close]);

  // After closing, return keyboard focus to the pane or lane that opened it.
  useEffect(() => {
    if (focus !== null || restoreTo.current === null) return;
    buttons.current.get(restoreTo.current)?.focus({ preventScroll: true });
    restoreTo.current = null;
  }, [focus, layout]);

  const rowsStyle = { "--rows": gridRows(fight.agents.length) } as CSSProperties;
  const laneStyle = { "--rows": Math.max(1, fight.agents.length) } as CSSProperties;

  return (
    <section className={cx(styles.arena, className)} aria-label="Arena">
      <div className={styles.toolbar}>
        <span className="label">Arena</span>
        <span className={styles.leader} title={leader.title}>
          <span className="label label-sm">{fight.winnerRacerId !== null && leaderAgent ? "Winner" : "Leader"}</span>
          {leaderAgent && (
            <span className={styles.leaderName}>
              <AgentMonogram agent={visualFor(roster, leaderAgent)} size="xs" />
              <span className={styles.leaderText}>{leader.name}</span>
              {leader.tied > 0 && <span className={cx("num", styles.leaderTied)}>+{leader.tied}</span>}
            </span>
          )}
          <span className={cx("label label-sm num", styles.leaderFigure)}>
            {leader.checkpoint}/{leader.checkpointCount}
          </span>
        </span>
        {streamStatus !== "open" && <ConnectionIndicator status={streamStatus} />}
        <SegmentedControl<ArenaLayout>
          size="sm"
          aria-label="Arena layout"
          options={LAYOUT_OPTIONS}
          value={layout}
          onChange={changeLayout}
          className={styles.toggle}
        />
      </div>

      <div className={styles.stage}>
        <ArenaStage
          fight={fight}
          roster={roster}
          slip={slip}
          layout={layout}
          focused={focused}
          markers={markers}
          rowsStyle={rowsStyle}
          laneStyle={laneStyle}
          onOpen={open}
          onClose={close}
          buttonRef={setButton}
        />
      </div>
    </section>
  );
}

export type ArenaStageProps = {
  fight: FightDetail;
  roster: RosterVisuals;
  slip: Slip | null;
  layout: ArenaLayout;
  focused: FightAgentDetail | null;
  markers: ReturnType<typeof sabotageMarkers>;
  rowsStyle: CSSProperties;
  laneStyle: CSSProperties;
  onOpen: (racerId: string) => void;
  onClose: () => void;
  buttonRef: (racerId: string, el: HTMLButtonElement | null) => void;
};

/**
 * The base layout stays mounted while focus is open, hidden with CSS. Each
 * racer's live-view iframe lives in the stage's viewer layer and is only laid
 * over the grid pane or the focus view, so its Steel stream never reloads when
 * focus opens or closes.
 */
export function ArenaStage({
  fight,
  roster,
  slip,
  layout,
  focused,
  markers,
  rowsStyle,
  laneStyle,
  onOpen,
  onClose,
  buttonRef,
}: ArenaStageProps) {
  const layerRef = useRef<HTMLDivElement>(null);
  const [layer, setLayer] = useState<ViewerLayer | null>(null);
  useEffect(() => {
    const root = layerRef.current;
    if (!root) return;
    const created = new ViewerLayer(root);
    setLayer(created);
    return () => {
      created.destroy();
      setLayer(null);
    };
  }, []);

  return (
    <ViewerLayerContext.Provider value={layer}>
      <ViewerConcealedContext.Provider value={focused !== null}>
        <div
          className={cx(
            layout === "grid" ? styles.grid : styles.lanes,
            focused && styles.stageContentHidden,
          )}
          style={layout === "grid" ? rowsStyle : laneStyle}
          aria-hidden={focused ? true : undefined}
        >
          {layout === "grid"
            ? fight.agents.map((agent) => (
                <AgentPane
                  key={agent.racerId}
                  fight={fight}
                  agent={agent}
                  visual={visualFor(roster, agent)}
                  slip={slip}
                  markers={markers}
                  onOpen={onOpen}
                  buttonRef={buttonRef}
                />
              ))
            : fight.agents.map((agent) => (
                <AgentLane
                  key={agent.racerId}
                  fight={fight}
                  agent={agent}
                  visual={visualFor(roster, agent)}
                  slip={slip}
                  onOpen={onOpen}
                  buttonRef={buttonRef}
                />
              ))}
        </div>
      </ViewerConcealedContext.Provider>
      {focused && (
        <div className={styles.focusOverlay}>
          <FocusView
            fight={fight}
            agent={focused}
            visual={visualFor(roster, focused)}
            slip={slip}
            markers={markers}
            onClose={onClose}
          />
        </div>
      )}
      <div ref={layerRef} className={styles.viewerLayer} aria-hidden="true" />
    </ViewerLayerContext.Provider>
  );
}

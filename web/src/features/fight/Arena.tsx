/**
 * The arena: layout toggle plus the quadrant grid, the stacked lanes, or one
 * expanded agent. Owns `focus` (handoff section 4); switching layout clears it.
 */
import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import type { FightDetail } from "@contract";
import type { StreamStatus } from "../../api/stream";
import { ConnectionIndicator, IconGrid, IconLanes, SegmentedControl } from "../../components";
import { cx } from "../../lib/cx";
import type { Slip } from "../market/types";
import { AgentLane } from "./AgentLane";
import { AgentPane } from "./AgentPane";
import { gridRows, isEditableTarget, sabotageMarkers, visualFor, type RosterVisuals } from "./fightView";
import { FocusView } from "./FocusView";
import { useArenaLayout, type ArenaLayout } from "./useArenaLayout";
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
        <span className={cx("label label-sm num", styles.leader)}>
          Leader {fight.leaderCheckpoint}/{fight.checkpointCount}
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
        {focused ? (
          <FocusView fight={fight} agent={focused} visual={visualFor(roster, focused)} slip={slip} markers={markers} onClose={close} />
        ) : layout === "grid" ? (
          <div className={styles.grid} style={rowsStyle}>
            {fight.agents.map((agent) => (
              <AgentPane
                key={agent.racerId}
                fight={fight}
                agent={agent}
                visual={visualFor(roster, agent)}
                slip={slip}
                markers={markers}
                onOpen={open}
                buttonRef={setButton}
              />
            ))}
          </div>
        ) : (
          <div className={styles.lanes} style={laneStyle}>
            {fight.agents.map((agent) => (
              <AgentLane
                key={agent.racerId}
                fight={fight}
                agent={agent}
                visual={visualFor(roster, agent)}
                slip={slip}
                onOpen={open}
                buttonRef={setButton}
              />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

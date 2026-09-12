import { agentStyle, agentVisual, type AgentLike, type AgentVisual } from "../lib/agents";
import { cx } from "../lib/cx";
import styles from "./AgentMonogram.module.css";

export type AgentMonogramSize = "xs" | "sm" | "md" | "lg";

export type AgentMonogramProps = {
  /** An AgentIdentity (or `{ key, name }`), a bare key, or a precomputed visual from rosterVisuals(). */
  agent: AgentLike | AgentVisual | string;
  /** xs 18px, sm 22px, md 28px (default), lg 36px. */
  size?: AgentMonogramSize;
  className?: string;
};

/** The agent's logo tile: two-letter monogram, identity colour at 12% fill / 33% border. */
export function AgentMonogram({ agent, size = "md", className }: AgentMonogramProps) {
  const visual: AgentVisual = typeof agent === "object" && "fill" in agent ? agent : agentVisual(agent);
  const name = typeof agent === "object" && "name" in agent && typeof agent.name === "string" ? agent.name : undefined;
  return (
    <span className={cx(styles.tile, styles[size], className)} style={agentStyle(visual)} title={name} aria-hidden={name ? undefined : true}>
      {visual.monogram}
    </span>
  );
}

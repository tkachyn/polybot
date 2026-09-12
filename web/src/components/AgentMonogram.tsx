import { useId, useMemo } from "react";
import { agentVisual, type AgentLike, type AgentVisual } from "../lib/agents";
import { cx } from "../lib/cx";
import { BRAND_ID_PREFIX, brandLogo } from "./brand-logos";
import styles from "./AgentMonogram.module.css";

export type AgentMonogramSize = "xs" | "sm" | "md" | "lg";

export type AgentMonogramProps = {
  /** An AgentIdentity (or `{ key, name }`), a bare key, or a precomputed visual from rosterVisuals(). */
  agent: AgentLike | AgentVisual | string;
  /** xs 14px, sm 16px, md 20px (default), lg 26px. */
  size?: AgentMonogramSize;
  /** Draw the mark in the agent's identity colour instead of the vendor's own. */
  tinted?: boolean;
  className?: string;
};

/**
 * The agent's identity mark: the real vendor logo in the vendor's own colours,
 * on no background. Vendors without a vendored mark keep the two-letter
 * monogram as a fallback.
 */
export function AgentMonogram({ agent, size = "md", tinted = false, className }: AgentMonogramProps) {
  const visual: AgentVisual = typeof agent === "object" && "fill" in agent ? agent : agentVisual(agent);
  const name = typeof agent === "object" && "name" in agent && typeof agent.name === "string" ? agent.name : undefined;
  const logo = brandLogo(visual.key);

  // Gradient ids must be unique per rendered logo, or a second copy of the
  // same mark on the page points at the first one's defs.
  const rawId = useId();
  const instanceId = useMemo(() => rawId.replace(/[^a-zA-Z0-9_-]/g, ""), [rawId]);
  const markup = useMemo(
    () => (logo?.markup ? logo.markup.split(BRAND_ID_PREFIX).join(`${instanceId}-`) : null),
    [logo, instanceId],
  );

  if (!logo) {
    return (
      <span
        className={cx(styles.mark, styles.fallback, styles[size], className)}
        style={tinted ? { color: visual.color } : undefined}
        title={name}
        aria-hidden={name ? undefined : true}
      >
        {visual.monogram}
      </span>
    );
  }

  const shared = {
    className: cx(styles.mark, styles[size], className),
    viewBox: "0 0 24 24",
    role: name ? ("img" as const) : undefined,
    "aria-label": name,
    "aria-hidden": name ? undefined : true,
    focusable: "false" as const,
  };

  // Multi-colour artwork: inline it verbatim. The markup is a vendored
  // constant, never user input.
  if (markup && !tinted) {
    return <svg {...shared} dangerouslySetInnerHTML={{ __html: markup }} />;
  }

  return (
    <svg {...shared} fill="currentColor" style={{ color: tinted ? visual.color : logo.color }}>
      {name && <title>{name}</title>}
      <path d={logo.d} fillRule="evenodd" clipRule="evenodd" />
    </svg>
  );
}

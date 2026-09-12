/**
 * Empty, error and loading states.
 */
import type { CSSProperties, ReactNode } from "react";
import { describeError } from "../api/client";
import { cx } from "../lib/cx";
import { Button } from "./Button";
import { IconAlert, IconClose } from "./icons";
import styles from "./Feedback.module.css";

// ---------------------------------------------------------------------------
// EmptyState
// ---------------------------------------------------------------------------

export type EmptyStateProps = {
  title: ReactNode;
  description?: ReactNode;
  /** A Button / ButtonLink. */
  action?: ReactNode;
  icon?: ReactNode;
  /** sm: inline inside a panel; md (default): page section. */
  size?: "sm" | "md";
  className?: string;
};

export function EmptyState({ title, description, action, icon, size = "md", className }: EmptyStateProps) {
  return (
    <div className={cx(styles.empty, styles[`empty_${size}`], className)}>
      {icon && <div className={styles.emptyIcon}>{icon}</div>}
      <p className={styles.emptyTitle}>{title}</p>
      {description && <p className={styles.emptyText}>{description}</p>}
      {action && <div className={styles.emptyAction}>{action}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// ErrorBanner
// ---------------------------------------------------------------------------

export type ErrorBannerProps = {
  /** A thrown value, ApiFailure, or message. Renders nothing when null/undefined. */
  error: unknown;
  /** Bold lead-in, e.g. "Couldn’t load fights." */
  title?: string;
  onRetry?: () => void;
  retrying?: boolean;
  onDismiss?: () => void;
  className?: string;
};

export function ErrorBanner({ error, title, onRetry, retrying = false, onDismiss, className }: ErrorBannerProps) {
  if (error === null || error === undefined || error === false) return null;
  const message = typeof error === "string" ? error : describeError(error);
  return (
    <div className={cx(styles.banner, className)} role="alert">
      <IconAlert className={styles.bannerIcon} />
      <p className={styles.bannerText}>
        {title && <strong className={styles.bannerTitle}>{title} </strong>}
        {message}
      </p>
      {onRetry && (
        <Button size="sm" variant="ghost" onClick={onRetry} loading={retrying}>
          Retry
        </Button>
      )}
      {onDismiss && (
        <button type="button" className={styles.bannerDismiss} onClick={onDismiss} aria-label="Dismiss">
          <IconClose size={14} />
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Skeleton
// ---------------------------------------------------------------------------

export type SkeletonProps = {
  /** CSS length or px number. Default "100%". */
  width?: number | string;
  /** CSS length or px number. Default 12. */
  height?: number | string;
  radius?: "sm" | "md" | "lg" | "pill";
  className?: string;
};

/** Shimmering placeholder block. */
export function Skeleton({ width = "100%", height = 12, radius = "sm", className }: SkeletonProps) {
  const style: CSSProperties = { width, height };
  return <span className={cx(styles.skeleton, styles[`radius_${radius}`], className)} style={style} aria-hidden="true" />;
}

/** `lines` stacked text skeletons, the last one shorter. */
export function SkeletonText({ lines = 3, className }: { lines?: number; className?: string }) {
  return (
    <span className={cx(styles.skeletonText, className)} aria-hidden="true">
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton key={i} width={i === lines - 1 && lines > 1 ? "62%" : "100%"} height={10} />
      ))}
    </span>
  );
}

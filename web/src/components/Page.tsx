import { useEffect, type ReactNode } from "react";
import { cx } from "../lib/cx";
import styles from "./Page.module.css";

export const APP_TITLE = "Sabotage Markets";

export type PageProps = {
  children: ReactNode;
  /**
   * true (default): the page is the scroll container (content column scrolls).
   * false: full-height, non-scrolling flex column (the fight screen). Children
   * must absorb the space themselves (flex: 1; min-height: 0).
   */
  scroll?: boolean;
  /** Max content width for scrolling pages: default 1180px, wide 1440px, full. */
  width?: "default" | "wide" | "full";
  /** Standard gutters. Default true. */
  padded?: boolean;
  /** Sets document.title to "<title> · Sabotage Markets". */
  title?: string;
  className?: string;
};

/** Route-level container. Every screen renders exactly one. */
export function Page({ children, scroll = true, width = "default", padded = true, title, className }: PageProps) {
  useEffect(() => {
    document.title = title ? `${title} · ${APP_TITLE}` : APP_TITLE;
  }, [title]);

  if (!scroll) {
    return <div className={cx(styles.fixed, padded && styles.fixedPadded, className)}>{children}</div>;
  }
  return (
    <div className={styles.scroll}>
      <div className={cx(styles.inner, styles[width], padded && styles.innerPadded, className)}>{children}</div>
    </div>
  );
}

export type PageHeaderProps = {
  title: ReactNode;
  /** Muted line under the title. */
  subtitle?: ReactNode;
  /** Right-aligned controls (filters, buttons). Wraps under the title when narrow. */
  actions?: ReactNode;
  className?: string;
};

/** Title row for scrolling pages. */
export function PageHeader({ title, subtitle, actions, className }: PageHeaderProps) {
  return (
    <header className={cx(styles.header, className)}>
      <div className={styles.headerText}>
        <h1 className={styles.title}>{title}</h1>
        {subtitle && <p className={styles.subtitle}>{subtitle}</p>}
      </div>
      {actions && <div className={styles.actions}>{actions}</div>}
    </header>
  );
}

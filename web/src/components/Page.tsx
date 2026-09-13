import { useEffect, useLayoutEffect, useRef, type ReactNode, type RefObject } from "react";
import { useLocation, useNavigationType } from "react-router-dom";
import { cx } from "../lib/cx";
import { ScrollMemory, restoreTarget } from "./scrollMemory";
import styles from "./Page.module.css";

export const APP_TITLE = "PolyBot";

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
  /** Sets document.title to "<title> · PolyBot". */
  title?: string;
  className?: string;
};

/** Offsets of every scrolling page this session, by history entry. */
const scrollMemory = new ScrollMemory();

/** How long Back/Forward keeps trying to reach its offset while the page fills in. */
const RESTORE_WINDOW_MS = 2_000;

/** Any of these means the user has taken over the scroll. */
const TAKEOVER_EVENTS = ["wheel", "touchstart", "pointerdown", "keydown"] as const;

/**
 * Back/Forward returns a scrolling page to where it was left. The page, not
 * the document, is the scroll container, so the browser's own restoration
 * never applies. Offsets are saved as the page scrolls; on a POP the saved
 * one is re-applied, again each time late content grows the page, until it
 * is reached, the user scrolls, or RESTORE_WINDOW_MS passes.
 */
function useScrollRestoration(ref: RefObject<HTMLDivElement>, enabled: boolean): void {
  const { key } = useLocation();
  const kind = useNavigationType();
  const restoring = useRef(false);
  // The entry on screen, updated as soon as a navigation commits: a page that
  // stays mounted across one (a filter link) files its scroll under the new
  // entry, never over the one Back returns to.
  const currentKey = useRef(key);
  useLayoutEffect(() => {
    currentKey.current = key;
  }, [key]);

  useEffect(() => {
    const node = ref.current;
    if (!enabled || !node) return;
    const save = () => {
      if (!restoring.current) scrollMemory.save(currentKey.current, node.scrollTop);
    };
    node.addEventListener("scroll", save, { passive: true });
    return () => node.removeEventListener("scroll", save);
  }, [ref, enabled]);

  useLayoutEffect(() => {
    const node = ref.current;
    const target = enabled && node ? restoreTarget(scrollMemory, key, kind) : null;
    if (!node || target === null) return;

    restoring.current = true;
    let observer: ResizeObserver | null = null;
    let timer = 0;
    const stop = () => {
      restoring.current = false;
      observer?.disconnect();
      window.clearTimeout(timer);
      for (const type of TAKEOVER_EVENTS) node.removeEventListener(type, stop);
    };
    const apply = () => {
      node.scrollTop = target;
      if (Math.abs(node.scrollTop - target) <= 1) stop();
    };

    for (const type of TAKEOVER_EVENTS) node.addEventListener(type, stop, { passive: true });
    timer = window.setTimeout(stop, RESTORE_WINDOW_MS);
    const content = node.firstElementChild;
    if (content && typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(apply);
      observer.observe(content);
    }
    apply();
    return stop;
  }, [ref, key, kind, enabled]);
}

/** Route-level container. Every screen renders exactly one. */
export function Page({ children, scroll = true, width = "default", padded = true, title, className }: PageProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  useScrollRestoration(scrollRef, scroll);

  useEffect(() => {
    document.title = title ? `${title} · ${APP_TITLE}` : APP_TITLE;
  }, [title]);

  if (!scroll) {
    return <div className={cx(styles.fixed, padded && styles.fixedPadded, className)}>{children}</div>;
  }
  return (
    <div ref={scrollRef} className={styles.scroll}>
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

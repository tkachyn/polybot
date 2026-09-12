/**
 * The persistent frame: sidebar + top bar + content column.
 *
 * The shell is fixed to the viewport (body never scrolls). The content
 * column is a flex column; each route renders a <Page> that either scrolls
 * (default) or fills the height without scrolling (<Page scroll={false}>).
 */
import { useEffect, useRef, useState, type ComponentType } from "react";
import { Link, NavLink, Outlet, useLocation } from "react-router-dom";
import { combineStreamStatus } from "../api/stream";
import { cx } from "../lib/cx";
import { formatInitials } from "../lib/format";
import { useFights } from "../state/fights";
import { BREAKPOINT_REFLOW, useMediaQuery } from "../state/media";
import { useSearchQuery, useSetSearchQuery, useTrackHomeSearch } from "../state/search";
import { useSession } from "../state/session";
import { ButtonLink } from "./Button";
import { ConnectionIndicator } from "./ConnectionIndicator";
import { Skeleton } from "./Feedback";
import { Money } from "./Figures";
import { IconClose, IconFights, IconLeaderboard, IconPortfolio, IconResolved, IconSearch, IconWallet, LogoMark, type IconProps } from "./icons";
import { ErrorBoundary } from "../app/ErrorBoundary";
import { Tag } from "./Tag";
import { DemoJoinDialog } from "../features/demo/DemoJoinDialog";
import styles from "./AppShell.module.css";

export { Page, PageHeader } from "./Page";
export { useSearchQuery } from "../state/search";

type NavItem = {
  to: string;
  label: string;
  Icon: ComponentType<IconProps>;
  /** Extra path prefixes that mark this item active. */
  match?: (pathname: string) => boolean;
};

/** Evaluations: a report page with a small bar chart. */
function IconEvaluations({ size = 16, title, ...rest }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      role={title ? "img" : undefined}
      aria-hidden={title ? undefined : true}
      aria-label={title}
      focusable="false"
      {...rest}
    >
      <path d="M4.5 2h7a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1Z" />
      <path d="M6 11.5v-2M8 11.5V6.5M10 11.5V8.5" />
    </svg>
  );
}

export const NAV_ITEMS: readonly NavItem[] = [
  { to: "/", label: "Fights", Icon: IconFights, match: (p) => p === "/" || p.startsWith("/fights/") },
  { to: "/portfolio", label: "Portfolio", Icon: IconPortfolio },
  { to: "/leaderboard", label: "Leaderboard", Icon: IconLeaderboard },
  { to: "/evaluations", label: "Evaluations", Icon: IconEvaluations },
  { to: "/resolved", label: "Resolved", Icon: IconResolved },
  { to: "/wallet", label: "Wallet", Icon: IconWallet },
];

function Sidebar() {
  const { pathname } = useLocation();
  const { meta } = useSession();
  const items = meta?.demoMode ? NAV_ITEMS.filter((item) => item.to !== "/wallet") : NAV_ITEMS;
  return (
    <nav className={styles.sidebar} aria-label="Primary">
      <Link to="/" className={styles.brand} aria-label="Sabotage Markets home">
        <LogoMark size={24} />
        <span className={styles.brandText}>Sabotage Markets</span>
      </Link>
      <ul className={styles.nav}>
        {items.map(({ to, label, Icon, match }) => (
          <li key={to}>
            <NavLink
              to={to}
              end={to === "/"}
              title={label}
              className={({ isActive }) => cx(styles.navLink, (match ? match(pathname) : isActive) && styles.navActive)}
              aria-current={match ? (match(pathname) ? "page" : undefined) : undefined}
            >
              <Icon size={16} className={styles.navIcon} />
              <span className={styles.navLabel}>{label}</span>
            </NavLink>
          </li>
        ))}
      </ul>
    </nav>
  );
}

function SearchBox() {
  const { pathname } = useLocation();
  const query = useSearchQuery();
  const setQuery = useSetSearchQuery();
  const onHome = pathname === "/";
  const [text, setText] = useState(query);
  const inputRef = useRef<HTMLInputElement>(null);
  useTrackHomeSearch();

  useEffect(() => {
    if (onHome) setText(query);
  }, [onHome, query]);

  // "/" focuses search from anywhere (except while typing in a field).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
      event.preventDefault();
      inputRef.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const update = (value: string) => {
    setText(value);
    setQuery(value);
  };

  return (
    <form className={styles.search} role="search" onSubmit={(e) => e.preventDefault()}>
      <IconSearch size={14} className={styles.searchIcon} />
      <input
        ref={inputRef}
        type="search"
        className={styles.searchInput}
        placeholder="Search fights, tasks, agents"
        aria-label="Search fights"
        value={text}
        onChange={(e) => update(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape" && text) {
            e.preventDefault();
            update("");
          }
        }}
        autoComplete="off"
        spellCheck={false}
      />
      {text && (
        <button type="button" className={styles.searchClear} onClick={() => update("")} aria-label="Clear search">
          <IconClose size={12} />
        </button>
      )}
    </form>
  );
}

function TopBar() {
  const { meta, account, streamStatus: userStream } = useSession();
  const { streamStatus: fightsStream } = useFights();
  const reflow = useMediaQuery(BREAKPOINT_REFLOW);
  const connection = combineStreamStatus([fightsStream, userStream]);

  return (
    <header className={styles.topbar}>
      <SearchBox />
      <div className={styles.topbarRight}>
        {meta?.mode === "simulated" && (
          <Tag tone="edge" title="Simulated mode: agents, browsers and sabotage are simulated. Market, ledger and streams are real.">
            Simulated
          </Tag>
        )}
        <ConnectionIndicator status={connection} showLabel={!reflow} />
        <Link to="/wallet" className={styles.balance} title="Available balance (virtual credits)">
          <span className={cx("label", styles.balanceLabel)}>Balance</span>
          {account ? <Money value={account.balance} size="md" /> : <Skeleton width={64} height={14} />}
        </Link>
        {!meta?.demoMode && (
          <ButtonLink to="/wallet?tab=deposit" variant="action" size="sm">
            Deposit
          </ButtonLink>
        )}
        <Link to="/portfolio" className={styles.avatar} title={account?.displayName ?? "Your account"} aria-label="Your portfolio">
          {account ? formatInitials(account.displayName) : ""}
        </Link>
      </div>
    </header>
  );
}

/** Layout route element: renders the matched screen in the content column. */
export function AppShell() {
  const { pathname } = useLocation();
  return (
    <div className={styles.shell}>
      <DemoJoinDialog />
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <Sidebar />
      <TopBar />
      <main id="main" className={styles.content} tabIndex={-1}>
        <ErrorBoundary resetKey={pathname}>
          <Outlet />
        </ErrorBoundary>
      </main>
    </div>
  );
}

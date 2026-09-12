/**
 * The persistent frame: one navbar across the top, content beneath.
 *
 * The shell is fixed to the viewport (body never scrolls). The content
 * column is a flex column; each route renders a <Page> that either scrolls
 * (default) or fills the height without scrolling (<Page scroll={false}>).
 *
 * The navbar carries the brand on the left, the destinations as inline tabs
 * beside it, and the account on the right. There is no sidebar.
 */
import { type ComponentType } from "react";
import { Link, NavLink, Outlet, useLocation } from "react-router-dom";
import { cx } from "../lib/cx";
import { formatInitials } from "../lib/format";
import { useSession } from "../state/session";
import { Skeleton } from "./Feedback";
import { Money } from "./Figures";
import { IconFights, IconLeaderboard, IconPortfolio, IconResolved, IconWallet, LogoMark, type IconProps } from "./icons";
import { ErrorBoundary } from "../app/ErrorBoundary";
import { Tag } from "./Tag";
import styles from "./AppShell.module.css";

export { Page, PageHeader } from "./Page";

type NavItem = {
  to: string;
  label: string;
  /** Retained for consumers that render nav with icons; the navbar is text-only. */
  Icon: ComponentType<IconProps>;
  /** Extra path prefixes that mark this item active. */
  match?: (pathname: string) => boolean;
};

export const NAV_ITEMS: readonly NavItem[] = [
  { to: "/", label: "Fights", Icon: IconFights, match: (p) => p === "/" || p.startsWith("/fights/") },
  { to: "/portfolio", label: "Portfolio", Icon: IconPortfolio },
  { to: "/leaderboard", label: "Leaderboard", Icon: IconLeaderboard },
  { to: "/resolved", label: "Resolved", Icon: IconResolved },
  { to: "/wallet", label: "Wallet", Icon: IconWallet },
];

/** Brand, destinations and account, in one row across the top. */
function Navbar() {
  const { pathname } = useLocation();
  const { meta, account } = useSession();

  return (
    <header className={styles.navbar}>
      {/* Inner column matches <Page>'s: same max-width and gutter, so the
          brand and the account line up with the page content beneath. */}
      <div className={styles.navbarInner}>
        <Link to="/" className={styles.brand} aria-label="PolyBot home">
          <LogoMark size={26} />
          <span className={styles.brandText}>PolyBot</span>
        </Link>

        <nav className={styles.nav} aria-label="Primary">
          <ul className={styles.navList}>
            {NAV_ITEMS.map(({ to, label, match }) => (
              <li key={to}>
                <NavLink
                  to={to}
                  end={to === "/"}
                  className={({ isActive }) => cx(styles.navLink, (match ? match(pathname) : isActive) && styles.navActive)}
                  aria-current={match ? (match(pathname) ? "page" : undefined) : undefined}
                >
                  {label}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>

        <div className={styles.end}>
          {meta?.mode === "simulated" && (
            <Tag tone="edge" title="Simulated mode: agents, browsers and sabotage are simulated. Market, ledger and streams are real.">
              Simulated
            </Tag>
          )}
          <Link to="/wallet" className={styles.balance} title="Available balance (virtual credits)">
            {account ? <Money value={account.balance} size="md" /> : <Skeleton width={64} height={14} />}
          </Link>
          <Link to="/portfolio" className={styles.avatar} title={account?.displayName ?? "Your account"} aria-label="Your portfolio">
            {account ? formatInitials(account.displayName) : ""}
          </Link>
        </div>
      </div>
    </header>
  );
}

/** Layout route element: renders the matched screen in the content column. */
export function AppShell() {
  const { pathname } = useLocation();
  return (
    <div className={styles.shell}>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <Navbar />
      <main id="main" className={styles.content} tabIndex={-1}>
        <ErrorBoundary resetKey={pathname}>
          <Outlet />
        </ErrorBoundary>
      </main>
    </div>
  );
}

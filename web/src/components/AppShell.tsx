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
import { Link, Outlet, useLocation } from "react-router-dom";
import { cx } from "../lib/cx";
import { formatInitials } from "../lib/format";
import { useSession } from "../state/session";
import { ConnectionBanner } from "./ConnectionBanner";
import { Skeleton } from "./Feedback";
import { Money } from "./Figures";
import { IconFights, IconPortfolio, IconResolved, IconWallet, LogoMark, type IconProps } from "./icons";
import { ErrorBoundary } from "../app/ErrorBoundary";
import { Tag } from "./Tag";
import { DemoJoinDialog } from "../features/demo/DemoJoinDialog";
import { isNavTabActive } from "./navigation";
import styles from "./AppShell.module.css";

export { Page, PageHeader } from "./Page";

/** A tab is active only on the routes it owns: see ./navigation. */
type NavItem = {
  to: string;
  label: string;
  /** Shown in the phone bottom bar, where six text tabs would not fit. */
  Icon: ComponentType<IconProps>;
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
  { to: "/", label: "Fights", Icon: IconFights },
  { to: "/portfolio", label: "Portfolio", Icon: IconPortfolio },
  { to: "/evaluations", label: "Evaluations", Icon: IconEvaluations },
  { to: "/resolved", label: "Resolved", Icon: IconResolved },
  { to: "/wallet", label: "Wallet", Icon: IconWallet },
];

/** Brand, destinations and account, in one row across the top. */
function Navbar() {
  const { pathname } = useLocation();
  const { meta, account } = useSession();
  // Demo mode has no wallet, so that destination is not offered.
  const items = meta?.demoMode ? NAV_ITEMS.filter((item) => item.to !== "/wallet") : NAV_ITEMS;

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
            {items.map(({ to, label, Icon }) => {
              const active = isNavTabActive(to, pathname);
              return (
                <li key={to}>
                  <Link
                    to={to}
                    title={label}
                    className={cx(styles.navLink, active && styles.navActive)}
                    aria-current={active ? "page" : undefined}
                  >
                    {/* Wide screens read the label; phones get the icon, with the
                        label kept for screen readers. */}
                    <Icon size={20} className={styles.navIcon} />
                    <span className={styles.navLabel}>{label}</span>
                  </Link>
                </li>
              );
            })}
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
      <DemoJoinDialog />
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <Navbar />
      <ConnectionBanner />
      <main id="main" className={styles.content} tabIndex={-1}>
        <ErrorBoundary resetKey={pathname}>
          <Outlet />
        </ErrorBoundary>
      </main>
    </div>
  );
}

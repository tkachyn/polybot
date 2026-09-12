/**
 * Inline stroke icons (16px grid, `currentColor`). Decorative by default
 * (aria-hidden); pass `title` to make one meaningful.
 */
import type { ReactNode, SVGProps } from "react";

export type IconProps = Omit<SVGProps<SVGSVGElement>, "children"> & {
  /** Rendered size in px. Default 16. */
  size?: number;
  /** Accessible name; omit for decorative icons. */
  title?: string;
};

function Svg({ size = 16, title, children, ...rest }: IconProps & { children: ReactNode }) {
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
      {children}
    </svg>
  );
}

/** Fights: pulse line. */
export function IconFights(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M1.5 8.5h3l2-5 3 9 2-4h3" />
    </Svg>
  );
}

/** Portfolio: stacked positions. */
export function IconPortfolio(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="2" y="4.5" width="12" height="9" rx="1.5" />
      <path d="M5.5 4.5V3a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v1.5M2 8.5h12" />
    </Svg>
  );
}

/** Leaderboard: podium bars. */
export function IconLeaderboard(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M2 14h12M3.5 14V9h3v5M6.5 14V5h3v9M9.5 14v-3.5h3V14" />
    </Svg>
  );
}

/** Resolved: check in a circle. */
export function IconResolved(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="8" cy="8" r="6" />
      <path d="m5.5 8.2 1.7 1.7 3.3-3.6" />
    </Svg>
  );
}

/** Wallet. */
export function IconWallet(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M2.5 4.5v8a1 1 0 0 0 1 1h9.5a.5.5 0 0 0 .5-.5V6a.5.5 0 0 0-.5-.5H3.5a1 1 0 0 1-1-1Zm0 0a1 1 0 0 1 1-1H11V5.5" />
      <circle cx="10.75" cy="9.5" r=".75" fill="currentColor" stroke="none" />
    </Svg>
  );
}

export function IconSearch(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="7" cy="7" r="4.5" />
      <path d="m10.5 10.5 3 3" />
    </Svg>
  );
}

export function IconClose(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="m4 4 8 8M12 4l-8 8" />
    </Svg>
  );
}

export function IconAlert(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M8 2 1.5 13.5h13L8 2Z" />
      <path d="M8 6.5v3" />
      <circle cx="8" cy="11.5" r=".6" fill="currentColor" stroke="none" />
    </Svg>
  );
}

export function IconChevronRight(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="m6 3.5 4.5 4.5L6 12.5" />
    </Svg>
  );
}

export function IconArrowLeft(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M13 8H3m4-4.5L2.5 8 7 12.5" />
    </Svg>
  );
}

export function IconExpand(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M9.5 2.5h4v4M6.5 13.5h-4v-4M13.5 2.5 9 7M2.5 13.5 7 9" />
    </Svg>
  );
}

export function IconGrid(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="2" y="2" width="5" height="5" rx="1" />
      <rect x="9" y="2" width="5" height="5" rx="1" />
      <rect x="2" y="9" width="5" height="5" rx="1" />
      <rect x="9" y="9" width="5" height="5" rx="1" />
    </Svg>
  );
}

export function IconLanes(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M2 3.5h12M2 8h12M2 12.5h12" />
    </Svg>
  );
}

export function IconRefresh(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2.5v3h-3" />
    </Svg>
  );
}

/** Brand mark (matches public/favicon.svg). Uses tokens via currentColor + a sabotage dot. */
export function LogoMark({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" focusable="false">
      <rect width="32" height="32" rx="7" fill="var(--color-inset)" />
      <path d="M9 21.5 15 10.5M17 21.5 23 10.5" stroke="var(--color-text)" strokeWidth="2.6" strokeLinecap="round" />
      <circle cx="23" cy="21.5" r="2" fill="var(--color-sabotage)" />
    </svg>
  );
}

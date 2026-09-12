/**
 * Foundation primitives. Import from "../../components" in feature folders.
 * See web/README.md for props and usage.
 */
export { AppShell, NAV_ITEMS } from "./AppShell";
export { useSearchQuery } from "../state/search";
export { Page, PageHeader, APP_TITLE, type PageProps, type PageHeaderProps } from "./Page";
export { AgentMonogram, type AgentMonogramProps, type AgentMonogramSize } from "./AgentMonogram";
export { Button, ButtonLink, type ButtonProps, type ButtonLinkProps, type ButtonVariant, type ButtonSize } from "./Button";
export { StatusPill, fightPillStatus, type StatusPillProps, type PillStatus } from "./StatusPill";
export { Tag, SabotageTag, type TagProps, type TagTone } from "./Tag";
export {
  PriceCents,
  ChangeCents,
  Money,
  SignedMoney,
  SignedPercent,
  type PriceCentsProps,
  type ChangeCentsProps,
  type MoneyProps,
  type SignedMoneyProps,
  type SignedPercentProps,
  type FigureSize,
  type FigureTone,
} from "./Figures";
export { ProgressBar, type ProgressBarProps, type ProgressMarker, type ProgressTone } from "./ProgressBar";
export { SegmentedControl, type SegmentedControlProps, type SegmentedOption } from "./SegmentedControl";
export { ElapsedClock, Countdown, RelativeTime, type ElapsedClockProps, type CountdownProps, type RelativeTimeProps } from "./Clock";
export {
  EmptyState,
  ErrorBanner,
  Skeleton,
  SkeletonText,
  type EmptyStateProps,
  type ErrorBannerProps,
  type SkeletonProps,
} from "./Feedback";
export { StatTile, type StatTileProps } from "./StatTile";
export { TableWrap, tableStyles, type TableWrapProps } from "./Table";
export { ConnectionIndicator, type ConnectionIndicatorProps } from "./ConnectionIndicator";
export * from "./icons";

/**
 * Icons used only by the evaluation screens, drawn on the same 16px stroke
 * grid as components/icons.
 */
import type { ReactNode } from "react";
import type { IconProps } from "../../components";

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

export function IconPlay(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M5 3.5v9l7-4.5-7-4.5Z" />
    </Svg>
  );
}

export function IconDownload(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M8 2.5v8m-3.5-3.5L8 10.5 11.5 7M3 13.5h10" />
    </Svg>
  );
}

/** A report page with a small bar chart: the Evaluations screen. */
export function IconEvaluations(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4.5 2h7a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1Z" />
      <path d="M6 11.5v-2M8 11.5V6.5M10 11.5V8.5" />
    </Svg>
  );
}

import { useRef, type KeyboardEvent, type ReactNode } from "react";
import { cx } from "../lib/cx";
import styles from "./SegmentedControl.module.css";

export type SegmentedOption<T extends string> = {
  value: T;
  label: ReactNode;
  /** Optional count badge (e.g. number of live fights). */
  count?: number;
  disabled?: boolean;
  title?: string;
};

export type SegmentedControlProps<T extends string> = {
  options: readonly SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
  /** Required accessible name for the group. */
  "aria-label": string;
  size?: "sm" | "md";
  /** Stretch segments to fill the container. */
  block?: boolean;
  className?: string;
};

/**
 * Single-choice toggle (filters, layout, chart ranges, wallet tabs).
 * A radiogroup with roving focus: arrow keys move and select.
 */
export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  size = "md",
  block = false,
  className,
  "aria-label": ariaLabel,
}: SegmentedControlProps<T>) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const enabled = options.filter((o) => !o.disabled);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const keys = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"];
    if (!keys.includes(event.key) || enabled.length === 0) return;
    event.preventDefault();
    const current = enabled.findIndex((o) => o.value === value);
    let next = current;
    if (event.key === "Home") next = 0;
    else if (event.key === "End") next = enabled.length - 1;
    else if (event.key === "ArrowLeft" || event.key === "ArrowUp") next = (current - 1 + enabled.length) % enabled.length;
    else next = (current + 1) % enabled.length;
    const option = enabled[next];
    if (!option) return;
    onChange(option.value);
    refs.current[options.indexOf(option)]?.focus();
  };

  return (
    <div role="radiogroup" aria-label={ariaLabel} className={cx(styles.group, styles[size], block && styles.block, className)} onKeyDown={onKeyDown}>
      {options.map((option, index) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            ref={(el) => {
              refs.current[index] = el;
            }}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={selected ? 0 : -1}
            disabled={option.disabled}
            title={option.title}
            className={cx(styles.segment, selected && styles.selected)}
            onClick={() => onChange(option.value)}
          >
            {option.label}
            {option.count !== undefined && <span className={cx("num", styles.count)}>{option.count}</span>}
          </button>
        );
      })}
    </div>
  );
}

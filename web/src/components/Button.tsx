import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { Link, type LinkProps } from "react-router-dom";
import { cx } from "../lib/cx";
import styles from "./Button.module.css";

/**
 * - action: the ONLY blue-filled control. View, Deposit, Confirm.
 * - ghost: outlined, for secondary commands (Close, New order, Portfolio).
 * - subtle: borderless inset, for tertiary commands and toolbar toggles.
 */
export type ButtonVariant = "action" | "ghost" | "subtle";
export type ButtonSize = "sm" | "md" | "lg";

type CommonProps = {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Stretch to the container width. */
  block?: boolean;
  /** Leading icon. */
  icon?: ReactNode;
  /** Trailing icon. */
  iconEnd?: ReactNode;
};

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> &
  CommonProps & {
    /** Shows a spinner, keeps the width, and blocks clicks. */
    loading?: boolean;
  };

function classes(variant: ButtonVariant, size: ButtonSize, block: boolean | undefined, className: string | undefined) {
  return cx(styles.button, styles[variant], styles[size], block && styles.block, className);
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "ghost", size = "md", block, icon, iconEnd, loading = false, disabled, className, children, type = "button", ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={classes(variant, size, block, cx(loading && styles.loading, className))}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading && <span className={styles.spinner} aria-hidden="true" />}
      <span className={styles.content}>
        {icon && <span className={styles.icon}>{icon}</span>}
        {children !== undefined && children !== null && <span className={styles.text}>{children}</span>}
        {iconEnd && <span className={styles.icon}>{iconEnd}</span>}
      </span>
    </button>
  );
});

export type ButtonLinkProps = LinkProps & CommonProps;

/** A router link styled as a Button (navigation that looks like a command, e.g. View, Deposit). */
export const ButtonLink = forwardRef<HTMLAnchorElement, ButtonLinkProps>(function ButtonLink(
  { variant = "ghost", size = "md", block, icon, iconEnd, className, children, ...rest },
  ref,
) {
  return (
    <Link ref={ref} className={classes(variant, size, block, className)} {...rest}>
      <span className={styles.content}>
        {icon && <span className={styles.icon}>{icon}</span>}
        {children !== undefined && children !== null && <span className={styles.text}>{children}</span>}
        {iconEnd && <span className={styles.icon}>{iconEnd}</span>}
      </span>
    </Link>
  );
});

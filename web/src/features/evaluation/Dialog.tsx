/**
 * A lightweight modal on the native <dialog>: the browser provides the top
 * layer, focus containment and Escape. Mount it to open, unmount to close.
 * Rendered into document.body so scrolling over the backdrop never scrolls
 * the page behind it.
 */
import { useEffect, useId, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { IconClose } from "../../components";
import { cx } from "../../lib/cx";
import styles from "./Dialog.module.css";

export type DialogProps = {
  title: ReactNode;
  /** Muted line under the title. */
  subtitle?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  /** md 720px, lg 1100px (default). */
  size?: "md" | "lg";
  className?: string;
};

export function Dialog({ title, subtitle, onClose, children, size = "lg", className }: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const pressedBackdrop = useRef(false);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return undefined;
    // The dialog is still closed here, so focus is still on whatever opened it.
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!dialog.open) {
      try {
        dialog.showModal();
      } catch {
        dialog.setAttribute("open", "");
      }
    }
    return () => {
      if (dialog.open) dialog.close();
      // Unmounting drops focus to the body; hand it back to the opener.
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, []);

  const dialog = (
    <dialog
      ref={ref}
      className={cx(styles.dialog, styles[size], className)}
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        onCloseRef.current();
      }}
      // Backdrop clicks land on the <dialog> itself; the panel fills its box.
      onMouseDown={(event) => {
        pressedBackdrop.current = event.target === event.currentTarget;
      }}
      onClick={(event) => {
        if (pressedBackdrop.current && event.target === event.currentTarget) onCloseRef.current();
        pressedBackdrop.current = false;
      }}
    >
      <div className={styles.panel}>
        <header className={styles.header}>
          <div className={styles.heading}>
            <h2 id={titleId} className={styles.title}>
              {title}
            </h2>
            {subtitle && <p className={styles.subtitle}>{subtitle}</p>}
          </div>
          <button type="button" className={styles.close} onClick={() => onCloseRef.current()} aria-label="Close" autoFocus>
            <IconClose size={14} />
          </button>
        </header>
        <div className={styles.body}>{children}</div>
      </div>
    </dialog>
  );

  return typeof document === "undefined" ? dialog : createPortal(dialog, document.body);
}

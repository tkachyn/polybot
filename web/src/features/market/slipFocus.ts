/**
 * The price button that opened the bet slip. Closing the slip (or its
 * receipt) hands focus back to it, like the dialogs do, instead of dropping
 * it to the page body.
 */
let opener: HTMLElement | null = null;

/** Records what had focus as the slip opened or moved to another outcome. */
export function rememberSlipOpener(element: Element | null): void {
  opener = element instanceof HTMLElement && element !== document.body ? element : null;
}

/** Focuses the opener again, if it is still on the page. */
export function returnFocusToSlipOpener(): void {
  if (opener?.isConnected) opener.focus({ preventScroll: true });
}

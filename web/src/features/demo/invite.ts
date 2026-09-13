export function fightInviteUrl(origin: string, raceId: string): string {
  return `${origin.replace(/\/$/, "")}/fights/${encodeURIComponent(raceId)}?join=1`;
}

/** Clipboard API with a fallback for older iOS Safari versions. */
export async function copyInviteText(value: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }
  const input = document.createElement("textarea");
  input.value = value;
  input.setAttribute("readonly", "");
  input.style.position = "fixed";
  input.style.opacity = "0";
  document.body.appendChild(input);
  input.select();
  const copied = document.execCommand("copy");
  input.remove();
  if (!copied) throw new Error("Copy is not available");
}

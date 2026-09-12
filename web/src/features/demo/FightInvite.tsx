import { useEffect, useMemo, useState } from "react";
import QRCode from "qrcode";
import { Button, ButtonLink } from "../../components";
import { Dialog } from "../evaluation/Dialog";
import styles from "./FightInvite.module.css";

/** Kept in step with .qrWrap in FightInvite.module.css. */
const QR_DARK = "#08090a";
const QR_LIGHT = "#f4f2ef";

export function FightInvite({ raceId }: { raceId: string }) {
  const [open, setOpen] = useState(false);
  const [qr, setQr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const url = useMemo(() => {
    if (typeof window === "undefined") return "";
    return `${window.location.origin}/fights/${encodeURIComponent(raceId)}?join=1`;
  }, [raceId]);

  useEffect(() => {
    if (!open || !url) return;
    let active = true;
    // Matches .qrWrap: our ground on our off-white, rather than pure black on
    // pure white, so the code sits in the palette without losing contrast.
    QRCode.toDataURL(url, { width: 320, margin: 2, errorCorrectionLevel: "M", color: { dark: QR_DARK, light: QR_LIGHT } })
      .then((value) => { if (active) setQr(value); })
      .catch(() => { if (active) setQr(null); });
    return () => { active = false; };
  }, [open, url]);

  const copy = async () => {
    await navigator.clipboard.writeText(url);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  return (
    <>
      <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>Invite judges</Button>
      {open && (
        <Dialog title="Scan to join this fight" subtitle="Each phone receives an independent, equal virtual bankroll." onClose={() => setOpen(false)} size="md">
          <div className={styles.layout}>
            <div className={styles.qrWrap}>
              {qr ? <img className={styles.qr} src={qr} alt={`QR code for ${url}`} /> : <span>Generating QR…</span>}
            </div>
            <p className={styles.url}>{url}</p>
            <div className={styles.actions}>
              <Button variant="ghost" onClick={() => void copy()}>{copied ? "Copied" : "Copy link"}</Button>
              <ButtonLink variant="action" to={`/fights/${encodeURIComponent(raceId)}/standings`}>Judge standings</ButtonLink>
            </div>
            {window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1" ? (
              <p className={styles.warning}>This is a local address. Start the Cloudflare Tunnel and open the public URL before displaying this QR code.</p>
            ) : null}
          </div>
        </Dialog>
      )}
    </>
  );
}

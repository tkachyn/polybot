import { useEffect, useMemo, useState } from "react";
import QRCode from "qrcode";
import { Button, ButtonLink } from "../../components";
import { Dialog } from "../evaluation/Dialog";
import { copyInviteText, fightInviteUrl } from "./invite";
import styles from "./FightInvite.module.css";

export function FightInvite({ raceId }: { raceId: string }) {
  const [open, setOpen] = useState(false);
  const [qr, setQr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const url = useMemo(() => {
    if (typeof window === "undefined") return "";
    return fightInviteUrl(window.location.origin, raceId);
  }, [raceId]);

  useEffect(() => {
    if (!open || !url) return;
    let active = true;
    QRCode.toDataURL(url, { width: 320, margin: 2, errorCorrectionLevel: "M", color: { dark: "#0d151d", light: "#ffffff" } })
      .then((value) => { if (active) setQr(value); })
      .catch(() => { if (active) setQr(null); });
    return () => { active = false; };
  }, [open, url]);

  const copy = async () => {
    try {
      await copyInviteText(url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
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

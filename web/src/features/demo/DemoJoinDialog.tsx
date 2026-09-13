import { useEffect, useState, type FormEvent } from "react";
import { useLocation, useSearchParams } from "react-router-dom";
import { Button } from "../../components";
import { Dialog } from "../evaluation/Dialog";
import { useSession } from "../../state/session";
import styles from "./DemoJoinDialog.module.css";

/** One-time judge naming flow opened by the QR link's ?join=1 flag. */
export function DemoJoinDialog() {
  const [params, setParams] = useSearchParams();
  const { pathname } = useLocation();
  const { meta, account, updateDisplayName } = useSession();
  const invited = params.get("join") === "1";
  const onFight = /^\/fights\/[^/]+$/.test(pathname);
  const named = account ? !account.displayName.startsWith("Trader ") : false;
  const [name, setName] = useState("");
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (account && !name) setName(account.displayName.startsWith("Trader ") ? "" : account.displayName);
  }, [account, name]);

  if (!meta?.demoMode || !account || (!invited && (!onFight || named))) return null;

  const close = () => {
    if (!named && name.trim() === "") return;
    setParams((previous) => {
      const next = new URLSearchParams(previous);
      next.delete("join");
      return next;
    }, { replace: true });
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const value = name.trim();
    if (!value) {
      setMessage("Enter the name shown on the judge standings.");
      return;
    }
    if (value.length > 40) {
      setMessage("Use 40 characters or fewer.");
      return;
    }
    setPending(true);
    setMessage(null);
    const saved = await updateDisplayName(value);
    setPending(false);
    if (saved) close();
    else setMessage("Could not save your name. Check the connection and try again.");
  };

  return (
    <Dialog title="Join the market" subtitle={`You have ${meta.startingBalance} virtual credits. One phone, one bankroll.`} onClose={close} size="md">
      <form className={styles.form} onSubmit={submit}>
        <label className={styles.label} htmlFor="demo-judge-name">Your name</label>
        <input
          id="demo-judge-name"
          className={styles.input}
          value={name}
          maxLength={40}
          autoComplete="name"
          enterKeyHint="done"
          onChange={(event) => setName(event.target.value)}
          placeholder="Judge name"
          autoFocus
        />
        {message && <p className={styles.message} role="alert">{message}</p>}
        <Button type="submit" variant="action" size="lg" block loading={pending}>Enter fight</Button>
        <p className={styles.note}>No money is involved. Clearing site data creates a new demo identity.</p>
      </form>
    </Dialog>
  );
}

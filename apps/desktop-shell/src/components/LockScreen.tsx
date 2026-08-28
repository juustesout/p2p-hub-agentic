import { useEffect, useRef, useState } from "react";
import { useApp } from "../state/AppState";
import { KeyRound, Loader2, ShieldCheck } from "lucide-react";

/**
 * Full-screen vault unlock gate (Slice 2). While the core-server reports
 * `locked`, this replaces the whole desktop. It is the only surface allowed to
 * call the unlock route — the rest of the UI never sees locked state because
 * it is not rendered at all.
 */
export function LockScreen() {
  const { unlockVault } = useApp();
  const [masterKey, setMasterKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const submit = async (event?: React.FormEvent) => {
    event?.preventDefault();
    if (busy) {
      return;
    }
    setError(null);
    if (!masterKey) {
      setError("Voer de master key in.");
      return;
    }
    setBusy(true);
    try {
      const result = await unlockVault(masterKey);
      if (!result.ok) {
        setError(result.error ?? "Ontgrendelen mislukt.");
        setMasterKey("");
        inputRef.current?.focus();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="absolute inset-0 z-[100] flex items-center justify-center bg-slate-950">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_top_left,rgba(56,189,248,0.18),transparent_50%),radial-gradient(ellipse_at_bottom_right,rgba(129,140,248,0.16),transparent_50%)]" />
      <div className="panel relative w-[420px] max-w-[90vw] overflow-hidden">
        <div className="flex items-center gap-2 border-b border-white/10 px-6 py-4">
          <KeyRound size={18} className="text-amber-300" />
          <h1 className="text-base font-semibold text-slate-100">
            P2P Hub — ontgrendelen
          </h1>
        </div>
        <form onSubmit={submit} className="space-y-4 px-6 py-6">
          <p className="text-sm leading-relaxed text-slate-400">
            De vault is vergrendeld. Voer de master key in om het netwerk en de
            plugins te starten.
          </p>
          <div className="flex items-center gap-2 rounded-lg border border-white/10 bg-slate-900/80 px-3 py-2 focus-within:border-sky-400/60">
            <KeyRound size={16} className="shrink-0 text-slate-500" />
            <input
              ref={inputRef}
              type="password"
              autoComplete="off"
              value={masterKey}
              onChange={(event) => setMasterKey(event.target.value)}
              placeholder="Master key"
              disabled={busy}
              className="w-full bg-transparent text-sm text-slate-100 placeholder:text-slate-600 focus:outline-none disabled:opacity-60"
            />
          </div>
          {error && (
            <p className="text-sm text-rose-400" role="alert">
              {error}
            </p>
          )}
          <button
            type="submit"
            disabled={busy || !masterKey}
            className="flex w-full items-center justify-center gap-2 rounded-lg bg-sky-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-sky-500 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? (
              <>
                <Loader2 size={16} className="animate-spin" />
                Ontgrendelen…
              </>
            ) : (
              <>
                <ShieldCheck size={16} />
                Ontgrendelen
              </>
            )}
          </button>
        </form>
      </div>
    </div>
  );
}

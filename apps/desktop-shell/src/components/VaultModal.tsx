import { useState } from "react";
import { useApp } from "../state/AppState";
import {
  KeyRound,
  X,
  Plus,
  Trash2,
  ShieldAlert,
  ShieldCheck,
  Loader2,
} from "lucide-react";

interface VaultModalProps {
  open: boolean;
  onClose: () => void;
}

export function VaultModal({ open, onClose }: VaultModalProps) {
  const { vault, vaultSet, vaultDelete } = useApp();
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) {
    return null;
  }

  const submit = async () => {
    setError(null);
    if (!key.trim()) {
      setError("Key name is required.");
      return;
    }
    if (!value) {
      setError("Value is required.");
      return;
    }
    setBusy(true);
    try {
      await vaultSet(key.trim(), value);
      setKey("");
      setValue("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (keyName: string) => {
    setError(null);
    setBusy(true);
    try {
      await vaultDelete(keyName);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const model = vault.model;

  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="panel w-[520px] max-w-[90vw] overflow-hidden">
        <div className="flex items-center justify-between border-b border-white/10 px-5 py-4">
          <div className="flex items-center gap-2">
            <KeyRound size={18} className="text-amber-300" />
            <h2 className="text-base font-semibold text-slate-100">Vault</h2>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-1.5 text-slate-400 hover:bg-white/10"
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>

        <div className="max-h-[420px] space-y-4 overflow-y-auto px-5 py-4">
          {/* Master key status */}
          <div
            className={`flex items-start gap-3 rounded-xl border px-4 py-3 ${
              vault.masterKeyConfigured
                ? "border-emerald-500/20 bg-emerald-500/10"
                : "border-amber-500/20 bg-amber-500/10"
            }`}
          >
            {vault.masterKeyConfigured ? (
              <ShieldCheck size={18} className="mt-0.5 shrink-0 text-emerald-400" />
            ) : (
              <ShieldAlert size={18} className="mt-0.5 shrink-0 text-amber-400" />
            )}
            <div className="text-xs">
              <p className="font-medium text-slate-200">
                {vault.masterKeyConfigured
                  ? "Master key configured"
                  : "Using insecure dev master key"}
              </p>
              <p className="mt-1 text-slate-400">
                {vault.masterKeyConfigured
                  ? "Secrets are encrypted with a user-supplied master key."
                  : "Set P2P_HUB_VAULT_KEY to protect secrets. The current dev key is not secure."}
              </p>
            </div>
          </div>

          {/* Active model */}
          <div>
            <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
              Active AI configuration
            </p>
            <div className="rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-sm">
              <div className="flex items-center justify-between">
                <span className="text-slate-400">Model</span>
                <span
                  className={
                    model.hasModel ? "text-emerald-300" : "text-slate-500"
                  }
                >
                  {model.hasModel ? "configured" : "missing"}
                </span>
              </div>
              <div className="mt-1 flex items-center justify-between">
                <span className="text-slate-400">Endpoint</span>
                <span
                  className={
                    model.hasBaseUrl ? "text-emerald-300" : "text-slate-500"
                  }
                >
                  {model.hasBaseUrl ? "configured" : "missing"}
                </span>
              </div>
              <div className="mt-1 flex items-center justify-between">
                <span className="text-slate-400">API key</span>
                <span
                  className={
                    model.hasApiKey ? "text-emerald-300" : "text-slate-500"
                  }
                >
                  {model.hasApiKey ? "configured" : "missing"}
                </span>
              </div>
            </div>
          </div>

          {/* Stored keys */}
          <div>
            <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
              Stored secrets
            </p>
            {vault.keys.length === 0 && (
              <p className="rounded-xl border border-dashed border-white/10 px-4 py-5 text-center text-xs text-slate-500">
                No secrets stored yet.
              </p>
            )}
            <div className="space-y-1">
              {vault.keys.map((meta) => (
                <div
                  key={meta.key}
                  className="flex items-center justify-between rounded-xl border border-white/10 bg-white/5 px-3 py-2"
                >
                  <div>
                    <p className="font-mono text-sm text-slate-200">{meta.key}</p>
                    <p className="text-[10px] text-slate-500">
                      {meta.updatedAt
                        ? new Date(meta.updatedAt).toLocaleString()
                        : "updated unknown"}
                    </p>
                  </div>
                  <button
                    onClick={() => void remove(meta.key)}
                    className="rounded-lg p-1.5 text-slate-400 hover:bg-red-500/10 hover:text-red-300"
                    aria-label={`Delete ${meta.key}`}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}
            </div>
          </div>

          {/* Add secret */}
          <div className="rounded-xl border border-white/10 bg-white/5 p-3">
            <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
              Add secret
            </p>
            <div className="space-y-2">
              <input
                value={key}
                onChange={(e) => setKey(e.target.value)}
                placeholder="Key (e.g. openai.key)"
                className="w-full rounded-lg border border-white/10 bg-slate-900/60 px-3 py-2 text-sm text-slate-100 placeholder-slate-500 outline-none focus:border-sky-400/50"
              />
              <input
                value={value}
                onChange={(e) => setValue(e.target.value)}
                type="password"
                placeholder="Value (stored encrypted)"
                className="w-full rounded-lg border border-white/10 bg-slate-900/60 px-3 py-2 text-sm text-slate-100 placeholder-slate-500 outline-none focus:border-sky-400/50"
              />
              {error && <p className="text-xs text-red-400">{error}</p>}
              <button
                onClick={() => void submit()}
                disabled={busy}
                className="flex w-full items-center justify-center gap-2 rounded-lg bg-sky-500/20 px-3 py-2 text-sm text-sky-200 hover:bg-sky-500/30 disabled:opacity-40"
              >
                {busy ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
                Store secret
              </button>
            </div>
          </div>

          <p className="text-[10px] leading-relaxed text-slate-600">
            Values are encrypted client-side by the core vault and are never
            returned to this UI — only key names and metadata are shown.
          </p>
        </div>
      </div>
    </div>
  );
}

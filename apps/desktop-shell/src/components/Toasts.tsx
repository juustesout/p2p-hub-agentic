import { useEffect } from "react";
import { useApp } from "../state/AppState";
import { X, Info, CheckCircle2, AlertCircle } from "lucide-react";

const ICONS = {
  info: Info,
  success: CheckCircle2,
  error: AlertCircle,
};

const COLORS = {
  info: "text-sky-400",
  success: "text-emerald-400",
  error: "text-red-400",
};

export function Toasts() {
  const { toasts, dismissToast } = useApp();

  useEffect(() => {
    const timers = toasts.map((toast) =>
      window.setTimeout(() => dismissToast(toast.id), 5_000),
    );
    return () => timers.forEach((timer) => window.clearTimeout(timer));
  }, [toasts, dismissToast]);

  return (
    <div className="pointer-events-none absolute right-4 top-4 z-50 flex w-80 flex-col gap-2">
      {toasts.map((toast) => {
        const Icon = ICONS[toast.kind];
        return (
          <div
            key={toast.id}
            className="glass-strong pointer-events-auto flex items-start gap-3 rounded-xl px-4 py-3"
          >
            <Icon size={18} className={`mt-0.5 shrink-0 ${COLORS[toast.kind]}`} />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-slate-100">{toast.title}</p>
              <p className="truncate text-xs text-slate-400">{toast.body}</p>
            </div>
            <button
              onClick={() => dismissToast(toast.id)}
              className="shrink-0 rounded-md p-1 text-slate-500 hover:bg-white/10"
              aria-label="Dismiss"
            >
              <X size={14} />
            </button>
          </div>
        );
      })}
    </div>
  );
}

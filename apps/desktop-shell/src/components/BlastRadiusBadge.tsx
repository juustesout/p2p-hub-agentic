import type { RiskSeverity } from "../types";

const STYLES: Record<RiskSeverity, string> = {
  none: "bg-slate-700/40 text-slate-300",
  low: "bg-slate-600/40 text-slate-300",
  medium: "bg-amber-500/20 text-amber-300",
  high: "bg-orange-500/20 text-orange-300",
  critical: "bg-red-500/20 text-red-300",
};

const LABELS: Record<RiskSeverity, string> = {
  none: "No risk",
  low: "Low risk",
  medium: "Medium risk",
  high: "High risk",
  critical: "Critical risk",
};

export function BlastRadiusBadge({ severity }: { severity: RiskSeverity }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium ${STYLES[severity]}`}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-current" />
      {LABELS[severity]}
    </span>
  );
}

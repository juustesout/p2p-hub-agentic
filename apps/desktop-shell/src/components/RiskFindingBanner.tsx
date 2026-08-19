import type { RiskFinding, RiskSeverity } from "../types";

const SEVERITY_TEXT: Record<Exclude<RiskSeverity, "none">, string> = {
  low: "text-slate-400",
  medium: "text-amber-300",
  high: "text-orange-300",
  critical: "text-red-300",
};

interface RiskFindingBannerProps {
  findings: RiskFinding[];
}

export function RiskFindingBanner({ findings }: RiskFindingBannerProps) {
  if (findings.length === 0) {
    return (
      <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/10 px-4 py-3 text-xs text-emerald-300">
        No known risks with the current settings.
      </div>
    );
  }

  return (
    <ul className="space-y-2">
      {findings.map((finding) => (
        <li
          key={finding.id}
          className="rounded-xl border border-white/10 bg-white/5 px-4 py-3"
        >
          <div className="flex items-center justify-between">
            <span className="font-mono text-xs text-slate-200">{finding.id}</span>
            <span
              className={`text-[10px] font-semibold uppercase tracking-wider ${SEVERITY_TEXT[finding.severity]}`}
            >
              {finding.severity}
            </span>
          </div>
          <p className="mt-1 text-xs text-slate-400">{finding.message}</p>
        </li>
      ))}
    </ul>
  );
}

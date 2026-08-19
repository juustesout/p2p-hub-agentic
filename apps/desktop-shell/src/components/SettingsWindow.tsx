import { useEffect, useMemo, useState } from "react";
import { evaluateSettingsRisk } from "@p2p-hub/sdk";
import type { EffectiveSettings, RiskAssessment } from "../types";
import { coreBridge } from "../services/core-bridge";
import { confirmTier2 } from "../services/trust-confirm";
import { BlastRadiusBadge } from "./BlastRadiusBadge";
import { RiskFindingBanner } from "./RiskFindingBanner";
import { Loader2, Save, ShieldAlert } from "lucide-react";

const DEFAULTS: EffectiveSettings = {
  p2pHubExposed: false,
  chatAutoNotify: false,
  unrestrictedRemoteSkills: false,
  allowExternalApiExecution: false,
  localVaultStorage: false,
};

interface Field {
  key: keyof EffectiveSettings;
  label: string;
  description: string;
}

const FIELDS: Field[] = [
  {
    key: "p2pHubExposed",
    label: "Expose P2P hub beyond loopback",
    description: "Make the local hub reachable by other machines on the network.",
  },
  {
    key: "chatAutoNotify",
    label: "Chat auto-notification",
    description: "Automatically notify on incoming chat activity.",
  },
  {
    key: "unrestrictedRemoteSkills",
    label: "Unrestricted remote skills",
    description: "Allow any discovered peer to invoke exposed skills without restrictions.",
  },
  {
    key: "allowExternalApiExecution",
    label: "External API execution",
    description: "Permit remote skills to trigger external API calls.",
  },
  {
    key: "localVaultStorage",
    label: "Local vault storage",
    description: "Keep the encrypted vault on this device rather than a remote store.",
  },
];

/** Which settings each finding implicates, for per-field warnings. */
const FINDING_FIELDS: Record<string, (keyof EffectiveSettings)[]> = {
  ERR_EXPOSED_UNRESTRICTED_SKILL: [
    "p2pHubExposed",
    "chatAutoNotify",
    "unrestrictedRemoteSkills",
  ],
  ERR_REMOTE_EXTERNAL_API_ACCESS: [
    "allowExternalApiExecution",
    "unrestrictedRemoteSkills",
  ],
  WARN_P2P_VAULT_EXPOSURE: ["p2pHubExposed", "localVaultStorage"],
};

function summaryFor(risk: RiskAssessment): string {
  if (risk.findings.length === 0) {
    return "Apply security settings (no known risks)";
  }
  return `Apply security settings (${risk.aggregate}): ${risk.findings
    .map((f) => f.id)
    .join(", ")}`;
}

export function SettingsWindow() {
  const [settings, setSettings] = useState<EffectiveSettings>(DEFAULTS);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    coreBridge
      .getSettings()
      .then((res) => setSettings(res.settings))
      .catch(() => {
        /* keep defaults while the server is unreachable */
      })
      .finally(() => setLoaded(true));
  }, []);

  const risk = useMemo(() => evaluateSettingsRisk(settings), [settings]);

  const involvedFields = useMemo(() => {
    const involved = new Set<string>();
    for (const finding of risk.findings) {
      for (const field of FINDING_FIELDS[finding.id] ?? []) {
        involved.add(field);
      }
    }
    return involved;
  }, [risk]);

  const toggle = (key: keyof EffectiveSettings) => {
    setSettings((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const save = async () => {
    setMessage(null);
    if (risk.aggregate === "critical") {
      const confirmed = await confirmTier2(summaryFor(risk));
      if (!confirmed) {
        setMessage(
          "This change requires a native (host) confirmation that was not granted.",
        );
        return;
      }
    }
    setSaving(true);
    try {
      const result = await coreBridge.applySettings(settings);
      setMessage(
        result.ok
          ? "Settings applied."
          : result.error ?? "Settings were not applied.",
      );
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-white/10 px-5 py-3">
        <BlastRadiusBadge severity={risk.aggregate} />
        {risk.aggregate === "critical" && (
          <span className="flex items-center gap-1 text-[11px] text-red-300">
            <ShieldAlert size={14} />
            Native confirmation required to apply
          </span>
        )}
      </div>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
        <RiskFindingBanner findings={risk.findings} />

        <div>
          <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
            Effective settings
          </p>
          <div className="space-y-1">
            {FIELDS.map((field) => {
              const warned = involvedFields.has(field.key);
              return (
                <label
                  key={field.key}
                  className={`flex cursor-pointer items-center justify-between rounded-xl border px-4 py-3 ${
                    warned
                      ? "border-amber-500/30 bg-amber-500/5"
                      : "border-white/10 bg-white/5"
                  }`}
                >
                  <div className="min-w-0 pr-3">
                    <p className="text-sm text-slate-100">{field.label}</p>
                    <p className="mt-0.5 text-xs text-slate-500">
                      {field.description}
                    </p>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={settings[field.key]}
                    onClick={() => toggle(field.key)}
                    className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${
                      settings[field.key] ? "bg-sky-500" : "bg-slate-700"
                    }`}
                  >
                    <span
                      className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all ${
                        settings[field.key] ? "left-[22px]" : "left-0.5"
                      }`}
                    />
                  </button>
                </label>
              );
            })}
          </div>
        </div>

        {message && <p className="text-xs text-slate-300">{message}</p>}
      </div>

      <div className="flex items-center justify-end gap-2 border-t border-white/10 px-5 py-3">
        <button
          onClick={() => void save()}
          disabled={saving || !loaded}
          className="flex items-center gap-2 rounded-lg bg-sky-500/20 px-4 py-2 text-sm text-sky-200 hover:bg-sky-500/30 disabled:opacity-40"
        >
          {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
          Apply settings
        </button>
      </div>
    </div>
  );
}

import { useCallback, useEffect, useState, type ReactNode } from "react";
import type {
  BundleResponse,
  DiagnosticSnapshot,
  DiagnosticsSourceInfo,
  DiagnosticsBundleSection,
  SnapshotResponse,
} from "../../types";
import { DIAGNOSTICS_BUNDLE_SECTIONS } from "../../types";
import { coreBridge } from "../../services/core-bridge";
import { probeWebglGpu } from "../../services/gpu-probe";
import {
  isSafeMode,
  mb,
  snapshotPlugins,
  transportLabel,
} from "./logic";
import { bundleFilename, bundleJson, copyToClipboard, downloadTextFile } from "./export";
import {
  Activity,
  AlertTriangle,
  Check,
  Clipboard,
  Cpu,
  Download,
  FileText,
  HardDrive,
  Loader2,
  Network,
  RefreshCw,
  Save,
  Server,
  ShieldCheck,
  Sparkles,
} from "lucide-react";

interface BundleDraft {
  sections: DiagnosticsBundleSection[];
  sources: string[];
  userNote: string;
}

const ALL_SECTIONS: DiagnosticsBundleSection[] = [...DIAGNOSTICS_BUNDLE_SECTIONS];

/**
 * The Diagnose tab of the HelpCenter (Pijler B/C / Brief 7C): a live
 * snapshot ("systeemstatus") of the local node, plus the send-to-support
 * bundle flow with a *preview step* — nothing leaves the machine until the
 * operator copies or saves the output explicitly.
 */
export function DiagnoseTab() {
  const [snapshot, setSnapshot] = useState<DiagnosticSnapshot | null>(null);
  const [summary, setSummary] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshBusy, setRefreshBusy] = useState(false);

  const [sources, setSources] = useState<DiagnosticsSourceInfo[]>([]);
  const [draft, setDraft] = useState<BundleDraft>({
    sections: ALL_SECTIONS,
    sources: [],
    userNote: "",
  });
  const [building, setBuilding] = useState(false);
  const [bundle, setBundle] = useState<BundleResponse | null>(null);
  const [copyState, setCopyState] = useState<"idle" | "ok" | "fail">("idle");
  const [saved, setSaved] = useState(false);

  const loadSnapshot = useCallback(async (withGpu: boolean) => {
    try {
      let res: SnapshotResponse;
      if (withGpu) {
        res = await coreBridge.diagnosticsSnapshot(probeWebglGpu());
      } else {
        res = await coreBridge.diagnosticsSnapshot();
      }
      setSnapshot(res.snapshot);
      setSummary(res.summary);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
      setRefreshBusy(false);
    }
  }, []);

  // Prefer the shell's WebGL probe when available; if the probe is all-null
  // (headless CI / blocked GPU) the server treats it as absent anyway.
  const refresh = useCallback(() => {
    setRefreshBusy(true);
    void loadSnapshot(true);
  }, [loadSnapshot]);

  useEffect(() => {
    void loadSnapshot(true);
  }, [loadSnapshot]);

  // Load the source register to seed the bundle's source pickers.
  useEffect(() => {
    let cancelled = false;
    void coreBridge
      .diagnosticsLogs()
      .then((res) => {
        if (!cancelled) {
          setSources(res.sources);
          setDraft((d) => ({
            ...d,
            sources:
              d.sources.length > 0
                ? d.sources
                : res.sources.filter((s) => s.enabled).map((s) => s.id),
          }));
        }
      })
      .catch(() => {
        /* register is non-fatal for the diagnose overview */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const toggleSection = (section: DiagnosticsBundleSection) => {
    setDraft((d) => ({
      ...d,
      sections: d.sections.includes(section)
        ? d.sections.filter((s) => s !== section)
        : [...d.sections, section],
    }));
  };

  const toggleSource = (id: string, enabled: boolean) => {
    setDraft((d) => ({
      ...d,
      sources: enabled ? [...d.sources, id] : d.sources.filter((s) => s !== id),
    }));
  };

  const buildBundle = async () => {
    setBuilding(true);
    setCopyState("idle");
    setSaved(false);
    setBundle(null);
    try {
      const res = await coreBridge.createDiagnosticsBundle({
        sections: draft.sections,
        sources: draft.sources,
        userNote: draft.userNote.trim() || undefined,
        clientGpu: probeWebglGpu(),
      });
      setBundle(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBuilding(false);
    }
  };

  const copyBundle = async () => {
    if (!bundle) {
      return;
    }
    const ok = await copyToClipboard(bundle.clipboardText);
    setCopyState(ok ? "ok" : "fail");
  };

  const saveBundle = () => {
    if (!bundle) {
      return;
    }
    const ok = downloadTextFile(bundleFilename(), bundleJson(bundle.bundle));
    setSaved(ok);
  };

  const safeMode = snapshot ? isSafeMode(snapshot) : false;

  return (
    <div className="h-full overflow-y-auto p-4">
      {/* Status header */}
      <div className="flex items-center gap-2">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-100">
          <Activity size={15} className="text-sky-400" />
          Systeemstatus
        </h2>
        <button
          type="button"
          onClick={refresh}
          disabled={refreshBusy}
          className="ml-auto flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-2.5 py-1 text-xs text-slate-300 hover:bg-white/10 disabled:opacity-50"
          title="Ververs de systeemstatus"
        >
          <RefreshCw size={12} className={refreshBusy ? "animate-spin" : ""} />
          Verversen
        </button>
      </div>

      {loading && !snapshot && (
        <p className="mt-3 flex items-center gap-2 text-xs text-slate-500">
          <Loader2 size={12} className="animate-spin" /> status verzamelen…
        </p>
      )}

      {error && (
        <p className="mt-3 flex items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
          <AlertTriangle size={13} /> {error}
        </p>
      )}

      {safeMode && (
        <p className="mt-3 flex items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
          <ShieldCheck size={13} />
          Veilige modus actief — plugins en netwerk zijn uitgeschakeld om op te
          starten. Raadpleeg de documentatie voor herstelstappen.
        </p>
      )}

      {summary && !error && (
        <p className="mt-3 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-xs text-slate-300">
          {summary}
        </p>
      )}

      {snapshot && (
        <div className="mt-3 grid grid-cols-2 gap-3 xl:grid-cols-3">
          <InfoCard icon={<Cpu size={14} />} title="Systeem">
            <Row k="platform" v={`${snapshot.system.platform} ${snapshot.system.release} (${snapshot.system.arch})`} />
            <Row k="uptime" v={uptimeLabel(snapshot.system.uptime)} />
            <Row k="geheugen" v={`${mb(snapshot.system.freemem)} vrij / ${mb(snapshot.system.totalmem)}`} />
            <Row k="cpu" v={`${snapshot.system.cpus.length} cores`} />
          </InfoCard>

          <InfoCard icon={<Server size={14} />} title="Runtime">
            <Row k="node" v={snapshot.runtime.nodeVersion} />
            <Row k="core" v={snapshot.runtime.coreVersion} />
            <Row k="pid" v={String(snapshot.runtime.pid)} />
            <Row k="heap" v={mb(snapshot.runtime.memoryUsage.heapUsed)} />
          </InfoCard>

          <InfoCard icon={<Sparkles size={14} />} title="GPU / webview">
            {snapshot.hardware.gpu ? (
              <>
                <Row k="renderer" v={snapshot.hardware.gpu.renderer ?? "onbekend"} />
                <Row k="vendor" v={snapshot.hardware.gpu.vendor ?? "onbekend"} />
                <Row k="bron" v={gpuSourceLabel(snapshot.hardware.gpu.source)} />
              </>
            ) : (
              <Row k="gpu" v="geen GPU-info beschikbaar" />
            )}
            <Row k="webgl" v={snapshot.hardware.webglRenderer ?? "niet beschikbaar"} />
            <Row
              k="versnelling"
              v={boolLabel(snapshot.hardware.hardwareAcceleration, "aan", "uit")}
            />
            <Row k="schaalfactor" v={fmtNullable(snapshot.hardware.windowScaleFactor)} />
          </InfoCard>

          <InfoCard icon={<Network size={14} />} title="Netwerk">
            <Row k="provider" v={snapshot.network.providerId ?? "geen"} />
            <Row k="transport" v={transportLabel(snapshot.network.transportMode)} />
            <Row k="peers" v={String(snapshot.network.peerCount)} />
            <Row k="wan" v={snapshot.network.wanEnabled ? "aan" : "uit"} />
          </InfoCard>

          <InfoCard icon={<HardDrive size={14} />} title="Vault">
            <Row k="vergrendeld" v={boolLabel(snapshot.vault.locked, "ja", "nee")} />
            <Row k="master key" v={boolLabel(snapshot.vault.masterKeyConfigured, "aanwezig", "geen")} />
            <Row k="netwerk gepauzeerd" v={boolLabel(snapshot.vault.networkPaused, "ja", "nee")} />
          </InfoCard>

          <InfoCard icon={<FileText size={14} />} title="Plugins">
            {snapshotPlugins(snapshot).length === 0 && <Row k="plugins" v="geen" />}
            {snapshotPlugins(snapshot).map((p) => (
              <Row key={p.id} k={p.id} v={p.state} />
            ))}
          </InfoCard>
        </div>
      )}

      {/* Bundle flow */}
      <div className="mt-5 border-t border-white/10 pt-4">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-100">
          <Clipboard size={15} className="text-emerald-400" />
          Diagnose-bundel delen
        </h3>
        <p className="mt-1 text-xs leading-relaxed text-slate-500">
          Maak een bundel met systeemstatus en logregels voor de helpdesk. De bundel is
          altijd geredigeerd en verlaat je computer pas wanneer je hem kopieert of
          opslaat.
        </p>

        <div className="mt-3 space-y-3">
          <div>
            <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
              Snapshot-secties
            </p>
            <div className="flex flex-wrap gap-1.5">
              {ALL_SECTIONS.map((section) => {
                const on = draft.sections.includes(section);
                return (
                  <button
                    key={section}
                    type="button"
                    onClick={() => toggleSection(section)}
                    className={`rounded-full border px-2.5 py-1 text-[11px] transition-colors ${
                      on
                        ? "border-sky-500/40 bg-sky-500/15 text-sky-200"
                        : "border-white/10 bg-white/5 text-slate-400 hover:bg-white/10"
                    }`}
                  >
                    {section}
                  </button>
                );
              })}
            </div>
          </div>

          <div>
            <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
              Logbronnen
            </p>
            {sources.length === 0 ? (
              <p className="text-xs text-slate-600">Geen logbronnen gevonden.</p>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {sources.map((source) => {
                  const on = draft.sources.includes(source.id);
                  return (
                    <button
                      key={source.id}
                      type="button"
                      onClick={() => toggleSource(source.id, !on)}
                      className={`rounded-full border px-2.5 py-1 text-[11px] transition-colors ${
                        on
                          ? "border-emerald-500/40 bg-emerald-500/15 text-emerald-200"
                          : "border-white/10 bg-white/5 text-slate-400 hover:bg-white/10"
                      }`}
                    >
                      {source.name}
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          <div>
            <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
              Toelichting (optioneel, max 4000 tekens)
            </p>
            <textarea
              value={draft.userNote}
              maxLength={4000}
              onChange={(e) => setDraft((d) => ({ ...d, userNote: e.target.value }))}
              placeholder="Wat wilde je doen toen het probleem optrad?"
              rows={2}
              className="w-full resize-none rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-xs text-slate-100 placeholder-slate-500 outline-none focus:border-sky-500/40"
            />
          </div>

          <button
            type="button"
            onClick={() => void buildBundle()}
            disabled={building || draft.sections.length === 0}
            className="flex items-center gap-2 rounded-lg bg-emerald-500/20 px-4 py-2 text-sm font-medium text-emerald-200 hover:bg-emerald-500/30 disabled:opacity-40"
          >
            {building ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
            Genereer bundel
          </button>
        </div>

        {bundle && (
          <div className="mt-3 rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-3">
            <p className="flex items-center gap-2 text-xs font-medium text-emerald-200">
              <Check size={13} />
              Bundel gereed ({bundle.preview.sections.join(", ")}) — altijd
              geredigeerd.
            </p>
            <pre className="mt-2 max-h-40 overflow-auto rounded-lg bg-black/30 p-2 text-[10px] leading-relaxed text-slate-400">
              {bundle.clipboardText}
            </pre>
            <div className="mt-2 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => void copyBundle()}
                className="flex items-center gap-1.5 rounded-lg bg-white/10 px-3 py-1.5 text-xs text-slate-200 hover:bg-white/20"
              >
                <Clipboard size={12} />
                {copyState === "ok" ? "Gekopieerd" : copyState === "fail" ? "Mislukt" : "Kopiëren"}
              </button>
              <button
                type="button"
                onClick={saveBundle}
                className="flex items-center gap-1.5 rounded-lg bg-white/10 px-3 py-1.5 text-xs text-slate-200 hover:bg-white/20"
              >
                <Download size={12} />
                {saved ? "Opgeslagen" : "Opslaan als bestand"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function InfoCard({
  icon,
  title,
  children,
}: {
  icon: ReactNode;
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.03] p-3">
      <p className="mb-1.5 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
        <span className="text-slate-400">{icon}</span>
        {title}
      </p>
      <div className="space-y-0.5">{children}</div>
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex items-start justify-between gap-2 text-[11px]">
      <span className="shrink-0 text-slate-500">{k}</span>
      <span className="truncate text-right text-slate-300">{v}</span>
    </div>
  );
}

function uptimeLabel(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) {
    return "–";
  }
  const mins = Math.floor(seconds / 60);
  const hours = Math.floor(mins / 60);
  return `${hours}u ${mins % 60}m`;
}

function boolLabel(value: boolean | null | undefined, yes: string, no: string): string {
  if (value === null || value === undefined) {
    return "onbekend";
  }
  return value ? yes : no;
}

function gpuSourceLabel(source: "lspci" | "shell" | null): string {
  if (source === "shell") {
    return "webview (shell)";
  }
  if (source === "lspci") {
    return "lspci (server)";
  }
  return "onbekend";
}

function fmtNullable(value: number | null): string {
  if (value === null || value === undefined) {
    return "onbekend";
  }
  return String(value);
}

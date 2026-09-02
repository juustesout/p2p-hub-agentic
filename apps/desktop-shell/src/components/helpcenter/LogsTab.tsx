import { useCallback, useEffect, useState } from "react";
import type {
  DiagnosticsLevelName,
  DiagnosticsRecordView,
  DiagnosticsSourceInfo,
} from "../../types";
import { coreBridge } from "../../services/core-bridge";
import {
  displayRecord,
  filterRecords,
  levelMeta,
  VIEW_LEVEL_OPTIONS,
} from "./logic";
import {
  Eye,
  EyeOff,
  Loader2,
  Lock,
  RefreshCw,
  ScrollText,
  Search,
} from "lucide-react";

const POLL_MS = 2_500;
const TAIL_LIMIT = 200;

/**
 * The Logs tab of the HelpCenter (Pijler C / Brief 7C): a source register with
 * per-source enable/disable toggles on the left, the redacted log viewer on
 * the right, and the explicit power-user "toon ongeredacteerd" exception on
 * top of the viewer.
 *
 * Display-time redaction invariant: every line is passed through the shared
 * SDK filter again (`displayRecord`, masked) before rendering — never shown
 * straight from the API. The only path to raw output is the power-user toggle,
 * which is armed by an explicit click and flagged by a persistent red banner.
 */
export function LogsTab({ requestedSourceId }: { requestedSourceId: string | null }) {
  const [sources, setSources] = useState<DiagnosticsSourceInfo[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [records, setRecords] = useState<DiagnosticsRecordView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [powerUser, setPowerUser] = useState(false);
  const [minLevel, setMinLevel] = useState<DiagnosticsLevelName>("debug");
  const [query, setQuery] = useState("");

  // A nav request may steer this tab to a specific source while the window is
  // already open — follow it (and pick a sensible default otherwise).
  useEffect(() => {
    if (requestedSourceId) {
      setSelectedId(requestedSourceId);
    }
  }, [requestedSourceId]);

  const loadRegister = useCallback(async () => {
    try {
      const res = await coreBridge.diagnosticsLogs();
      setSources(res.sources);
      setError(null);
      setSelectedId((prev) => {
        if (prev && res.sources.some((s) => s.id === prev)) {
          return prev;
        }
        const first = res.sources.find((s) => s.enabled) ?? res.sources[0];
        return first ? first.id : null;
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  const loadRecords = useCallback(async () => {
    if (!selectedId) {
      return;
    }
    setRefreshing(true);
    try {
      const res = await coreBridge.diagnosticsLogs({
        source: selectedId,
        limit: TAIL_LIMIT,
        unredacted: powerUser,
      });
      setRecords(res.records[selectedId] ?? []);
      if (res.sources.length > 0) {
        setSources(res.sources);
      }
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRefreshing(false);
      setLoading(false);
    }
  }, [selectedId, powerUser]);

  useEffect(() => {
    void loadRegister();
  }, [loadRegister]);

  useEffect(() => {
    void loadRecords();
  }, [loadRecords]);

  // Poll while visible; pausing on hidden tabs keeps a stray timer from
  // hammering the bridge in the background.
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "hidden") {
        void loadRecords();
      }
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [loadRecords]);

  const toggleSource = async (source: DiagnosticsSourceInfo, enabled: boolean) => {
    if (source.secure) {
      return;
    }
    // Optimistic flip; the register reload reconciles any server refusal.
    setSources((prev) =>
      prev.map((s) => (s.id === source.id ? { ...s, enabled } : s)),
    );
    try {
      await coreBridge.diagnosticsSetSourceEnabled(source.id, enabled);
      void loadRegister();
    } catch {
      void loadRegister();
    }
  };

  const selected = sources.find((s) => s.id === selectedId) ?? null;
  const visible = filterRecords(records, { minLevel, query });

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex min-h-0 flex-1 overflow-hidden">
        {/* Source register */}
        <aside className="w-64 shrink-0 space-y-1 overflow-y-auto border-r border-white/10 p-3">
          <p className="px-1 pb-1 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
            Logbronnen
          </p>
          {loading && sources.length === 0 ? (
            <p className="flex items-center gap-2 px-1 py-2 text-xs text-slate-500">
              <Loader2 size={12} className="animate-spin" /> register laden…
            </p>
          ) : (
            sources.map((source) => {
              const active = source.id === selectedId;
              const chip = levelMeta(source.level);
              return (
                <div
                  key={source.id}
                  className={`rounded-lg border px-2 py-1.5 ${
                    active
                      ? "border-sky-500/40 bg-sky-500/10"
                      : "border-white/5 bg-white/[0.03]"
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => setSelectedId(source.id)}
                    className="flex w-full items-center gap-2 text-left"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-xs font-medium text-slate-200">
                        {source.name}
                      </span>
                      <span className="block truncate text-[10px] text-slate-500">
                        {source.id} · {source.kind}
                      </span>
                    </span>
                    <span className={`rounded px-1.5 py-0.5 text-[9px] font-semibold ${chip.chip}`}>
                      {chip.label}
                    </span>
                  </button>
                  <div className="mt-1 flex items-center justify-between">
                    <span className="text-[10px] text-slate-600">
                      {source.enabled ? `${source.length}/${source.capacity}` : "uit"}
                    </span>
                    {source.secure ? (
                      <span
                        title="Beveiligde bron — kan niet worden uitgeschakeld"
                        className="flex items-center gap-1 text-[10px] text-amber-300/80"
                      >
                        <Lock size={10} /> beveiligd
                      </span>
                    ) : (
                      <button
                        type="button"
                        role="switch"
                        aria-checked={source.enabled}
                        aria-label={`${source.name} aan/uit`}
                        onClick={() => toggleSource(source, !source.enabled)}
                        className={`relative h-4 w-8 rounded-full transition-colors ${
                          source.enabled ? "bg-sky-500" : "bg-slate-700"
                        }`}
                      >
                        <span
                          className={`absolute top-0.5 h-3 w-3 rounded-full bg-white transition-all ${
                            source.enabled ? "left-[18px]" : "left-0.5"
                          }`}
                        />
                      </button>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </aside>

        {/* Viewer */}
        <section className="flex min-w-0 flex-1 flex-col">
          {/* Viewer header */}
          <div className="flex flex-wrap items-center gap-2 border-b border-white/10 px-3 py-2">
            <ScrollText size={14} className="text-slate-500" />
            <p className="min-w-0 flex-1 truncate text-xs text-slate-300">
              {selected ? selected.name : "Geen bron geselecteerd"}
              <span className="ml-2 text-slate-600">
                {selected ? `#${selected.id}` : ""}
              </span>
            </p>
            <select
              value={minLevel}
              onChange={(e) => setMinLevel(e.target.value as DiagnosticsLevelName)}
              aria-label="Minimum niveau"
              className="rounded-md border border-white/10 bg-slate-800/80 px-1.5 py-1 text-[11px] text-slate-300 outline-none"
            >
              {VIEW_LEVEL_OPTIONS.map((level) => (
                <option key={level} value={level}>
                  ≥ {level}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => void loadRecords()}
              className="rounded-md p-1.5 text-slate-400 hover:bg-white/10"
              title="Verversen"
              aria-label="Verversen"
            >
              <RefreshCw size={14} className={refreshing ? "animate-spin" : ""} />
            </button>
          </div>

          {/* Filter + power-user toggle */}
          <div className="flex items-center gap-2 border-b border-white/10 px-3 py-2">
            <div className="flex min-w-0 flex-1 items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-2 py-1">
              <Search size={12} className="shrink-0 text-slate-500" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Filteren op tekst…"
                className="w-full bg-transparent text-xs text-slate-100 placeholder-slate-500 outline-none"
              />
            </div>
            <button
              type="button"
              onClick={() => {
                setPowerUser((v) => !v);
              }}
              className={`flex shrink-0 items-center gap-1.5 rounded-lg px-2.5 py-1 text-[11px] font-medium transition-colors ${
                powerUser
                  ? "bg-red-500/20 text-red-300"
                  : "border border-white/10 bg-white/5 text-slate-400 hover:bg-white/10"
              }`}
              title="Toon ongeredacteerd (alleen voor jezelf, niet delen)"
            >
              {powerUser ? <EyeOff size={12} /> : <Eye size={12} />}
              {powerUser ? "Geredigeerd" : "Ongeredacteerd"}
            </button>
          </div>

          {powerUser && (
            <div className="border-b border-red-500/30 bg-red-500/10 px-3 py-1.5 text-[11px] font-medium text-red-300">
              Ongeredacteerde weergave — alleen voor jezelf, niet delen. Bundels en
              export blijven altijd geredigeerd.
            </div>
          )}

          {/* Records */}
          <div className="min-h-0 flex-1 overflow-y-auto p-2 font-mono text-[11px] leading-relaxed">
            {error && (
              <p className="px-2 py-1 text-amber-300/90">Kon logs niet laden: {error}</p>
            )}
            {!error && loading && records.length === 0 && (
              <p className="flex items-center gap-2 px-2 py-1 text-slate-500">
                <Loader2 size={12} className="animate-spin" /> regels laden…
              </p>
            )}
            {!error && !loading && selected && visible.length === 0 && (
              <p className="px-2 py-1 text-slate-500">Geen regels voor deze bron.</p>
            )}
            {!error && !loading && !selected && (
              <p className="px-2 py-1 text-slate-500">Geen logbron beschikbaar.</p>
            )}
            {visible.map((record, index) => {
              const view = displayRecord(record, { masked: !powerUser });
              const meta = levelMeta(view.level);
              return (
                <div
                  key={`${record.time}-${record.module}-${index}`}
                  className="flex gap-2 border-b border-white/[0.04] px-2 py-1 hover:bg-white/[0.03]"
                >
                  <span className="shrink-0 text-slate-600">{view.time}</span>
                  <span className={`w-8 shrink-0 font-semibold ${meta.color}`}>
                    {meta.label}
                  </span>
                  <span className="w-40 shrink-0 truncate text-slate-500">
                    {view.module}
                  </span>
                  <span className="min-w-0 flex-1 whitespace-pre-wrap text-slate-300">
                    {view.msg}
                  </span>
                </div>
              );
            })}
          </div>
        </section>
      </div>
    </div>
  );
}

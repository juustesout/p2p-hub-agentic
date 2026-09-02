import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ChatMessageRecordView,
  HelpSupportInfo,
} from "../../types";
import { coreBridge } from "../../services/core-bridge";
import {
  bundleAsChatText,
  chatCapText,
  classifyMessage,
  SUPPORT_CHAT_MAX_LENGTH,
} from "./support";
import {
  AlertTriangle,
  ClipboardPaste,
  Headset,
  Loader2,
  Send,
  ShieldCheck,
} from "lucide-react";

const POLL_INTERVAL_MS = 5_000;

function fmtTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    return "";
  }
  return d.toLocaleTimeString("nl-NL", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * The "Chat met ons" tab (Brief 7D): a 1-op-1 chat with the baked-in support
 * contact over the existing chat plugin (sendMessage/getThread over the
 * token-gated local bridge — the chat skills are httpBridgeOnly). When no
 * support identity is configured the tab fails closed with an explanation
 * instead of addressing nobody.
 */
export function SupportChatTab() {
  const [support, setSupport] = useState<HelpSupportInfo | null>(null);
  const [supportError, setSupportError] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessageRecordView[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [hasBundle, setHasBundle] = useState(false);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    void coreBridge
      .helpSupport()
      .then((info) => {
        if (!cancelled) {
          setSupport(info);
          setHasBundle(bundleAsChatText() !== null);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setSupportError(err instanceof Error ? err.message : String(err));
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const refreshThread = useCallback(async (peerId: string) => {
    try {
      const thread = await coreBridge.chatThread(peerId);
      setMessages(thread);
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const configuredPeerId = support?.configured ? (support.peerId ?? null) : null;

  useEffect(() => {
    if (!configuredPeerId) {
      return;
    }
    void refreshThread(configuredPeerId);
    const timer = window.setInterval(() => void refreshThread(configuredPeerId), POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [configuredPeerId, refreshThread]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [messages.length, messages[messages.length - 1]?.text]);

  const send = async () => {
    const raw = draft.trim();
    if (!raw || !configuredPeerId || busy) {
      return;
    }
    const capped = chatCapText(raw);
    if (capped.truncated) {
      setNotice("Het bericht was langer dan het chatlimiet en is afgekapt.");
    } else {
      setNotice(null);
    }
    setBusy(true);
    setLoadError(null);
    try {
      await coreBridge.chatSendMessage(configuredPeerId, capped.text);
      setDraft("");
      await refreshThread(configuredPeerId);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const pasteBundle = () => {
    const bundle = bundleAsChatText();
    if (!bundle) {
      setNotice("Maak eerst een diagnose-bundel in het tabblad Diagnose.");
      return;
    }
    if (bundle.truncated) {
      setNotice("De bundel was langer dan het chatlimiet en is afgekapt.");
    } else {
      setNotice("Diagnose-bundel toegevoegd. Verstuur hem om de helpdesk te laten kijken.");
    }
    setDraft(bundle.text);
  };

  if (supportError) {
    return (
      <Centered>
        <AlertTriangle size={26} className="text-amber-400/70" />
        <p className="max-w-sm text-center text-xs leading-relaxed text-slate-400">
          De chat is niet beschikbaar: {supportError}
        </p>
      </Centered>
    );
  }

  if (!support) {
    return (
      <Centered>
        <Loader2 size={22} className="animate-spin text-sky-400" />
        <p className="text-xs text-slate-500">Support-contact laden…</p>
      </Centered>
    );
  }

  if (!support || !support.configured || !support.peerId) {
    return (
      <Centered>
        <Headset size={26} className="text-sky-500/40" />
        <p className="max-w-md text-center text-xs leading-relaxed text-slate-400">
          Deze app heeft nog geen support-contact ingesteld. Een beheerder kan
          dit doen door het peerId van de helpdesk in te stellen
          (<span className="font-mono text-slate-500">P2P_HUB_SUPPORT_PEER_ID</span>).
          Pas daarna is "Chat met ons" beschikbaar.
        </p>
      </Centered>
    );
  }

  const peerId = support.peerId;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-white/10 px-4 py-2.5">
        <Headset size={14} className="text-sky-400" />
        <span className="text-sm font-medium text-slate-200">{support.displayName}</span>
        <span className="ml-auto rounded-full border border-white/10 bg-white/5 px-2 py-0.5 text-[10px] uppercase tracking-wider text-slate-500">
          Reactie kan even duren
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {messages.length === 0 && !loadError ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
            <p className="max-w-sm text-xs leading-relaxed text-slate-500">
              Nog geen berichten. Maak in het tabblad <b>Diagnose</b> een bundel
              en verstuur die hier — de bundel is altijd afgeschermd.
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {messages.map((m, i) => (
              <MessageBubble key={`${m.sentAt}-${i}`} record={m} threadPeerId={peerId} />
            ))}
            <div ref={bottomRef} />
          </div>
        )}
        {loadError && (
          <p className="mt-2 flex items-center gap-1.5 text-[11px] text-amber-400/80">
            <AlertTriangle size={12} />
            {loadError}
          </p>
        )}
      </div>

      <div className="shrink-0 border-t border-white/10 p-3">
        {notice && <p className="mb-2 text-[11px] text-slate-500">{notice}</p>}
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
          placeholder={`Bericht naar ${support.displayName}…`}
          rows={3}
          className="w-full resize-none rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-slate-100 placeholder-slate-500 outline-none focus:border-sky-500/40"
        />
        <div className="mt-2 flex items-center gap-2">
          <span className={`text-[10px] ${draft.length > SUPPORT_CHAT_MAX_LENGTH ? "text-amber-400" : "text-slate-600"}`}>
            {draft.length.toLocaleString("nl-NL")}/{SUPPORT_CHAT_MAX_LENGTH.toLocaleString("nl-NL")}
          </span>
          <button
            type="button"
            onClick={pasteBundle}
            className="ml-auto flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-2.5 py-1.5 text-xs text-slate-300 hover:bg-white/10"
          >
            <ClipboardPaste size={13} />
            {hasBundle ? "Plak laatste bundel" : "Plak bundel (nog geen)"}
          </button>
          <button
            type="button"
            onClick={() => void send()}
            disabled={!draft.trim() || busy}
            className="flex items-center gap-1.5 rounded-lg bg-sky-500 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-sky-400 disabled:opacity-40"
          >
            {busy ? <Loader2 size={13} className="animate-spin" /> : <Send size={13} />}
            Verstuur
          </button>
        </div>
      </div>
    </div>
  );
}

function MessageBubble({
  record,
  threadPeerId,
}: {
  record: ChatMessageRecordView;
  threadPeerId: string;
}) {
  const kind = classifyMessage(record, threadPeerId);
  if (kind === "other") {
    return null;
  }
  const mine = kind === "you";
  return (
    <div className={`flex ${mine ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[75%] rounded-2xl px-3 py-2 text-sm ${
          mine
            ? "rounded-br-sm bg-sky-500/20 text-slate-100"
            : "rounded-bl-sm border border-white/10 bg-white/[0.04] text-slate-200"
        }`}
      >
        <p className="whitespace-pre-wrap break-words leading-relaxed">{record.text}</p>
        <div className="mt-1 flex items-center justify-end gap-1.5 text-[10px] text-slate-500">
          <span>{fmtTime(record.sentAt)}</span>
          {mine && <ShieldCheck size={11} className="text-sky-400/70" />}
          {!mine && record.verified && (
            <span className="flex items-center gap-1 text-emerald-400/80">
              <ShieldCheck size={11} /> geverifieerd
            </span>
          )}
          {!mine && !record.verified && (
            <span className="flex items-center gap-1 text-amber-400/80">
              <AlertTriangle size={11} /> niet geverifieerd
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6">
      {children}
    </div>
  );
}

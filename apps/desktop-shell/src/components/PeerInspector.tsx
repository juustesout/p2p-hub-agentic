import { useCallback, useEffect, useMemo, useState } from "react";
import { useApp } from "../state/AppState";
import type { RemotePeer } from "../types";
import {
  Activity,
  ChevronDown,
  ChevronRight,
  Network,
  RefreshCw,
  Server,
  ShieldCheck,
} from "lucide-react";

export type ContactTrustState = "pending" | "verified" | "blocked";

export interface ContactRecord {
  peerId: string;
  publicKeyHex: string;
  displayName: string;
  addedAt: string;
  trustState: ContactTrustState;
  lastVerifiedAt?: string;
}

export function PeerInspector() {
  const { capabilities, execute } = useApp();
  const peers = capabilities?.remote.peers ?? [];
  const skills = capabilities?.local.skills ?? [];
  const plugins = capabilities?.local.plugins ?? [];
  const events = capabilities?.local.events ?? [];

  const [contacts, setContacts] = useState<ContactRecord[]>([]);
  const [contactsError, setContactsError] = useState<string | null>(null);
  const [busyPeer, setBusyPeer] = useState<string | null>(null);
  const [busyContact, setBusyContact] = useState<string | null>(null);

  const refreshContacts = useCallback(async () => {
    const res = await execute({ serviceId: "contacts", method: "listContacts" });
    if (res.status === "ok") {
      setContacts(Array.isArray(res.result) ? (res.result as ContactRecord[]) : []);
      setContactsError(null);
    } else {
      setContactsError(res.error ?? "Could not list contacts.");
    }
  }, [execute]);

  useEffect(() => {
    void refreshContacts();
  }, [refreshContacts]);

  const contactByPeerId = useMemo(
    () => new Map(contacts.map((c) => [c.peerId, c])),
    [contacts],
  );

  const runContact = useCallback(
    async (method: string, args: unknown, setBusy: (id: string | null) => void) => {
      const peerId = (args as { peerId: string }).peerId;
      setBusy(peerId);
      try {
        await execute({ serviceId: "contacts", method, arguments: args });
      } finally {
        setBusy(null);
        await refreshContacts();
      }
    },
    [execute, refreshContacts],
  );

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto p-4 text-sm">
      <header>
        <h2 className="flex items-center gap-2 text-base font-semibold text-slate-100">
          <Network size={18} className="text-sky-400" />
          Peer & Capability Inspector
        </h2>
        <p className="mt-1 text-xs text-slate-400">
          Discovered P2P peers, your contact book, and the local capability
          surface.
        </p>
      </header>

      <section>
        <h3 className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-slate-500">
          Contacts ({contacts.length})
          <button
            onClick={() => void refreshContacts()}
            className="rounded p-0.5 text-slate-400 hover:bg-white/10 hover:text-slate-200"
            aria-label="Refresh contacts"
          >
            <RefreshCw size={12} />
          </button>
        </h3>
        {contactsError && (
          <p className="mb-2 rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-xs text-red-300">
            {contactsError}
          </p>
        )}
        {contacts.length === 0 && !contactsError && (
          <p className="rounded-xl border border-dashed border-white/10 px-4 py-6 text-center text-xs text-slate-500">
            No contacts yet. Discover a peer below and click “Add contact”, then
            verify it to prove it really owns its peerId.
          </p>
        )}
        <div className="flex flex-col gap-2">
          {contacts.map((contact) => (
            <ContactCard
              key={contact.peerId}
              contact={contact}
              busy={busyContact === contact.peerId}
              onVerify={() =>
                void runContact(
                  "verifyPeer",
                  { peerId: contact.peerId },
                  setBusyContact,
                )
              }
              onBlock={() =>
                void runContact(
                  "blockContact",
                  { peerId: contact.peerId },
                  setBusyContact,
                )
              }
              onUnblock={() =>
                void runContact(
                  "unblockContact",
                  { peerId: contact.peerId },
                  setBusyContact,
                )
              }
              onRemove={() =>
                void runContact(
                  "removeContact",
                  { peerId: contact.peerId },
                  setBusyContact,
                )
              }
            />
          ))}
        </div>
      </section>

      <section>
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-500">
          Remote peers ({peers.length})
        </h3>
        {peers.length === 0 && (
          <p className="rounded-xl border border-dashed border-white/10 px-4 py-6 text-center text-xs text-slate-500">
            No peers discovered. Peers appear here via mDNS discovery once they
            advertise compatible skills on the LAN.
          </p>
        )}
        <div className="flex flex-col gap-2">
          {peers.map((peer) => (
            <PeerCard
              key={peer.id}
              peer={peer}
              contact={peer.peerId ? contactByPeerId.get(peer.peerId) : undefined}
              busy={busyPeer === (peer.peerId ?? peer.id)}
              onAddContact={(name) =>
                void runContact(
                  "addContact",
                  { peerId: peer.peerId, publicKeyHex: peer.peerId, displayName: name },
                  setBusyPeer,
                )
              }
            />
          ))}
        </div>
      </section>

      <section>
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-500">
          Local plugins ({plugins.length})
        </h3>
        <div className="flex flex-col gap-2">
          {plugins.map((plugin) => (
            <div
              key={plugin.id}
              className="rounded-xl border border-white/10 bg-white/5 px-4 py-3"
            >
              <div className="flex items-center justify-between">
                <span className="flex items-center gap-2 font-medium text-slate-200">
                  <Server size={14} className="text-sky-400" />
                  {plugin.name}
                </span>
                <span className="text-[10px] text-slate-500">
                  {plugin.kind} · v{plugin.version}
                </span>
              </div>
              <div className="mt-2 flex flex-wrap gap-1">
                {skills
                  .filter((s) => s.pluginId === plugin.id)
                  .map((s) => (
                    <span
                      key={s.skill}
                      className={`rounded-md px-2 py-0.5 text-[11px] ${
                        s.localOnly
                          ? "bg-slate-700/60 text-slate-300"
                          : "bg-emerald-500/20 text-emerald-300"
                      }`}
                    >
                      {s.skill}
                    </span>
                  ))}
              </div>
            </div>
          ))}
        </div>
      </section>

      <section>
        <h3 className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-slate-500">
          <Activity size={12} />
          Exposed events
        </h3>
        <div className="flex flex-wrap gap-1">
          {events.map((event) => (
            <span
              key={event}
              className="rounded-md bg-white/5 px-2 py-0.5 font-mono text-[11px] text-sky-200"
            >
              {event}
            </span>
          ))}
        </div>
      </section>
    </div>
  );
}

const TRUST_BADGE: Record<
  ContactTrustState,
  { label: string; className: string }
> = {
  pending: { label: "pending", className: "bg-amber-500/20 text-amber-300" },
  verified: { label: "verified", className: "bg-emerald-500/20 text-emerald-300" },
  blocked: { label: "blocked", className: "bg-red-500/20 text-red-300" },
};

function ActionButton({
  label,
  onClick,
  disabled,
  className = "",
  ariaLabel,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  className?: string;
  ariaLabel?: string;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      aria-label={ariaLabel ?? label}
      className={`rounded-md border border-white/10 bg-white/5 px-2 py-0.5 text-[11px] text-slate-300 hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40 ${className}`}
    >
      {label}
    </button>
  );
}

function ContactCard({
  contact,
  busy,
  onVerify,
  onBlock,
  onUnblock,
  onRemove,
}: {
  contact: ContactRecord;
  busy: boolean;
  onVerify: () => void;
  onBlock: () => void;
  onUnblock: () => void;
  onRemove: () => void;
}) {
  const badge = TRUST_BADGE[contact.trustState] ?? TRUST_BADGE.pending;
  return (
    <div className="flex items-center justify-between gap-2 rounded-xl border border-white/10 bg-white/5 px-4 py-3">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="truncate font-medium text-slate-200">
            {contact.displayName}
          </span>
          <span className={`rounded-md px-2 py-0.5 text-[10px] ${badge.className}`}>
            {badge.label}
          </span>
        </div>
        <p className="truncate font-mono text-[11px] text-slate-500">
          {contact.peerId.slice(0, 16)}…{contact.peerId.slice(-8)}
        </p>
      </div>
      <div className="flex shrink-0 flex-wrap justify-end gap-1">
        {contact.trustState !== "blocked" && (
          <ActionButton
            label="Verify"
            ariaLabel={`Verify ${contact.displayName}`}
            onClick={onVerify}
            disabled={busy}
          />
        )}
        {contact.trustState !== "blocked" ? (
          <ActionButton
            label="Block"
            ariaLabel={`Block ${contact.displayName}`}
            onClick={onBlock}
            disabled={busy}
          />
        ) : (
          <ActionButton
            label="Unblock"
            ariaLabel={`Unblock ${contact.displayName}`}
            onClick={onUnblock}
            disabled={busy}
          />
        )}
        <ActionButton
          label="Remove"
          ariaLabel={`Remove ${contact.displayName}`}
          onClick={onRemove}
          disabled={busy}
        />
      </div>
    </div>
  );
}

function PeerCard({
  peer,
  contact,
  busy,
  onAddContact,
}: {
  peer: RemotePeer;
  contact?: ContactRecord;
  busy: boolean;
  onAddContact: (name: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const isContact = contact !== undefined;
  return (
    <div className="rounded-xl border border-white/10 bg-white/5 px-4 py-3">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between text-left"
      >
        <div className="flex items-center gap-2">
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          <span className="font-medium text-slate-200">{peer.name}</span>
        </div>
        <span className="flex items-center gap-1 text-[10px] text-slate-500">
          {isContact ? (
            <span
              className={`rounded-md px-2 py-0.5 ${
                TRUST_BADGE[contact!.trustState]?.className ?? "bg-slate-700/60 text-slate-300"
              }`}
            >
              contact · {contact!.trustState}
            </span>
          ) : (
            <span className="flex items-center gap-1">
              <ShieldCheck size={12} className="text-emerald-400" />
              {peer.trust}
            </span>
          )}
        </span>
      </button>
      <div className="mt-1 flex items-center justify-between gap-2 pl-6">
        <span className="truncate font-mono text-xs text-slate-500">
          {peer.address}
        </span>
        {peer.peerId && !isContact && (
          <ActionButton
            label="Add contact"
            ariaLabel={`Add ${peer.name} as contact`}
            onClick={() => onAddContact(peer.name)}
            disabled={busy}
          />
        )}
      </div>
      {open && (
        <div className="mt-2 pl-6">
          <p className="mb-1 text-[10px] uppercase tracking-wider text-slate-500">
            Transport
          </p>
          <p className="text-xs text-slate-300">{peer.transport}</p>
          {peer.peerId && (
            <>
              <p className="mb-1 mt-2 text-[10px] uppercase tracking-wider text-slate-500">
                Peer id
              </p>
              <p className="break-all font-mono text-[11px] text-slate-400">
                {peer.peerId}
              </p>
            </>
          )}
          <p className="mb-1 mt-2 text-[10px] uppercase tracking-wider text-slate-500">
            Advertised skills
          </p>
          <div className="flex flex-wrap gap-1">
            {peer.skills.map((skill) => (
              <span
                key={skill}
                className="rounded-md bg-white/10 px-2 py-0.5 font-mono text-[11px] text-sky-200"
              >
                {skill}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}


import * as http from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { validateObjectDepth } from "@p2p-hub/sdk";
import type { PluginHost } from "@p2p-hub/core";
import { DEFAULT_BRIDGED_EVENTS } from "./routes/helpers";

/** Options for the WebSocket activity bus. */
export interface WsActivityBusOptions {
  server: http.Server;
  path: string;
  maxPayload: number;
  isAuthorized(request: http.IncomingMessage): boolean;
}

/**
 * The WebSocket activity bus: authenticated `/ws` clients receive every
 * `broadcast` payload. Authorization accepts the `Authorization` header or
 * the `?token=` query string (the browser WebSocket API cannot set headers;
 * see `isAuthorizedWs` in the CoreServer for the accepted-risk rationale).
 */
export class WsActivityBus {
  private readonly wss: WebSocketServer;
  private readonly clients = new Set<WebSocket>();

  constructor(options: WsActivityBusOptions) {
    this.wss = new WebSocketServer({
      server: options.server,
      path: options.path,
      maxPayload: options.maxPayload,
    });
    this.wss.on("connection", (socket, request) =>
      this.handleSocket(socket, request, options.isAuthorized),
    );
  }

  private handleSocket(
    socket: WebSocket,
    request: http.IncomingMessage,
    isAuthorized: (request: http.IncomingMessage) => boolean,
  ): void {
    if (!isAuthorized(request)) {
      socket.close(1008, "unauthorized");
      return;
    }
    this.clients.add(socket);
    socket.on("message", (data) => {
      try {
        const message = JSON.parse(data.toString()) as {
          type?: string;
          ts?: number;
        };
        validateObjectDepth(message);
        if (message.type === "ping") {
          socket.send(
            JSON.stringify({ type: "pong", ts: message.ts ?? Date.now() }),
          );
        }
      } catch {
        // Ignore malformed client frames.
      }
    });
    socket.on("close", () => this.clients.delete(socket));
    socket.on("error", () => this.clients.delete(socket));
  }

  broadcast(event: string, payload: unknown): void {
    const message = JSON.stringify({
      type: "event",
      event,
      payload,
      ts: Date.now(),
    });
    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    }
  }

  close(): void {
    for (const client of this.clients) {
      client.close();
    }
    this.clients.clear();
    this.wss.close();
  }
}

/**
 * Bridge hook events to the activity bus. The default set is the manifest
 * `exposedEvents` of every plugin plus `DEFAULT_BRIDGED_EVENTS`; the caller
 * can add its own via `options.bridgedEvents`.
 */
export function wireEventBridge(
  host: PluginHost,
  broadcast: (event: string, payload: unknown) => void,
  extraEvents?: string[],
): void {
  const events = new Set<string>(DEFAULT_BRIDGED_EVENTS);
  for (const event of extraEvents ?? []) {
    events.add(event);
  }
  for (const plugin of host.listPlugins()) {
    for (const event of plugin.exposedEvents ?? []) {
      events.add(event);
    }
  }
  for (const event of events) {
    host.hookRegistry().on(event, (payload) => {
      broadcast(event, payload);
    });
  }
}

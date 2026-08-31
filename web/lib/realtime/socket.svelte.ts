import type { QueryClient } from "@tanstack/svelte-query";
import { streamUrl } from "../config";
import type { BusEnvelope } from "../../types";
import { applyEvent } from "./patch";

export type ConnectionStatus = "connecting" | "open" | "closed";

class Connection {
  status = $state<ConnectionStatus>("connecting");
  /** Epoch ms of the last message received, for a staleness hint in the header. */
  lastMessageAt = $state<number | null>(null);
}

export const connection = new Connection();

const MAX_BACKOFF_MS = 15_000;
const BASE_BACKOFF_MS = 500;

/**
 * Opens the single `/api/v1/stream` WebSocket and keeps it open with exponential backoff.
 * Every event is handed to `applyEvent`; on a *re*connect all queries are invalidated so the
 * cache catches up on whatever was missed. Returns a stop function for `$effect` cleanup.
 */
export function startRealtime(queryClient: QueryClient): () => void {
  let ws: WebSocket | null = null;
  let attempt = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let everConnected = false;
  let stopped = false;

  function scheduleReconnect(): void {
    if (stopped || reconnectTimer) return;
    const delay = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** attempt) + Math.random() * 250;
    attempt++;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      open();
    }, delay);
  }

  function open(): void {
    if (stopped) return;
    connection.status = "connecting";
    ws = new WebSocket(streamUrl());

    ws.onopen = () => {
      attempt = 0;
      connection.status = "open";
      if (everConnected) queryClient.invalidateQueries();
      everConnected = true;
    };

    ws.onmessage = (e: MessageEvent) => {
      connection.lastMessageAt = Date.now();
      let envelope: BusEnvelope;
      try {
        envelope = JSON.parse(String(e.data)) as BusEnvelope;
      } catch {
        return;
      }
      applyEvent(queryClient, envelope);
    };

    ws.onerror = () => ws?.close();
    ws.onclose = () => {
      connection.status = "closed";
      scheduleReconnect();
    };
  }

  open();

  return () => {
    stopped = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    ws?.close();
  };
}

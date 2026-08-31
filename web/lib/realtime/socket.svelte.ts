export type ConnectionStatus = "connecting" | "open" | "closed";

/**
 * Shared realtime connection state. W0 leaves this a placeholder ("connecting"); W1 wires it to
 * the real `/api/v1/stream` WebSocket with reconnect + backoff.
 */
class Connection {
  status = $state<ConnectionStatus>("connecting");
  /** Timestamp of the last message received, for a staleness hint in the UI. */
  lastMessageAt = $state<number | null>(null);
}

export const connection = new Connection();

import { useEffect, useMemo, useRef, useState } from "react";
import { ClientMessage, ClientView, ServerMessage } from "../../shared/types";

// Same-origin WebSocket. In dev, Vite proxies /ws to the Node server (see
// vite.config.ts); in production the Node server serves both the app and /ws.
function wsUrl(roomId: string) {
  const proto = window.location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${window.location.host}/ws?room=${encodeURIComponent(roomId)}`;
}

export interface Net {
  view: ClientView | null;
  error: string | null;
  connected: boolean;
  send: (msg: ClientMessage) => void;
  clearError: () => void;
}

export function useGame(roomId: string | null, name: string | null): Net {
  const [view, setView] = useState<ClientView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    if (!roomId || !name) return;

    let closed = false;
    let retry = 0;
    let reconnectTimer: ReturnType<typeof setTimeout>;

    const connect = () => {
      const ws = new WebSocket(wsUrl(roomId));
      wsRef.current = ws;

      ws.onopen = () => {
        retry = 0;
        setConnected(true);
        ws.send(JSON.stringify({ type: "join", name } satisfies ClientMessage));
      };
      ws.onmessage = (e) => {
        const msg = JSON.parse(e.data as string) as ServerMessage;
        if (msg.type === "view") setView(msg.view);
        else if (msg.type === "error") setError(msg.message);
      };
      ws.onclose = () => {
        setConnected(false);
        if (closed) return;
        retry += 1;
        const delay = Math.min(1000 * retry, 5000);
        reconnectTimer = setTimeout(connect, delay);
      };
      ws.onerror = () => ws.close();
    };

    connect();

    return () => {
      closed = true;
      clearTimeout(reconnectTimer);
      wsRef.current?.close();
    };
  }, [roomId, name]);

  return useMemo(
    () => ({
      view,
      error,
      connected,
      send: (msg: ClientMessage) => {
        const ws = wsRef.current;
        if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
      },
      clearError: () => setError(null),
    }),
    [view, error, connected],
  );
}

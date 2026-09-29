import { useEffect, useRef, useState } from "react";

export type StreamStatus = "connecting" | "live" | "reconnecting";

export interface ChangeEvent {
  prId?: string;
}

export function useChangeStream(onChange: (events: ChangeEvent[]) => void, debounceMs = 250) {
  const [status, setStatus] = useState<StreamStatus>("connecting");
  const handler = useRef(onChange);
  handler.current = onChange;

  useEffect(() => {
    let source: EventSource | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let pending: ChangeEvent[] = [];
    let disposed = false;

    const flush = () => {
      timer = null;
      const batch = pending;
      pending = [];
      if (batch.length) handler.current(batch);
    };

    const connect = () => {
      if (disposed) return;
      source = new EventSource("/api/events");
      source.onopen = () => setStatus("live");
      source.addEventListener("change", (event) => {
        let data: ChangeEvent = {};
        try {
          data = JSON.parse((event as MessageEvent<string>).data) as ChangeEvent;
        } catch {
          data = {};
        }
        pending.push(data);
        if (!timer) timer = setTimeout(flush, debounceMs);
      });
      source.onerror = () => {
        setStatus("reconnecting");
        pending.push({});
        if (!timer) timer = setTimeout(flush, debounceMs);
      };
    };

    connect();
    return () => {
      disposed = true;
      source?.close();
      if (timer) clearTimeout(timer);
    };
  }, [debounceMs]);

  return status;
}

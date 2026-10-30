// RPC access and race-safe async reads for the Graphite Stack app.
import { useCallback, useEffect, useRef, useState } from "react";
import { useRealtime, useRealtimeConnectionState, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../contract";
import { errorMessage } from "./model";

/**
 * Same value as `GRAPHITE_CHANGED` in contract.ts. The app keeps a copy so
 * that the bundle does not import the server contract at runtime.
 */
export const GRAPHITE_CHANGED_CHANNEL = "graphite-changed";

export function useGraphiteRpc() {
  return useRpc<typeof rpcContract>();
}
export type GraphiteRpc = ReturnType<typeof useGraphiteRpc>;

export interface Resource<T> {
  data: T | undefined;
  error: string | null;
  loading: boolean;
  /** Fetch again. Keeps the current data until the new result arrives. */
  reload: () => void;
  /** Replace data locally, for example with a write result. */
  set: (value: T) => void;
}

/**
 * Loads `fetcher()` when `key` changes, when `version` changes, or on
 * reload. Ignores every response except the newest, so a slow old request
 * never overwrites newer data. While `enabled` is false, no request runs; a
 * pending change runs when it becomes true again.
 */
export function useResource<T>(
  key: string | null,
  fetcher: () => Promise<T>,
  options: { enabled?: boolean; version?: number } = {},
): Resource<T> {
  const enabled = options.enabled ?? true;
  const version = options.version ?? 0;
  const [state, setState] = useState<{ key: string | null; data: T | undefined; error: string | null; loading: boolean }>({
    key: null,
    data: undefined,
    error: null,
    loading: key !== null,
  });
  const sequence = useRef(0);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const [nonce, setNonce] = useState(0);
  const loadedFor = useRef<string | null>(null);

  useEffect(() => {
    if (key === null) {
      sequence.current += 1;
      loadedFor.current = null;
      setState({ key: null, data: undefined, error: null, loading: false });
      return;
    }
    const want = `${key}#${version}#${nonce}`;
    if (!enabled || loadedFor.current === want) return;
    loadedFor.current = want;
    const id = ++sequence.current;
    setState((previous) => ({
      key,
      data: previous.key === key ? previous.data : undefined,
      error: previous.key === key ? previous.error : null,
      loading: true,
    }));
    fetcherRef.current().then(
      (data) => {
        if (id !== sequence.current) return;
        setState({ key, data, error: null, loading: false });
      },
      (cause: unknown) => {
        if (id !== sequence.current) return;
        setState((previous) => ({
          key,
          data: previous.key === key ? previous.data : undefined,
          error: errorMessage(cause),
          loading: false,
        }));
      },
    );
  }, [key, version, nonce, enabled]);

  const reload = useCallback(() => setNonce((value) => value + 1), []);
  const set = useCallback(
    (value: T) => {
      sequence.current += 1;
      setState({ key, data: value, error: null, loading: false });
    },
    [key],
  );
  const current = state.key === key;
  return {
    data: current ? state.data : undefined,
    error: current ? state.error : null,
    loading: key !== null && (!current || state.loading),
    reload,
    set,
  };
}

/** Minimum time between two realtime-driven reloads. */
export const REALTIME_MIN_INTERVAL_MS = 2000;

/**
 * A counter that increases after GRAPHITE_CHANGED for `repoKey` (or any repo
 * while the key is unknown) and after a realtime reconnect. Events collapse:
 * the counter increases at most once per REALTIME_MIN_INTERVAL_MS, so a
 * burst of signals (or a watcher that reacts to our own reads) cannot start
 * a read loop.
 */
export function useGraphiteVersion(repoKey: string | null): number {
  const [version, setVersion] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastBump = useRef(0);
  const repoRef = useRef(repoKey);
  repoRef.current = repoKey;
  const bump = useCallback(() => {
    if (timer.current !== null) return;
    const wait = Math.max(250, lastBump.current + REALTIME_MIN_INTERVAL_MS - Date.now());
    timer.current = setTimeout(() => {
      timer.current = null;
      lastBump.current = Date.now();
      setVersion((value) => value + 1);
    }, wait);
  }, []);
  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );
  useRealtime(GRAPHITE_CHANGED_CHANNEL, (payload: unknown) => {
    const changed =
      payload !== null && typeof payload === "object" && "repoKey" in payload
        ? (payload as { repoKey: unknown }).repoKey
        : null;
    if (repoRef.current === null || changed === null || changed === repoRef.current) bump();
  });
  const connection = useRealtimeConnectionState();
  const wasConnected = useRef(connection === "connected");
  useEffect(() => {
    if (connection === "connected") {
      if (!wasConnected.current) bump();
      wasConnected.current = true;
    } else {
      // Signals are not replayed. Reconcile on the next connect.
      wasConnected.current = false;
    }
  }, [connection, bump]);
  return version;
}

/**
 * Debounced persistence of a text value. Each scheduled value keeps the save
 * function of its own schedule call, so a later key change never writes old
 * text under a new key. `cancel` drops the queued value and waits for a
 * write in flight. A failed write keeps the value in the UI and does not
 * retry by itself.
 */
export function useDebouncedSave(
  save: (value: string) => Promise<unknown>,
  delayMs = 600,
): {
  schedule: (value: string) => void;
  flush: () => Promise<void>;
  cancel: () => Promise<void>;
  status: "idle" | "saving" | "saved" | "error";
  error: string | null;
} {
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef<{ value: string; save: (value: string) => Promise<unknown> } | null>(null);
  const inFlight = useRef<Promise<void> | null>(null);
  const mounted = useRef(true);
  const saveRef = useRef(save);
  saveRef.current = save;
  const clearTimer = () => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  };
  const flush = useCallback(async () => {
    clearTimer();
    const job = pending.current;
    pending.current = null;
    if (job === null) {
      await inFlight.current;
      return;
    }
    const previous = inFlight.current;
    const run = (async () => {
      await previous;
      if (mounted.current) setStatus("saving");
      try {
        await job.save(job.value);
        if (mounted.current) {
          setStatus("saved");
          setError(null);
        }
      } catch (cause) {
        if (mounted.current) {
          setStatus("error");
          setError(errorMessage(cause));
        }
      }
    })();
    inFlight.current = run;
    await run;
    if (inFlight.current === run) inFlight.current = null;
  }, []);
  const schedule = useCallback(
    (value: string) => {
      pending.current = { value, save: saveRef.current };
      clearTimer();
      timer.current = setTimeout(() => void flush(), delayMs);
    },
    [delayMs, flush],
  );
  const cancel = useCallback(async () => {
    clearTimer();
    pending.current = null;
    await inFlight.current;
  }, []);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      // Write the last queued value with the save function of its own key.
      if (pending.current !== null) void flush();
    };
  }, [flush]);
  return { schedule, flush, cancel, status, error };
}

/**
 * A text draft persisted with draftGet/draftSet under `key`. Edits are off
 * until the saved draft loads, so typing never overwrites a saved draft.
 */
export function useTextDraft(rpc: GraphiteRpc, key: string) {
  const [state, setState] = useState<{ key: string; value: string; loaded: boolean }>({ key, value: "", loaded: false });
  const saver = useDebouncedSave((value) => rpc.call("draftSet", { key, value: value === "" ? null : value }));
  useEffect(() => {
    let cancelled = false;
    setState({ key, value: "", loaded: false });
    rpc.call("draftGet", { key }).then(
      (result) => {
        if (!cancelled) setState({ key, value: result.value ?? "", loaded: true });
      },
      () => {
        if (!cancelled) setState({ key, value: "", loaded: true });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [rpc, key]);
  const current = state.key === key;
  const loaded = current && state.loaded;
  const setValue = useCallback(
    (value: string) => {
      setState((previous) => (previous.key === key && previous.loaded ? { ...previous, value } : previous));
      if (loaded) saver.schedule(value.trim() === "" ? "" : value);
    },
    [key, loaded, saver.schedule],
  );
  /** Drops queued saves, then deletes the stored draft. */
  const clear = useCallback(async () => {
    await saver.cancel();
    setState((previous) => (previous.key === key ? { ...previous, value: "" } : previous));
    await rpc.call("draftSet", { key, value: null }).catch(() => undefined);
  }, [rpc, key, saver.cancel]);
  return {
    value: current ? state.value : "",
    loaded,
    setValue,
    clear,
    flush: saver.flush,
    status: saver.status,
    error: saver.error,
  };
}

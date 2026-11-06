/**
 * Protocol parameters and the SOL/USD price, for the whole app.
 * - Parameters: chain mode reads the on-chain `Global` account (the admin console re-reads it after a change); demo
 *   mode uses the program defaults in lib/protocol.ts, since nothing is deployed.
 * - SOL/USD: chain mode polls a public price API every minute (lib/price.ts) and keeps the last good price, starting
 *   from the demo price until one answers. Demo mode keeps the fixed demo price, which the seeded data is built on.
 */
import { useConnection } from "@solana/wallet-adapter-react";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { isDemo } from "../config";
import { readOnlyProgram } from "../hooks/useParabullProgram";
import { DEFAULT_PARAMS, dexTargetUsd, globalView, paramsFromGlobal, type GlobalView, type ProtocolParams } from "../lib/protocolParams";
import { Pdas } from "../lib/pdas";
import { fetchSolUsd } from "../lib/price";
import { SOL_USD } from "../mock/coins";

export type GlobalStatus = "demo" | "loading" | "ready" | "missing" | "error";

export interface SolUsdState {
  price: number;
  /** The API that answered, or null while it's the fallback demo price. */
  source: string | null;
  at: number | null;
}

interface ProtocolValue {
  params: ProtocolParams;
  /** Chain mode: the decoded `Global` account once read; null in demo mode, before the read, or if it isn't there. */
  global: GlobalView | null;
  globalStatus: GlobalStatus;
  globalError: string | null;
  /** Re-read `Global` (after an admin change, say). Resolves to the new view. */
  refreshGlobal: () => Promise<GlobalView | null>;
  solUsd: SolUsdState;
  /** The DexScreener listing-fund target in USD at the current price. */
  dexTargetUsd: number;
}

const PRICE_POLL_MS = 60_000;
const Ctx = createContext<ProtocolValue | null>(null);

export function ProtocolProvider({ children }: { children: ReactNode }) {
  const { connection } = useConnection();
  const program = useMemo(() => readOnlyProgram(connection), [connection]);
  const [global, setGlobal] = useState<GlobalView | null>(null);
  const [globalStatus, setGlobalStatus] = useState<GlobalStatus>(isDemo ? "demo" : "loading");
  const [globalError, setGlobalError] = useState<string | null>(null);
  const [solUsd, setSolUsd] = useState<SolUsdState>({ price: SOL_USD, source: null, at: null });
  const latest = useRef(0);

  const refreshGlobal = useCallback(async () => {
    if (isDemo) return null;
    const call = ++latest.current;
    try {
      const raw = await program.account.global.fetchNullable(new Pdas(program.programId).global());
      const view = raw ? globalView(raw) : null;
      if (call === latest.current) {
        setGlobal(view);
        setGlobalStatus(view ? "ready" : "missing");
        setGlobalError(null);
      }
      return view;
    } catch (e) {
      if (call === latest.current) {
        setGlobalStatus("error");
        setGlobalError(e instanceof Error ? e.message : String(e));
      }
      throw e;
    }
  }, [program]);

  useEffect(() => {
    refreshGlobal().catch(() => undefined);
  }, [refreshGlobal]);

  useEffect(() => {
    if (isDemo) return;
    let live = true;
    const poll = () =>
      fetchSolUsd().then((q) => {
        if (live && q) setSolUsd({ price: q.price, source: q.source, at: Date.now() });
      });
    void poll();
    const id = window.setInterval(poll, PRICE_POLL_MS);
    return () => {
      live = false;
      window.clearInterval(id);
    };
  }, []);

  const value = useMemo<ProtocolValue>(() => {
    const params = global ? paramsFromGlobal(global) : DEFAULT_PARAMS;
    return { params, global, globalStatus, globalError, refreshGlobal, solUsd, dexTargetUsd: dexTargetUsd(params, solUsd.price) };
  }, [global, globalStatus, globalError, refreshGlobal, solUsd]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useProtocol(): ProtocolValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("useProtocol outside ProtocolProvider");
  return v;
}

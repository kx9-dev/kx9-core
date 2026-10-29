export const ASSETS = ["NVDA", "TSLA", "AAPL", "AMZN", "PLTR", "ETH", "USDC"] as const;
export type Asset = typeof ASSETS[number];
export type Mode = "supervised" | "autonomous" | "standby";
export type Tier = "observer" | "mk1" | "mk2" | "mk3";
export type Protocols = {
  accumulate: {on: boolean; asset: Asset; amount: number; every: "Daily" | "Weekly" | "Monthly"};
  balance: {on: boolean; target: "Growth 60/40" | "Balanced 40/60" | "Defensive 20/80"; drift: number};
  guard: {on: boolean; tp: number; sl: number};
  trend: {on: boolean; asset: Asset; size: number; window: number};
  physical: {on: boolean; amount: number; every: "Daily" | "Weekly" | "Monthly"; dip: number; dipAmount: number};
};
export type Limits = {maxTrade: number; dailyCap: number; slippage: number; cooldown: number; whitelist: Asset[]};
export type Entry = {id: string; at: string; role: string; event: string; text: string; asset: Asset | null; usd: number | null; txHash: string | null; validation: string; proposalId: string | null};
export type Check = {key: string; ok: boolean; detail: string};
export type Proposal = {
  id: string; agentId: number; protocol: keyof Protocols; side: "buy" | "sell"; asset: Asset;
  usd: number; qty: number | null; reason: string; stage: "risk" | "operator" | "veto" | "exec" | "done" | "failed" | "rejected";
  risk: {ok: boolean; slippageEst: number | null; checks: Check[]} | null; txHash: string | null;
  createdAt: string; expiresAt: string; amountIn?: string; minAmountOut?: string;
  reasonSource?: string; ruleFacts?: string; mark?: string;
};
export type Unit = {
  agentId: number; serial: string; operator: string; shield: string; class: Tier; mode: Mode; status: "online" | "unavailable";
  limits: Limits; usedToday: number; holdings: Partial<Record<Asset, number>>;
  cost: Partial<Record<Asset, number>>; lastRun: Record<string, number | string>; lastTradeAt: number;
  protocols: Protocols; logs: Entry[]; proposals: Proposal[]; equity: {at: string; value: number}[];
};
export type Account = {protocols: Protocols; units: Record<string, Unit>};
export const defaults = (): Protocols => ({
  accumulate: {on: false, asset: "ETH", amount: 100, every: "Daily"},
  balance: {on: false, target: "Growth 60/40", drift: 5},
  guard: {on: false, tp: 12, sl: 6},
  trend: {on: false, asset: "NVDA", size: 250, window: 20},
  physical: {on: false, amount: 150, every: "Weekly", dip: 5, dipAmount: 300},
});
export class CoreError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}
export function need(condition: unknown, status: number, code: string, message: string): asserts condition {
  if (!condition) throw new CoreError(status, code, message);
}

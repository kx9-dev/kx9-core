import { isAddress, getAddress } from "ethers";
import { ASSETS, CoreError, type Asset } from "./types";

function address(name: string) {
  const value = process.env[name]?.trim() || "";
  if (value && !isAddress(value)) throw new CoreError(503, "CONFIG_INVALID", `${name} must be a valid contract address.`);
  return value ? getAddress(value) : "";
}
function addresses(name: string): Partial<Record<Asset, string>> {
  const raw = process.env[name];
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    const entries = Object.entries(parsed);
    if (entries.some(([key, value]) => !ASSETS.includes(key as Asset) || typeof value !== "string" || !isAddress(value))) throw new Error();
    return Object.fromEntries(entries.map(([key, value]) => [key, getAddress(value as string)]));
  } catch { throw new CoreError(503, "CONFIG_INVALID", `${name} must map known asset symbols to valid addresses.`); }
}
export function coreConfig() {
  return {
    factory: address("FACTORY"), kx9Token: address("KX9_TOKEN"),
    router: address("ROUTER"), quoter: address("QUOTER"), sequencerFeed: address("SEQUENCER_FEED"),
    tokens: addresses("TOKENS"), feeds: addresses("FEEDS"),
    executionEnabled: process.env.ENABLE_LIVE_EXECUTION === "true",
  };
}
export function publicConfig() {
  const c = coreConfig();
  return {...c, chainId: 4663, api: "/api", rpc: "/api/rpc", explorer: "https://robinhoodchain.blockscout.com",
    classThresholds: thresholds(), executionEnabled: Boolean(c.executionEnabled && process.env.EXECUTOR_KEY && c.factory && c.router && c.quoter),
    affiliation: "KX-9 is not affiliated with NVIDIA Corporation or Robinhood Markets."};
}
export function thresholds(): Record<"mk1" | "mk2" | "mk3", number> {
  const raw = process.env.CLASS_THRESHOLDS;
  if (!raw) return {mk1: 0, mk2: 0, mk3: 0};
  try {
    const v = JSON.parse(raw);
    if (["mk1", "mk2", "mk3"].some(k => !Number.isFinite(v[k]) || v[k] <= 0) || !(v.mk1 < v.mk2 && v.mk2 < v.mk3)) throw new Error();
    return v;
  } catch { throw new CoreError(503, "CONFIG_INVALID", "CLASS_THRESHOLDS must contain increasing positive thresholds."); }
}

import { logger } from "./logger";

const EXPECTED_CHAIN = 4663;
type RpcStatus = {
  configured: boolean; connected: boolean; expectedChainId: number;
  chainId: number | null; latestBlock: string | null; blockTimeUTC: string | null;
  checkedAt: string; error: string | null;
};
class RpcFailure extends Error {
  constructor(public readonly safeCode: string) { super(safeCode); }
}
let active = 0;
export async function callMainnetRpc(method: string, params: unknown[] = []): Promise<unknown> {
  const endpoint = process.env.RPC_URL?.trim();
  if (!endpoint) throw new RpcFailure("RPC_NOT_CONFIGURED");
  let url: URL;
  try { url = new URL(endpoint); } catch { throw new RpcFailure("RPC_URL_INVALID"); }
  if (url.protocol !== "https:") throw new RpcFailure("RPC_HTTPS_REQUIRED");
  if (active >= 8) throw new RpcFailure("RPC_BUSY");
  active++;
  try {
    const response = await fetch(url, {
      method: "POST", redirect: "error",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({jsonrpc: "2.0", id: 1, method, params}),
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new RpcFailure(`RPC_HTTP_${response.status}`);
    const text = await response.text();
    if (text.length > 1_000_000) throw new RpcFailure("RPC_RESPONSE_TOO_LARGE");
    const payload = JSON.parse(text);
    if (payload.error) throw new RpcFailure("RPC_REQUEST_REJECTED");
    if (!Object.hasOwn(payload, "result")) throw new RpcFailure("RPC_INVALID_RESPONSE");
    return payload.result;
  } catch (error) {
    if (error instanceof RpcFailure) throw error;
    // Never forward fetch errors: their messages can contain credentialed URLs.
    const candidate = error as {name?: string; cause?: {code?: string}};
    const code = candidate.cause?.code;
    const safe = code === "EAI_AGAIN" || code === "ENOTFOUND" ? "RPC_DNS_UNAVAILABLE" :
      candidate.name === "TimeoutError" ? "RPC_TIMEOUT" :
      ["ENOTFOUND", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT"].includes(code || "") ? `RPC_${code}` :
      "RPC_CONNECTION_FAILED";
    throw new RpcFailure(safe);
  } finally { active--; }
}
export function rpcErrorCode(error: unknown): string {
  return error instanceof RpcFailure ? error.safeCode : "RPC_UNAVAILABLE";
}
let cached: {expires: number; value: RpcStatus} | undefined;
let pending: Promise<RpcStatus> | undefined;
export async function getMainnetStatus(): Promise<RpcStatus> {
  if (cached && cached.expires > Date.now()) return cached.value;
  if (pending) return pending;
  pending = (async () => {
    const status: RpcStatus = {
      configured: Boolean(process.env.RPC_URL?.trim()), connected: false,
      expectedChainId: EXPECTED_CHAIN, chainId: null, latestBlock: null,
      blockTimeUTC: null, checkedAt: new Date().toISOString(), error: null,
    };
    try {
      const id = await callMainnetRpc("eth_chainId");
      if (typeof id !== "string" || !/^0x[0-9a-f]+$/i.test(id)) throw new RpcFailure("RPC_INVALID_RESPONSE");
      status.chainId = Number(BigInt(id));
      if (status.chainId !== EXPECTED_CHAIN) throw new RpcFailure("RPC_WRONG_NETWORK");
      const block = await callMainnetRpc("eth_getBlockByNumber", ["latest", false]) as {number?: string; timestamp?: string} | null;
      if (!block?.number || !block.timestamp) throw new RpcFailure("RPC_INVALID_RESPONSE");
      const seconds = Number(BigInt(block.timestamp));
      status.latestBlock = BigInt(block.number).toString();
      status.blockTimeUTC = new Date(seconds * 1000).toISOString();
      if (Math.abs(Date.now() / 1000 - seconds) > 180) throw new RpcFailure("RPC_STALE_BLOCK");
      status.connected = true;
    } catch (error) {
      status.error = rpcErrorCode(error);
      logger.warn({event: "mainnet_rpc_unavailable", code: status.error}, "Mainnet RPC check failed");
    }
    cached = {expires: Date.now() + 15000, value: status};
    return status;
  })().finally(() => { pending = undefined; });
  return pending;
}

const address = (v: unknown) => typeof v === "string" && /^0x[0-9a-f]{40}$/i.test(v);
const hash = (v: unknown) => typeof v === "string" && /^0x[0-9a-f]{64}$/i.test(v);
const blockTag = (v: unknown) => ["latest", "safe", "finalized", "pending"].includes(String(v));
export function validRpcParams(method: string, params: unknown[]): boolean {
  if (["eth_chainId", "net_version", "eth_blockNumber", "eth_gasPrice", "eth_maxPriorityFeePerGas"].includes(method)) return params.length === 0;
  if (["eth_getBalance", "eth_getCode"].includes(method)) return params.length === 2 && address(params[0]) && blockTag(params[1]);
  if (["eth_getTransactionReceipt", "eth_getTransactionByHash"].includes(method)) return params.length === 1 && hash(params[0]);
  if (method === "eth_call") {
    const tx = params[0] as Record<string, unknown> | null;
    return params.length === 2 && !!tx && typeof tx === "object" &&
      Object.keys(tx).every(k => ["to", "from", "data", "gas"].includes(k)) &&
      address(tx.to) && (tx.from === undefined || address(tx.from)) &&
      (tx.data === undefined || (typeof tx.data === "string" && /^0x(?:[0-9a-f]{2}){0,4096}$/i.test(tx.data))) &&
      (tx.gas === undefined || (typeof tx.gas === "string" && /^0x[0-9a-f]{1,8}$/i.test(tx.gas) && BigInt(tx.gas) <= 1000000n)) &&
      blockTag(params[1]);
  }
  return false;
}

import { ethers } from "ethers";
import { getMainnetStatus } from "../lib/mainnet-rpc";
import { coreConfig, thresholds } from "./config";
import { ASSETS, need, type Asset, type Limits, type Mode, type Tier } from "./types";

export const ABI = {
  factory: ["function unitsOf(address) view returns(uint256[])", "function shieldOf(uint256) view returns(address)"],
  shield: [
    "function operator() view returns(address)", "function executor() view returns(address)",
    "function mode() view returns(uint8)", "function limits() view returns((uint256,uint256,uint16,uint32))",
    "function usedToday() view returns(uint256)", "function whitelisted(address) view returns(bool)",
    "function approvals(bytes32) view returns(uint256 maxUsd,uint64 deadline,bool used)",
    "function setMode(uint8)", "function setLimits((uint256,uint256,uint16,uint32))", "function setWhitelist(address,bool)",
    "function approveProposal(bytes32,uint256,uint64)",
    "function execute((bytes32,address,address,uint256,uint256,uint64),address,bytes) returns(uint256)",
  ],
  token: ["function balanceOf(address) view returns(uint256)", "function decimals() view returns(uint8)"],
  feed: ["function latestRoundData() view returns(uint80,int256,uint256,uint256,uint80)", "function decimals() view returns(uint8)"],
};
let rpc: ethers.JsonRpcProvider | null = null;
export function provider() {
  const raw = process.env.RPC_URL?.trim();
  need(raw && raw.startsWith("https://"), 503, "RPC_UNAVAILABLE", "Mainnet RPC is not configured.");
  if (!rpc) {
    const request = new ethers.FetchRequest(raw);
    request.timeout = 10000;
    rpc = new ethers.JsonRpcProvider(request, 4663, {staticNetwork: true, batchMaxCount: 1});
  }
  return rpc;
}
export async function requireMainnet() {
  const status = await getMainnetStatus();
  need(status.connected && status.chainId === 4663, 503, "RPC_UNAVAILABLE", "Robinhood mainnet is not reachable.");
}
export async function ownedUnits(operator: string) {
  const c = coreConfig();
  if (!c.factory) return [];
  await requireMainnet();
  const contract = new ethers.Contract(c.factory, ABI.factory, provider());
  const ids = await contract.unitsOf(operator) as bigint[];
  need(ids.length <= 100, 503, "UNIT_LIMIT", "Too many units to load at once.");
  return Promise.all(ids.map(async id => {
    need(id <= BigInt(Number.MAX_SAFE_INTEGER), 503, "INVALID_UNIT", "Unit ID is out of range.");
    const shield = ethers.getAddress(await contract.shieldOf(id));
    const s = new ethers.Contract(shield, ABI.shield, provider());
    need(ethers.getAddress(await s.operator()) === operator, 403, "NOT_OPERATOR", "Wallet does not own this unit.");
    const [mode, limits, used] = await Promise.all([s.mode(), s.limits(), s.usedToday()]);
    const whitelist: Asset[] = [], holdings: Partial<Record<Asset, number>> = {};
    await Promise.all(ASSETS.map(async asset => {
      const address = c.tokens[asset];
      if (!address) return;
      const t = new ethers.Contract(address, ABI.token, provider());
      const [allowed, balance, decimals] = await Promise.all([s.whitelisted(address), t.balanceOf(shield), t.decimals()]);
      need(Number(decimals) <= 36, 503, "TOKEN_INVALID", "Configured token decimals are not supported.");
      if (allowed) whitelist.push(asset);
      holdings[asset] = Number(ethers.formatUnits(balance, decimals));
    }));
    return {agentId: Number(id), shield, mode: (["supervised", "autonomous", "standby"] as Mode[])[Number(mode)]!,
      limits: {maxTrade: Number(limits[0]) / 1e6, dailyCap: Number(limits[1]) / 1e6,
        slippage: Number(limits[2]) / 100, cooldown: Number(limits[3]) / 60, whitelist},
      usedToday: Number(used) / 1e6, holdings};
  }));
}
export async function walletTier(operator: string): Promise<Tier> {
  const c = coreConfig(), limits = thresholds();
  if (!c.kx9Token || !limits.mk1) return "observer";
  const t = new ethers.Contract(c.kx9Token, ABI.token, provider());
  const [balance, decimals] = await Promise.all([t.balanceOf(operator), t.decimals()]);
  const value = Number(ethers.formatUnits(balance, decimals));
  return value >= limits.mk3 ? "mk3" : value >= limits.mk2 ? "mk2" : value >= limits.mk1 ? "mk1" : "observer";
}
export async function verifyTransaction(hash: unknown, operator: string, shield: string, expected?: {method: string; args: unknown[]}) {
  need(typeof hash === "string" && /^0x[a-f0-9]{64}$/i.test(hash), 400, "VALIDATION_FAILED", "A transaction hash is required.");
  await requireMainnet();
  const [tx, receipt] = await Promise.all([provider().getTransaction(hash), provider().getTransactionReceipt(hash)]);
  need(tx && receipt && receipt.status === 1 && tx.from === operator && tx.to === shield, 409, "TX_UNCONFIRMED", "A successful transaction from this operator to this Shield is required.");
  if (expected) {
    const encoded = new ethers.Interface(ABI.shield).encodeFunctionData(expected.method, expected.args);
    need(tx.data.toLowerCase() === encoded.toLowerCase(), 409, "TX_MISMATCH", "Transaction does not match the requested action.");
  }
  return tx;
}
export function prepareLimits(shield: string, next: Limits, previous: Limits) {
  const c = coreConfig(), i = new ethers.Interface(ABI.shield);
  const txs = [{to: shield, data: i.encodeFunctionData("setLimits", [[
    BigInt(Math.round(next.maxTrade * 1e6)), BigInt(Math.round(next.dailyCap * 1e6)), Math.round(next.slippage * 100), Math.round(next.cooldown * 60),
  ]])}];
  for (const asset of ASSETS) {
    const enabled = next.whitelist.includes(asset);
    if (enabled === previous.whitelist.includes(asset)) continue;
    need(c.tokens[asset], 409, "TOKEN_NOT_CONFIGURED", `${asset} has no verified token address configured.`);
    txs.push({to: shield, data: i.encodeFunctionData("setWhitelist", [c.tokens[asset], enabled])});
  }
  return txs;
}
export async function quoteTrade(asset: Asset, side: "buy" | "sell", usd: number, assetPrice: number, stablePrice: number) {
  const c = coreConfig(), input = side === "buy" ? "USDC" : asset, output = side === "buy" ? asset : "USDC";
  need(c.quoter && c.tokens[input] && c.tokens[output], 503, "QUOTE_UNAVAILABLE", "A verified router quote is not configured.");
  const tokenIn = new ethers.Contract(c.tokens[input]!, ABI.token, provider()), tokenOut = new ethers.Contract(c.tokens[output]!, ABI.token, provider());
  const [dIn, dOut] = await Promise.all([tokenIn.decimals(), tokenOut.decimals()]);
  const amount = usd / (side === "buy" ? stablePrice : assetPrice);
  const amountIn = ethers.parseUnits(amount.toFixed(Math.min(Number(dIn), 8)), dIn);
  const q = new ethers.Contract(c.quoter, ["function quoteExactInputSingle((address,address,uint256,uint24,uint160)) returns(uint256,uint160,uint32,uint256)"], provider());
  const [amountOut] = await q.quoteExactInputSingle.staticCall([c.tokens[input], c.tokens[output], amountIn, 3000, 0]);
  const actualOut = Number(ethers.formatUnits(amountOut, dOut));
  const expected = usd / (side === "buy" ? assetPrice : stablePrice);
  return {amountIn: amountIn.toString(), outputDecimals: Number(dOut), amountOut: amountOut as bigint,
    fairAmountOut: ethers.parseUnits(expected.toFixed(Math.min(Number(dOut), 8)), dOut),
    slippagePct: Math.max(0, (1 - actualOut / expected) * 100)};
}

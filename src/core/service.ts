import crypto from "node:crypto";
import { ethers } from "ethers";
import { coreConfig, publicConfig } from "./config";
import { ABI, ownedUnits, walletTier, quoteTrade, provider, requireMainnet, verifyTransaction } from "./chain";
import { prices } from "./prices";
import { ASSETS, need, type Account, type Asset, type Proposal, type Unit, type Protocols } from "./types";
import { withAccount } from "./store";
import { logger } from "../lib/logger";
import { pool } from "../db/index";
import { narrate } from "./analyst";

export function record(u: Unit, role: string, event: string, text: string, extra: Partial<{asset: Asset; usd: number; txHash: string; proposalId: string}> = {}) {
  const entry = {id: crypto.randomUUID(), at: new Date().toISOString(), role, event, text,
    asset: extra.asset ?? null, usd: extra.usd ?? null, txHash: extra.txHash ?? null, proposalId: extra.proposalId ?? null};
  const validation = "0x" + crypto.createHash("sha256").update(JSON.stringify({...entry, agentId: u.agentId})).digest("hex");
  u.logs.unshift({...entry, validation}); u.logs = u.logs.slice(0, 2000);
}
export async function refreshAccount(operator: string, state: Account) {
  const actual = await ownedUnits(operator);
  const tier = actual.length ? await walletTier(operator) : "observer";
  const next: Record<string, Unit> = {};
  for (const chain of actual) {
    const saved = state.units[chain.agentId];
    const u: Unit = {...(saved || {
      agentId: chain.agentId, serial: "KX-9-" + String(chain.agentId).padStart(4, "0"),
      operator, class: tier, status: "online", cost: {}, lastRun: {}, lastTradeAt: 0,
      protocols: structuredClone(state.protocols), logs: [], proposals: [], equity: [],
    }), ...chain, operator, class: tier, status: "online"};
    next[u.agentId] = u;
    if (!saved) record(u, "system", "system.online", "On-chain unit ownership verified on Robinhood mainnet.");
  }
  state.units = next;
  return Object.values(next);
}
export function unitOf(state: Account, id: unknown) {
  need(/^\d+$/.test(String(id)), 400, "VALIDATION_FAILED", "Invalid unit ID.");
  const u = state.units[String(id)];
  need(u, 404, "NOT_FOUND", "No unit with this ID belongs to this wallet.");
  return u;
}
export async function telemetry(u: Unit) {
  const market = await prices();
  const holdings = Object.entries(u.holdings).map(([asset, amount]) => {
    const p = market.prices[asset as Asset];
    return {asset, amount, name: asset === "NVDA" ? "NVIDIA stock token" : asset,
      priceUsd: p.price, valueUsd: p.price === null ? null : amount! * p.price,
      changeTodayPct: p.price !== null && p.open !== null ? (p.price / p.open - 1) * 100 : null};
  });
  const complete = holdings.length > 0 && holdings.every(h => h.valueUsd !== null);
  const portfolioUsd = complete ? holdings.reduce((sum, h) => sum + h.valueUsd!, 0) : null;
  if (portfolioUsd !== null && (!u.equity.length || Date.now() - Date.parse(u.equity.at(-1)!.at) >= 3600000)) {
    u.equity.push({at: new Date().toISOString(), value: portfolioUsd}); u.equity = u.equity.slice(-720);
  }
  return {portfolioUsd, changeTodayUsd: null, changeTodayPct: null, exposurePct: portfolioUsd ? (1 - (holdings.find(h => h.asset === "USDC")?.valueUsd || 0) / portfolioUsd) * 100 : null,
    usedToday: u.usedToday, holdings, equity30d: u.equity.map(h => h.value), observations: u.equity};
}
const PERIOD = {Daily: 86400000, Weekly: 604800000, Monthly: 2592000000};
export async function candidates(u: Unit) {
  const m = await prices(), P = u.protocols, now = Date.now(), out: {protocol: keyof Protocols; side: "buy" | "sell"; asset: Asset; usd: number; reason: string; mark: string}[] = [];
  const due = (key: string, period: keyof typeof PERIOD) => now - Number(u.lastRun[key] || 0) >= PERIOD[period];
  const nvda = m.prices.NVDA;
  if (P.physical.on && nvda.price !== null) {
    const change = nvda.open ? (nvda.price / nvda.open - 1) * 100 : null;
    if (change !== null && change <= -P.physical.dip && u.lastRun.physicalDip !== new Date().toISOString().slice(0, 10)) {
      out.push({protocol: "physical", side: "buy", asset: "NVDA", usd: P.physical.dipAmount, mark: "physicalDip", reason: `NVDA is down ${Math.abs(change).toFixed(2)}% since the first verified observation today; the configured dip threshold is ${P.physical.dip}%.`});
    } else if (due("physical", P.physical.every)) out.push({protocol: "physical", side: "buy", asset: "NVDA", usd: P.physical.amount, mark: "physical", reason: `${P.physical.every} Physical AI allocation to the configured NVDA stock token. This is not NVIDIA AI or an NVIDIA partnership.`});
  }
  if (P.accumulate.on && m.prices[P.accumulate.asset].price !== null && due("accumulate", P.accumulate.every)) {
    out.push({protocol: "accumulate", side: "buy", asset: P.accumulate.asset, usd: P.accumulate.amount, mark: "accumulate", reason: `${P.accumulate.every} scheduled purchase under your Accumulate settings.`});
  }
  if (P.guard.on) for (const asset of ASSETS) {
    const cost = u.cost[asset], p = m.prices[asset].price, stable = m.prices.USDC.price, amount = u.holdings[asset];
    if (asset === "USDC" || !cost || p === null || stable === null || !amount) continue;
    const change = (p / stable / cost - 1) * 100;
    if (change >= P.guard.tp || change <= -P.guard.sl) out.push({protocol: "guard", side: "sell", asset, usd: Math.min(amount * p, u.limits.maxTrade), mark: "guard", reason: `Verified price moved ${change.toFixed(2)}% from the confirmed purchase cost, crossing your Guard threshold.`});
  }
  if (P.balance.on && now - Number(u.lastRun.balance || 0) >= 21600000) {
    const t = await telemetry(u), target = {"Growth 60/40": .6, "Balanced 40/60": .4, "Defensive 20/80": .2}[P.balance.target];
    if (t.portfolioUsd && t.exposurePct !== null && Math.abs(t.exposurePct - target * 100) > P.balance.drift) {
      const asset = u.limits.whitelist.find(a => a !== "USDC" && m.prices[a].price !== null && (u.holdings[a] || 0) > 0);
      if (asset) out.push({protocol: "balance", side: t.exposurePct > target * 100 ? "sell" : "buy", asset,
        usd: Math.min(Math.abs(t.exposurePct / 100 - target) * t.portfolioUsd, u.limits.maxTrade), mark: "balance", reason: `Verified non-stable exposure is ${t.exposurePct.toFixed(2)}%; target is ${target * 100}%.`});
    }
  }
  if (P.trend.on && now - Number(u.lastRun.trend || 0) >= 3600000) {
    const rows = m.prices[P.trend.asset].history.slice(-P.trend.window), p = m.prices[P.trend.asset].price;
    if (rows.length === P.trend.window && p !== null) {
      const average = rows.reduce((sum, r) => sum + r.value, 0) / rows.length;
      if (p > average * 1.01 && !(u.holdings[P.trend.asset]! > 0)) out.push({protocol: "trend", side: "buy", asset: P.trend.asset, usd: P.trend.size, mark: "trend", reason: `Price is above the ${P.trend.window}-observation moving average. Observations are verified oracle rounds, not daily candles.`});
    }
  }
  return out;
}
export async function evaluateRisk(u: Unit, p: Proposal) {
  const c = coreConfig(), market = await prices(), a = market.prices[p.asset].price, stable = market.prices.USDC.price;
  const checks = [
    {key: "class", ok: u.class !== "observer", detail: "An eligible, verified KX9 holding is required."},
    {key: "mode", ok: u.mode !== "standby", detail: "The unit must not be in Standby."},
    {key: "whitelist", ok: u.limits.whitelist.includes(p.asset) && u.limits.whitelist.includes("USDC"), detail: "Both assets must be allowed by the Shield."},
    {key: "maxTrade", ok: p.usd <= u.limits.maxTrade, detail: `$${p.usd} against the $${u.limits.maxTrade} per-trade limit.`},
    {key: "dailyCap", ok: u.usedToday + p.usd <= u.limits.dailyCap, detail: "Verified usage plus this trade must fit the daily cap."},
    {key: "price", ok: a !== null && stable !== null && market.sequencerUp === true, detail: "Fresh oracle prices and sequencer uptime are required."},
    {key: "execution", ok: Boolean(publicConfig().executionEnabled), detail: "The approved executor, router and quote provider must be configured."},
    {key: "cooldown", ok: Date.now() - u.lastTradeAt >= u.limits.cooldown * 60000, detail: "The configured trade cooldown must have elapsed."},
    {key: "balance", ok: a !== null && stable !== null && (p.side === "buy" ? (u.holdings.USDC || 0) * stable >= p.usd : (u.holdings[p.asset] || 0) * a >= p.usd), detail: "The vault must hold enough of the input asset."},
  ];
  let slippageEst: number | null = null;
  if (a !== null && stable !== null && c.quoter) {
    try {
      const quote = await quoteTrade(p.asset, p.side, p.usd, a, stable);
      slippageEst = quote.slippagePct; p.amountIn = quote.amountIn;
      p.minAmountOut = (quote.fairAmountOut * BigInt(Math.floor((100 - u.limits.slippage) * 100)) / 10000n).toString();
    } catch { /* Quote failure remains a failed risk check. */ }
  }
  checks.push({key: "slippage", ok: slippageEst !== null && slippageEst <= u.limits.slippage, detail: slippageEst === null ? "No verified router quote is available." : `${slippageEst.toFixed(3)}% quote impact against the ${u.limits.slippage}% limit.`});
  return {ok: checks.every(v => v.ok), slippageEst, checks};
}
export async function tickUnit(u: Unit) {
  for (const p of u.proposals) if (["operator", "risk"].includes(p.stage) && Date.parse(p.expiresAt) <= Date.now()) {
    p.stage = "rejected"; record(u, "system", "operator.rejected", "Approval window expired.", {proposalId: p.id});
  }
  if (u.mode === "standby" || u.proposals.some(p => ["operator", "risk", "exec"].includes(p.stage))) return;
  const picks = await candidates(u), pick = picks[0];
  if (!pick) return;
  // Throttle rejected candidates too; a missing prerequisite cannot flood
  // the recorder every poll or consume a schedule's entire allocation.
  if (Date.now() - Number(u.lastRun.attempt || 0) < 60000) return;
  u.lastRun.attempt = Date.now();
  const p: Proposal = {id: "prp_" + crypto.randomBytes(16).toString("hex"), agentId: u.agentId, ...pick,
    qty: null, stage: "risk", risk: null, txHash: null, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 900000).toISOString()};
  p.risk = await evaluateRisk(u, p);
  p.ruleFacts = p.reason;
  const narration = await narrate(p); p.reason = narration.text; p.reasonSource = narration.source;
  p.stage = !p.risk.ok ? "veto" : u.mode === "autonomous" ? "exec" : "operator";
  record(u, "analyst", "proposal.created", p.reason, {asset: p.asset, usd: p.usd, proposalId: p.id});
  record(u, "risk", p.risk.ok ? "risk.approved" : "risk.vetoed", p.risk.ok ? "All deterministic risk checks passed." : p.risk.checks.find(v => !v.ok)!.detail, {asset: p.asset, usd: p.usd, proposalId: p.id});
  u.proposals.unshift(p); u.proposals = u.proposals.slice(0, 300);
  // Autonomous submission is deliberately not started by an HTTP poll.
  // The background worker acquires the per-wallet lock and handles it.
}
export async function execute(u: Unit, p: Proposal) {
  const recovery = (await pool.query("SELECT tx_hash,raw_tx FROM kx9_execution_outbox WHERE proposal_id=$1", [p.id])).rows[0];
  if (recovery && (!recovery.raw_tx || await provider().getTransaction(recovery.tx_hash))) {
    p.txHash = recovery.tx_hash; p.stage = "exec";
    if (recovery.raw_tx) await pool.query("UPDATE kx9_execution_outbox SET raw_tx=NULL WHERE proposal_id=$1", [p.id]);
    return;
  }
  need(publicConfig().executionEnabled, 503, "EXECUTION_UNAVAILABLE", "Live execution is not configured.");
  need(Date.parse(p.expiresAt) > Date.now() && u.mode !== "standby", 409, "STAGE_CONFLICT", "Proposal expired or the unit is in Standby.");
  await requireMainnet();
  p.risk = await evaluateRisk(u, p);
  need(p.risk.ok && p.amountIn && p.minAmountOut, 409, "RISK_BLOCKED", "The latest risk checks blocked this trade.");
  if (u.mode === "autonomous") need(["mk2", "mk3"].includes(u.class), 403, "CLASS_REQUIRED", "Autonomous mode requires Mk II or higher.");
  const c = coreConfig(), signer = new ethers.Wallet(process.env.EXECUTOR_KEY!, provider());
  const s = new ethers.Contract(u.shield, ABI.shield, signer);
  need(ethers.getAddress(await s.executor()) === signer.address, 409, "EXECUTOR_MISMATCH", "The configured signer is not this vault's executor.");
  const input = p.side === "buy" ? "USDC" : p.asset, output = p.side === "buy" ? p.asset : "USDC";
  const data = new ethers.Interface(["function exactInputSingle((address,address,uint24,address,uint256,uint256,uint160)) returns(uint256)"])
    .encodeFunctionData("exactInputSingle", [[c.tokens[input], c.tokens[output], 3000, u.shield, BigInt(p.amountIn), BigInt(p.minAmountOut), 0]]);
  // Persist the signed bytes before broadcast. Autonomous-mode Shield calls do
  // not consume proposal IDs, so retries must reuse this exact transaction.
  const lock = await pool.connect();
  try {
    await lock.query("SELECT pg_advisory_lock(2146491739)");
    let saved = (await lock.query("SELECT tx_hash,raw_tx FROM kx9_execution_outbox WHERE proposal_id=$1", [p.id])).rows[0];
    if (!saved) {
      const pending = await lock.query("SELECT 1 FROM kx9_execution_outbox WHERE raw_tx IS NOT NULL LIMIT 1");
      need(!pending.rowCount, 409, "EXECUTION_RECOVERY_REQUIRED", "A prior submission needs reconciliation before another transaction can be signed.");
      const nonce = Number(BigInt(await provider().send("eth_getTransactionCount", [signer.address, "pending"])));
      const tx = await s.execute.populateTransaction([ethers.id(p.id), c.tokens[input], c.tokens[output], BigInt(p.amountIn), BigInt(p.minAmountOut), BigInt(Math.floor(Date.now() / 1000) + 300)], c.router, data, {nonce});
      const raw = await signer.signTransaction(await signer.populateTransaction(tx));
      saved = {tx_hash: ethers.keccak256(raw), raw_tx: raw};
      await lock.query("INSERT INTO kx9_execution_outbox(proposal_id,operator,tx_hash,raw_tx) VALUES($1,$2,$3,$4)", [p.id,u.operator,saved.tx_hash,raw]);
    }
    if (saved.raw_tx) {
      const known = await provider().getTransaction(saved.tx_hash);
      if (!known) await provider().broadcastTransaction(saved.raw_tx);
      await lock.query("UPDATE kx9_execution_outbox SET raw_tx=NULL WHERE proposal_id=$1", [p.id]);
    }
    p.txHash = saved.tx_hash; p.stage = "exec";
    record(u, "executor", "execution.submitted", "Trade submitted; awaiting mainnet confirmation.", {proposalId: p.id, txHash: saved.tx_hash, asset: p.asset, usd: p.usd});
  } finally {
    try { await lock.query("SELECT pg_advisory_unlock(2146491739)"); } finally { lock.release(); }
  }
}
export async function reconcileExecution(u: Unit) {
  for (const p of u.proposals.filter(p => p.stage === "exec" && p.txHash)) {
    const receipt = await provider().getTransactionReceipt(p.txHash!);
    if (!receipt) continue;
    p.stage = receipt.status === 1 ? "done" : "failed";
    if (receipt.status === 1) {
      u.lastTradeAt = Date.now();
      if (p.side === "buy") {
        const c = coreConfig(), transfer = new ethers.Interface(["event Transfer(address indexed from,address indexed to,uint256 value)"]);
        let spent = 0n, received = 0n;
        for (const event of receipt.logs) {
          try {
            const parsed = transfer.parseLog(event);
            if (!parsed) continue;
            if (event.address.toLowerCase() === c.tokens.USDC?.toLowerCase() && parsed.args.from.toLowerCase() === u.shield.toLowerCase()) spent += parsed.args.value;
            if (event.address.toLowerCase() === c.tokens[p.asset]?.toLowerCase() && parsed.args.to.toLowerCase() === u.shield.toLowerCase()) received += parsed.args.value;
          } catch { /* Unrelated receipt log. */ }
        }
        if (spent > 0n && received > 0n) {
          const stableToken = new ethers.Contract(c.tokens.USDC!, ABI.token, provider()), assetToken = new ethers.Contract(c.tokens[p.asset]!, ABI.token, provider());
          const [dStable, dAsset] = await Promise.all([stableToken.decimals(), assetToken.decimals()]);
          const acquired = Number(ethers.formatUnits(received, dAsset)), cost = Number(ethers.formatUnits(spent, dStable));
          const previous = Math.max(0, (u.holdings[p.asset] || 0) - acquired);
          // A transferred-in position with an unknown cost must not acquire a
          // made-up cost merely because the vault bought another small lot.
          if (!previous || u.cost[p.asset]) u.cost[p.asset] = ((u.cost[p.asset] || 0) * previous + cost) / (previous + acquired);
        }
      }
      u.lastRun[p.protocol] = Date.now();
      if (p.mark) u.lastRun[p.mark] = Date.now();
    }
    record(u, "executor", receipt.status === 1 ? "execution.confirmed" : "execution.failed",
      receipt.status === 1 ? "Mainnet transaction confirmed." : "Mainnet transaction reverted.",
      {proposalId: p.id, txHash: p.txHash!, asset: p.asset, usd: p.usd});
  }
}
export async function approve(u: Unit, p: Proposal, hash: unknown) {
  need(p.stage === "operator", 409, "STAGE_CONFLICT", "This proposal is not awaiting approval.");
  need(typeof hash === "string", 400, "VALIDATION_FAILED", "An on-chain approval transaction is required.");
  const tx = await verifyTransaction(hash, u.operator, u.shield);
  const parsed = new ethers.Interface(ABI.shield).parseTransaction({data: tx.data});
  need(parsed?.name === "approveProposal" && parsed.args[0] === ethers.id(p.id) && parsed.args[1] >= BigInt(Math.ceil(p.usd * 1e6)) && Number(parsed.args[2]) * 1000 > Date.now(), 409, "TX_MISMATCH", "This transaction does not approve this proposal and amount.");
  const a = await new ethers.Contract(u.shield, ABI.shield, provider()).approvals(ethers.id(p.id));
  need(!a.used && Number(a.deadline) * 1000 > Date.now() && a.maxUsd >= BigInt(Math.ceil(p.usd * 1e6)), 409, "APPROVAL_EXPIRED", "The on-chain approval is expired, used or too small.");
  record(u, "operator", "operator.approved", "Operator approval verified on Robinhood mainnet.", {proposalId: p.id, txHash: hash});
  await execute(u, p);
}
let worker: ReturnType<typeof setInterval> | null = null, running = false;
export function startCoreWorker() {
  if (worker) return;
  worker = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      if (!coreConfig().factory) return;
      const accounts = await pool.query("SELECT operator FROM kx9_accounts ORDER BY updated_at DESC LIMIT 100");
      for (const row of accounts.rows) {
        try {
          await withAccount(row.operator, async state => {
            const units = await refreshAccount(row.operator, state);
            for (const u of units) {
              const persisted = new Set(u.proposals.map(p => p.id));
              await reconcileExecution(u); await tickUnit(u);
              // A new autonomous proposal must commit before it can be signed.
              for (const p of u.proposals.filter(p => persisted.has(p.id) && p.stage === "exec" && !p.txHash)) await execute(u, p);
            }
          });
        } catch { logger.warn({event: "core_account_tick_failed"}, "Core worker could not refresh an account"); }
      }
    } catch { logger.error({event: "core_worker_failed"}, "Core worker failed"); }
    finally { running = false; }
  }, 15000);
  worker.unref();
}

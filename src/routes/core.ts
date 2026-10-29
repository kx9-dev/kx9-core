import { Router, type IRouter } from "express";
import { pool } from "../db/index";
import { ethers } from "ethers";
import { SaveCoreProtocolsBody, SaveCoreUnitProtocolsBody, PrepareCoreShieldBody, ConfirmCoreShieldBody, ChangeCoreModeBody, RunCoreSimulationBody, RejectCoreProposalBody } from "../validation/index";
import { challenge, verify, requireOperator, sessionToken, digest, requestOrigin } from "../core/auth";
import { coreConfig, publicConfig } from "../core/config";
import { withAccount, updates } from "../core/store";
import { CoreError, need, type Protocols, type Limits, type Account, type Unit, type Proposal } from "../core/types";
import { refreshAccount, unitOf, telemetry, tickUnit, record, approve, reconcileExecution } from "../core/service";
import { prepareLimits, verifyTransaction, ABI } from "../core/chain";
import { prices } from "../core/prices";
import { replay } from "../core/replay";
import { getMainnetStatus } from "../lib/mainnet-rpc";

const router: IRouter = Router();
let start = Date.now(), hits = 0, streams = 0;
router.use((req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (Date.now() - start >= 60000) {start = Date.now(); hits = 0;}
  if (++hits > 600) {res.setHeader("Retry-After", "60"); res.status(429).json({error: {code: "RATE_LIMITED", message: "Too many requests. Try again in a minute."}}); return;}
  try {
    if (!["GET", "HEAD"].includes(req.method)) {
      requestOrigin(req);
      need(req.is("application/json"), 415, "CONTENT_TYPE", "Send JSON requests.");
    }
    next();
  } catch (error) {next(error);}
});
function parse<T>(schema: {safeParse(value: unknown): {success: true; data: T} | {success: false}}, value: unknown): T {
  const result = schema.safeParse(value);
  need(result.success, 400, "VALIDATION_FAILED", "Some values are missing or outside their allowed ranges.");
  return result.data;
}
const publicUnit = (u: Unit) => ({agentId: u.agentId, serial: u.serial, shield: u.shield, class: u.class, mode: u.mode, status: u.status});
async function owned<T>(operator: string, id: unknown, action: (u: Unit, state: Account) => Promise<T> | T) {
  return withAccount(operator, async state => {await refreshAccount(operator, state); return action(unitOf(state, id), state);});
}
async function proposal<T>(operator: string, id: unknown, action: (u: Unit, p: Proposal) => Promise<T> | T) {
  return withAccount(operator, async state => {
    await refreshAccount(operator, state);
    for (const u of Object.values(state.units)) {
      const p = u.proposals.find(p => p.id === id);
      if (p) return action(u, p);
    }
    throw new CoreError(404, "NOT_FOUND", "Proposal not found for this wallet.");
  });
}
router.get("/health", async (_req, res) => {
  const [rpc] = await Promise.all([getMainnetStatus(), pool.query("SELECT 1")]);
  const c = publicConfig();
  res.json({ok: true, mode: "mainnet", chainId: 4663, rpcConnected: rpc.connected, factoryConfigured: Boolean(c.factory),
    liveExecution: c.executionEnabled, priceFeedsConfigured: Object.keys(c.feeds).length, model: null,
    narration: process.env.ANTHROPIC_API_KEY ? "optional-language-model" : "rule-based",
    time: new Date().toISOString(), capabilities: ["wallet-signin", "protocols", "physical-nvda", "verified-risk-checks", "mainnet-proposals", "historical-replay", "blackbox", "passport", "realtime"]});
});
router.get("/config", (_req, res) => res.json(publicConfig()));
router.get("/prices", async (_req, res) => res.json((await prices()).prices));
router.post("/auth/nonce", async (req, res) => res.json(await challenge(req)));
router.post("/auth/verify", async (req, res) => {
  const login = await verify(req, res);
  const units = await withAccount(login.operator, state => refreshAccount(login.operator, state));
  res.json({...login, units: units.map(publicUnit)});
});
router.use(requireOperator);
router.get("/auth/session", async (_req, res) => {
  const units = await withAccount(res.locals.operator, state => refreshAccount(res.locals.operator, state));
  res.json({operator: res.locals.operator, units: units.map(publicUnit)});
});
router.post("/auth/logout", async (req, res) => {
  await pool.query("DELETE FROM kx9_sessions WHERE token_hash=$1", [digest(sessionToken(req)!)]);
  res.clearCookie("kx9_session", {httpOnly: true, secure: true, sameSite: "lax", path: "/api/v1"});
  res.json({ok: true});
});
router.get("/settings/protocols", async (_req, res) => res.json(await withAccount(res.locals.operator, state => state.protocols)));
router.put("/settings/protocols", async (req, res) => {
  const value = parse(SaveCoreProtocolsBody, req.body) as Protocols;
  res.json(await withAccount(res.locals.operator, state => {state.protocols = value; return value;}));
});
router.get("/units", async (_req, res) => {
  const units = await withAccount(res.locals.operator, state => refreshAccount(res.locals.operator, state));
  res.json({items: units.map(publicUnit)});
});
router.get("/units/:id", async (req, res) => res.json(await owned(res.locals.operator, req.params.id, publicUnit)));
router.get("/units/:id/state", async (req, res) => res.json(await owned(res.locals.operator, req.params.id, async u => {
  await reconcileExecution(u); await tickUnit(u);
  return {unit: publicUnit(u), telemetry: await telemetry(u), protocols: u.protocols, shield: {...u.limits, usedToday: u.usedToday},
    pending: u.proposals.find(p => ["operator", "risk", "exec"].includes(p.stage)) || u.proposals[0] || null,
    log: u.logs.slice(0, 100), prices: (await prices()).prices};
})));
router.get("/units/:id/telemetry", async (req, res) => res.json(await owned(res.locals.operator, req.params.id, telemetry)));
router.patch("/units/:id/mode", async (req, res) => {
  const input = parse(ChangeCoreModeBody, req.body);
  res.json(await owned(res.locals.operator, req.params.id, async u => {
    if (input.mode === "autonomous") need(["mk2", "mk3"].includes(u.class), 403, "CLASS_REQUIRED", "Autonomous mode requires a verified Mk II holding.");
    await verifyTransaction(input.txHash, u.operator, u.shield, {method: "setMode", args: [["supervised", "autonomous", "standby"].indexOf(input.mode)]});
    need(u.mode === input.mode, 409, "CHAIN_STATE_MISMATCH", "Current on-chain mode does not match the requested mode.");
    if (input.mode === "standby") for (const p of u.proposals) if (["operator", "risk"].includes(p.stage)) p.stage = "rejected";
    record(u, "operator", "mode.changed", `On-chain mode changed to ${u.mode}.`, {txHash: input.txHash});
    return {mode: u.mode};
  }));
});
router.post("/units/:id/diagnostic", async (req, res) => res.json(await owned(res.locals.operator, req.params.id, async u => {
  const rpc = await getMainnetStatus(), market = await prices();
  const checks = {rpc: rpc.connected, vault: u.status === "online", prices: Object.values(market.prices).some(p => p.price !== null), execution: publicConfig().executionEnabled};
  const passed = Object.values(checks).every(Boolean);
  record(u, "system", "system.diagnostic", passed ? "Connected services passed verification." : "Some required services are not available.");
  return {passed, checks};
})));
router.get("/units/:id/protocols", async (req, res) => res.json(await owned(res.locals.operator, req.params.id, u => u.protocols)));
router.put("/units/:id/protocols", async (req, res) => {
  const value = parse(SaveCoreUnitProtocolsBody, req.body) as Protocols;
  res.json(await owned(res.locals.operator, req.params.id, u => {
    u.protocols = value; record(u, "operator", "protocols.updated", "Operator saved protocol settings. Execution still requires verified risk checks and contract permission."); return u.protocols;
  }));
});
router.get("/units/:id/shield", async (req, res) => res.json(await owned(res.locals.operator, req.params.id, u => ({...u.limits, usedToday: u.usedToday}))));
router.post("/units/:id/shield/prepare", async (req, res) => {
  const value = parse(PrepareCoreShieldBody, req.body) as Limits;
  need(value.maxTrade <= value.dailyCap, 400, "VALIDATION_FAILED", "The trade limit cannot exceed the daily cap.");
  res.json(await owned(res.locals.operator, req.params.id, u => ({txs: prepareLimits(u.shield, value, u.limits), next: value})));
});
router.put("/units/:id/shield", async (req, res) => {
  const value = parse(ConfirmCoreShieldBody, req.body);
  res.json(await owned(res.locals.operator, req.params.id, async u => {
    await verifyTransaction(value.txHash, u.operator, u.shield);
    need(["maxTrade", "dailyCap", "slippage", "cooldown"].every(key => Math.abs(Number(u.limits[key as keyof Limits]) - Number(value[key as keyof typeof value])) < 1e-6) &&
      [...u.limits.whitelist].sort().join() === [...value.whitelist].sort().join(), 409, "CHAIN_STATE_MISMATCH", "Read-back limits do not match these values. Finish all wallet transactions first.");
    record(u, "operator", "shield.updated", "Shield limits verified on Robinhood mainnet.", {txHash: value.txHash});
    return {...u.limits, usedToday: u.usedToday};
  }));
});
router.get("/units/:id/proposals", async (req, res) => res.json(await owned(res.locals.operator, req.params.id, u => ({items: u.proposals}))));
router.post("/proposals/:id/approve", async (req, res) => res.json(await proposal(res.locals.operator, req.params.id, async (u, p) => {
  await approve(u, p, req.body?.txHash); return p;
})));
router.post("/proposals/:id/reject", async (req, res) => {
  const value = parse(RejectCoreProposalBody, req.body || {});
  res.json(await proposal(res.locals.operator, req.params.id, (u, p) => {
    need(["risk", "operator"].includes(p.stage), 409, "STAGE_CONFLICT", "This proposal cannot be rejected at its current stage.");
    p.stage = "rejected"; record(u, "operator", "operator.rejected", value.reason || "Operator declined the proposal.", {proposalId: p.id}); return p;
  }));
});
router.get("/units/:id/blackbox", async (req, res) => res.json(await owned(res.locals.operator, req.params.id, u => {
  const role = String(req.query.role || ""), q = String(req.query.q || "").slice(0, 200).toLowerCase();
  const start = Math.max(0, Number(req.query.cursor) || 0), count = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
  const rows = u.logs.filter(l => (!role || role === "all" || l.role === role) && (!q || `${l.asset} ${l.event} ${l.text}`.toLowerCase().includes(q)));
  return {items: rows.slice(start, start + count), nextCursor: start + count < rows.length ? String(start + count) : null};
})));
router.get("/units/:id/passport", async (req, res) => res.json(await owned(res.locals.operator, req.params.id, u => {
  const proposals = u.logs.filter(l => l.event === "proposal.created").length;
  return {...publicUnit(u), operator: u.operator, reputation: {score: null, uptimePct: null, validatedActions: u.logs.length,
    vetoRatePct: proposals ? u.logs.filter(l => l.event === "risk.vetoed").length / proposals * 100 : null, shieldBreaches: null},
    registry: null, validationType: "SHA-256 record integrity; not an ERC-8004 attestation",
    capabilities: Object.entries(u.protocols).filter(([, p]) => p.on).map(([name]) => "protocol." + name)};
})));
router.post("/simulations", async (req, res) => {
  const input = parse(RunCoreSimulationBody, req.body);
  res.json(await withAccount(res.locals.operator, state => replay(input, state.protocols)));
});
router.get("/stream", async (req, res) => {
  need(streams < 100, 503, "STREAM_LIMIT", "Live updates are busy; normal polling remains available.");
  streams++;
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();
  res.write("event: ready\ndata: {}\n\n");
  const write = () => {if (!res.writableEnded) res.write("event: updated\ndata: {}\n\n");};
  updates.on(res.locals.operator, write);
  const ping = setInterval(() => {if (!res.writableEnded) res.write(": heartbeat\n\n");}, 20000);
  const expiry = setTimeout(() => res.end(), 120000);
  req.on("close", () => {streams--; clearInterval(ping); clearTimeout(expiry); updates.off(res.locals.operator, write);});
});
router.get("/account", async (_req, res) => res.json(await withAccount(res.locals.operator, state => ({operator: res.locals.operator, exportedAt: new Date().toISOString(), state}))));
router.delete("/account", async (req, res) => {
  need(req.get("x-kx9-confirm") === "delete-offchain-data", 400, "CONFIRMATION_REQUIRED", "Explicitly confirm off-chain data deletion.");
  const operator = res.locals.operator;
  const connection = await pool.connect();
  try {
    await connection.query("BEGIN");
    await connection.query("DELETE FROM kx9_accounts WHERE operator=$1", [operator]);
    await connection.query("DELETE FROM kx9_execution_outbox WHERE operator=$1", [operator]);
    await connection.query("DELETE FROM kx9_sessions WHERE operator=$1", [operator]);
    await connection.query("DELETE FROM kx9_challenges WHERE operator=$1", [operator]);
    await connection.query("COMMIT");
  } catch (error) {await connection.query("ROLLBACK"); throw error;} finally {connection.release();}
  res.clearCookie("kx9_session", {path: "/api/v1", httpOnly: true, secure: true, sameSite: "lax"});
  res.json({ok: true, notice: "Off-chain data deleted. Public blockchain records and vault balances are unchanged."});
});
router.use((_req, res) => res.status(404).json({error: {code: "NOT_FOUND", message: "No such Core endpoint."}}));
router.use((error: unknown, req: import("express").Request, res: import("express").Response, _next: import("express").NextFunction) => {
  const safe = error instanceof CoreError;
  if (!safe) req.log.error({event: "core_request_failed"}, "Core request failed");
  res.status(safe ? error.status : 503).json({error: {code: safe ? error.code : "SERVICE_UNAVAILABLE", message: safe ? error.message : "A required service is unavailable. Try again shortly."}});
});
export default router;

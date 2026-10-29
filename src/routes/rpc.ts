import { Router, type IRouter } from "express";
import { RequestRpcBody } from "../validation/index";
import { callMainnetRpc, getMainnetStatus, rpcErrorCode, validRpcParams } from "../lib/mainnet-rpc";

const router: IRouter = Router();
let windowStart = Date.now();
let count = 0;
router.use("/rpc", (req, res, next) => {
  const origin = req.get("origin");
  if (origin) {
    let allowed = false;
    try {
      const hostname = new URL(origin).hostname;
      const forwarded = (req.get("x-forwarded-host") || req.get("host") || "").split(",")[0]?.trim().split(":")[0];
      allowed = ["kx9.tech", "app.kx9.tech", req.hostname, forwarded].includes(hostname);
    } catch { /* malformed origins are rejected */ }
    if (!allowed) { res.status(403).json({error: "Origin not allowed."}); return; }
  }
  if (Date.now() - windowStart >= 60000) { windowStart = Date.now(); count = 0; }
  if (++count > 180) { res.setHeader("Retry-After", "60"); res.status(429).json({error: "RPC request limit reached."}); return; }
  res.setHeader("Cache-Control", "no-store");
  next();
});
router.get("/rpc/status", async (_req, res) => {
  const status = await getMainnetStatus();
  res.status(status.connected ? 200 : 503).json(status);
});
router.post("/rpc", async (req, res) => {
  const parsed = RequestRpcBody.safeParse(req.body);
  if (!parsed.success || !validRpcParams(parsed.data.method, parsed.data.params || [])) {
    res.status(400).json({error: "Unsupported RPC method or parameters. Only bounded read-only requests are allowed."}); return;
  }
  const input = parsed.data;
  const status = await getMainnetStatus();
  if (!status.connected) {
    res.status(503).json({jsonrpc: "2.0", id: input.id, error: {code: -32000, message: status.error || "RPC unavailable"}}); return;
  }
  try {
    const params = [...(input.params || [])];
    if (input.method === "eth_call") params[0] = {...params[0] as object, gas: "0xf4240"};
    const result = await callMainnetRpc(input.method, params);
    res.json({jsonrpc: "2.0", id: input.id, result});
  } catch (error) {
    const code = rpcErrorCode(error);
    req.log.warn({event: "rpc_read_failed", code}, "RPC read failed");
    res.status(503).json({jsonrpc: "2.0", id: input.id, error: {code: -32000, message: code}});
  }
});
export default router;

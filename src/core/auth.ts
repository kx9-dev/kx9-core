import crypto from "node:crypto";
import { ethers } from "ethers";
import { pool } from "../db/index";
import type { Request, Response, NextFunction } from "express";
import { need, CoreError } from "./types";

export const digest = (value: string) => crypto.createHash("sha256").update(value).digest("hex");
export function requestOrigin(req: Request) {
  const hostname = (req.get("x-forwarded-host") || req.get("host") || "").split(",")[0]!.trim();
  need(/^[a-z0-9.-]+(?::\d+)?$/i.test(hostname), 400, "INVALID_ORIGIN", "Invalid request host.");
  const origin = `https://${hostname}`;
  const supplied = req.get("origin");
  need(!supplied || supplied === origin, 403, "INVALID_ORIGIN", "This request must come from the app.");
  return origin;
}
export async function challenge(req: Request) {
  const origin = requestOrigin(req);
  need(req.body && ethers.isAddress(req.body.address), 400, "VALIDATION_FAILED", "A valid wallet address is required.");
  need(req.body.chainId === 4663, 400, "WRONG_NETWORK", "Switch to Robinhood mainnet.");
  const operator = ethers.getAddress(req.body.address);
  const nonce = crypto.randomBytes(24).toString("hex");
  const issued = new Date(), expiresAt = new Date(issued.getTime() + 300000);
  const message = `${new URL(origin).host} wants you to sign in with your Ethereum account:\n${operator}\n\nSign in to KX-9 Command. This does not send a transaction or cost gas.\n\nURI: ${origin}\nVersion: 1\nChain ID: 4663\nNonce: ${nonce}\nIssued At: ${issued.toISOString()}\nExpiration Time: ${expiresAt.toISOString()}`;
  await pool.query("DELETE FROM kx9_challenges WHERE expires_at < now()");
  await pool.query("DELETE FROM kx9_sessions WHERE expires_at < now()");
  await pool.query("INSERT INTO kx9_challenges(nonce,operator,message_hash,origin,expires_at) VALUES($1,$2,$3,$4,$5)", [nonce, operator, digest(message), origin, expiresAt]);
  return {message, nonce, expiresAt: expiresAt.toISOString()};
}
export async function verify(req: Request, res: Response) {
  const origin = requestOrigin(req);
  const {message, signature} = req.body || {};
  need(typeof message === "string" && message.length < 2000 && typeof signature === "string" && /^0x[0-9a-f]{130}$/i.test(signature), 400, "VALIDATION_FAILED", "A message and wallet signature are required.");
  const nonce = message.match(/^Nonce: ([a-f0-9]{48})$/m)?.[1];
  need(nonce, 401, "UNAUTHENTICATED", "Sign-in request expired. Try again.");
  // Atomically consume the exact issued challenge. Altered messages cannot
  // change the domain, chain, timestamps, or statement after it is issued.
  const result = await pool.query("DELETE FROM kx9_challenges WHERE nonce=$1 AND message_hash=$2 AND origin=$3 AND expires_at>now() RETURNING operator", [nonce, digest(message), origin]);
  const record = result.rows[0];
  need(record, 401, "UNAUTHENTICATED", "Sign-in request expired or changed. Try again.");
  let signer: string;
  try { signer = ethers.verifyMessage(message, signature); } catch { throw new CoreError(401, "UNAUTHENTICATED", "Signature could not be verified."); }
  need(signer === record.operator, 401, "UNAUTHENTICATED", "Signature does not match this wallet.");
  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + 86400000);
  await pool.query("INSERT INTO kx9_sessions(token_hash,operator,expires_at) VALUES($1,$2,$3)", [digest(token), signer, expiresAt]);
  res.cookie("kx9_session", token, {httpOnly: true, secure: true, sameSite: "lax", path: "/api/v1", maxAge: 86400000});
  return {token, expiresAt: expiresAt.toISOString(), operator: signer};
}
export function sessionToken(req: Request) {
  const bearer = req.get("authorization");
  const cookie = req.get("cookie")?.match(/(?:^|;\s*)kx9_session=([a-f0-9]{64})(?:;|$)/)?.[1];
  const token = bearer?.startsWith("Bearer ") ? bearer.slice(7) : cookie;
  return token && /^[a-f0-9]{64}$/.test(token) ? token : null;
}
export async function requireOperator(req: Request, res: Response, next: NextFunction) {
  try {
    if (!["GET", "HEAD"].includes(req.method)) requestOrigin(req);
    const token = sessionToken(req);
    need(token, 401, "UNAUTHENTICATED", "Sign in with your wallet.");
    const result = await pool.query("SELECT operator FROM kx9_sessions WHERE token_hash=$1 AND expires_at>now()", [digest(token)]);
    need(result.rows[0], 401, "UNAUTHENTICATED", "Session expired. Sign in again.");
    res.locals.operator = result.rows[0].operator;
    next();
  } catch (error) { next(error); }
}

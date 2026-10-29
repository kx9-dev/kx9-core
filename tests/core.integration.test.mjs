import test from "node:test";
import assert from "node:assert/strict";
import { Wallet } from "ethers";

const base = process.env.API_TEST_BASE || "http://localhost:8080/api/v1";
const a = Wallet.createRandom(), b = Wallet.createRandom();
let tokenA, tokenB;
async function request(path, {method="GET", body, token, confirm} = {}) {
  const response = await fetch(base + path, {method, headers: {
    "Content-Type": "application/json", "X-Forwarded-Host": "app.kx9.tech", Origin: "https://app.kx9.tech",
    ...(token ? {Authorization: "Bearer " + token} : {}),
    ...(confirm ? {"X-KX9-Confirm": confirm} : {}),
  }, body: body === undefined ? undefined : JSON.stringify(body)});
  return {status: response.status, data: await response.json()};
}
async function login(wallet) {
  const n = await request("/auth/nonce", {method:"POST", body:{address:wallet.address,chainId:4663}});
  assert.equal(n.status, 200);
  const signature = await wallet.signMessage(n.data.message);
  const v = await request("/auth/verify", {method:"POST",body:{message:n.data.message,signature}});
  assert.equal(v.status,200); assert.equal(v.data.operator,wallet.address);
  return {token:v.data.token, nonce:n.data, signature};
}
test("public configuration exposes only safe addresses and readiness", async()=>{
  const h=await request("/health"), c=await request("/config");
  assert.equal(h.status,200);assert.equal(h.data.chainId,4663);
  assert.equal(c.data.rpc,"/api/rpc");assert(!JSON.stringify(c.data).includes("executorKey"));
  assert(!("rpcUrl" in c.data));assert.equal(h.data.mode,"mainnet");
});
test("nonce binds the exact message and cannot be replayed", async()=>{
  const n=await request("/auth/nonce",{method:"POST",body:{address:a.address,chainId:4663}});
  const changed=n.data.message.replace("Chain ID: 4663","Chain ID: 1");
  const rejected=await request("/auth/verify",{method:"POST",body:{message:changed,signature:await a.signMessage(changed)}});
  assert.equal(rejected.status,401);
  const session=await login(a);tokenA=session.token;
  const replay=await request("/auth/verify",{method:"POST",body:{message:session.nonce.message,signature:session.signature}});
  assert.equal(replay.status,401);
  tokenB=(await login(b)).token;
});
test("saved Physical AI settings persist and are isolated by wallet", async()=>{
  const defaults=await request("/settings/protocols",{token:tokenA});
  assert.equal(defaults.status,200);
  defaults.data.physical.amount=175; defaults.data.physical.on=true;
  const saved=await request("/settings/protocols",{method:"PUT",token:tokenA,body:defaults.data});
  assert.equal(saved.status,200);
  assert.equal((await request("/settings/protocols",{token:tokenA})).data.physical.amount,175);
  assert.equal((await request("/settings/protocols",{token:tokenB})).data.physical.amount,150);
  const invalid=structuredClone(defaults.data);invalid.physical.amount=-1;
  assert.equal((await request("/settings/protocols",{method:"PUT",token:tokenA,body:invalid})).status,400);
});
test("no authentication or no real unit never produces a fabricated vault",async()=>{
  assert.equal((await request("/units")).status,401);
  assert.equal((await request("/units/999999999/state",{token:tokenA})).status,404);
  const units=await request("/units",{token:tokenA});
  assert.equal(units.status,200);assert(Array.isArray(units.data.items));
  assert(units.data.items.every(u=>u.shield&&/^0x[0-9a-f]{40}$/i.test(u.shield)));
});
test("historical replay uses supplied prices and rejects future dates",async()=>{
  const body={protocol:"physical",asset:"NVDA",capital:5000,history:[{date:"2026-01-02",close:100},{date:"2026-01-05",close:95},{date:"2026-01-06",close:110}]};
  const r=await request("/simulations",{method:"POST",token:tokenA,body});
  assert.equal(r.status,200);assert.equal(r.data.equity.length,3);assert.equal(r.data.source,"operator-supplied historical prices");
  body.history[2].date="2099-01-01";
  assert.equal((await request("/simulations",{method:"POST",token:tokenA,body})).status,400);
});
test("deletion requires confirmation, preserves funds and revokes sessions",async()=>{
  assert.equal((await request("/account",{method:"DELETE",token:tokenA,body:{}})).status,400);
  assert.equal((await request("/account",{token:tokenA})).status,200);
  const removed=await request("/account",{method:"DELETE",token:tokenA,body:{},confirm:"delete-offchain-data"});
  assert.equal(removed.status,200);assert(removed.data.notice.includes("balances are unchanged"));
  assert.equal((await request("/auth/session",{token:tokenA})).status,401);
  assert.equal((await request("/account",{method:"DELETE",token:tokenB,body:{},confirm:"delete-offchain-data"})).status,200);
});

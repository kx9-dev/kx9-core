import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { transform } from "esbuild";

async function freshClient() {
  const source = (await fs.readFile(new URL("./mainnet-rpc.ts", import.meta.url), "utf8"))
    .replace('import { logger } from "./logger";', "const logger = {warn() {}};");
  const {code} = await transform(source, {loader: "ts", format: "esm", target: "node24"});
  return import("data:text/javascript;base64," + Buffer.from(code + `\n// ${Math.random()}`).toString("base64"));
}
process.env.RPC_URL = "https://rpc.invalid/private-test-fixture";
test("verifies chain 4663 and a recent block without exposing the endpoint", async () => {
  let calls = 0;
  globalThis.fetch = async (_url, options) => {
    calls++;
    const {method} = JSON.parse(options.body);
    const result = method === "eth_chainId" ? "0x1237" :
      {number: "0x123", timestamp: "0x" + Math.floor(Date.now() / 1000).toString(16)};
    return new Response(JSON.stringify({jsonrpc: "2.0", id: 1, result}));
  };
  const client = await freshClient();
  const status = await client.getMainnetStatus();
  assert.equal(status.connected, true);
  assert.equal(status.chainId, 4663);
  assert.equal(status.latestBlock, "291");
  assert(!JSON.stringify(status).includes("private-test-fixture"));
  await client.getMainnetStatus();
  assert.equal(calls, 2, "status is cached to avoid wasting provider requests");
});
test("wrong networks never appear connected", async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({result: "0x1"}));
  const status = await (await freshClient()).getMainnetStatus();
  assert.equal(status.connected, false);
  assert.equal(status.error, "RPC_WRONG_NETWORK");
});
test("DNS failures return a safe code, never a secret-bearing fetch error", async () => {
  globalThis.fetch = async () => {
    throw Object.assign(new Error("URL includes private-test-fixture"), {cause: {code: "EAI_AGAIN"}});
  };
  const status = await (await freshClient()).getMainnetStatus();
  assert.equal(status.error, "RPC_DNS_UNAVAILABLE");
  assert(!JSON.stringify(status).includes("private-test-fixture"));
});
test("RPC parameters reject writes and unbounded reads", async () => {
  const client = await freshClient();
  assert.equal(client.validRpcParams("eth_chainId", []), true);
  assert.equal(client.validRpcParams("eth_sendRawTransaction", ["0x00"]), false);
  assert.equal(client.validRpcParams("eth_getLogs", [{}]), false);
  assert.equal(client.validRpcParams("eth_getBalance", ["0x" + "1".repeat(40), "latest"]), true);
  assert.equal(client.validRpcParams("eth_call", [{to: "0x" + "1".repeat(40), gas: "0xffffffff"}, "latest"]), false);
});

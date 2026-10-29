import { pool } from "../db/index";
import { EventEmitter } from "node:events";
import { defaults, type Account } from "./types";

export const updates = new EventEmitter();
updates.setMaxListeners(200);
export async function withAccount<T>(operator: string, action: (state: Account) => Promise<T> | T): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '8s'");
    await client.query("INSERT INTO kx9_accounts(operator,state) VALUES($1,$2) ON CONFLICT DO NOTHING", [operator, {protocols: defaults(), units: {}}]);
    const result = await client.query("SELECT state FROM kx9_accounts WHERE operator=$1 FOR UPDATE", [operator]);
    const state = result.rows[0].state as Account;
    const before = JSON.stringify(state);
    const value = await action(state);
    const changed = before !== JSON.stringify(state);
    if (changed) await client.query("UPDATE kx9_accounts SET state=$2, updated_at=now() WHERE operator=$1", [operator, state]);
    await client.query("COMMIT");
    if (changed) updates.emit(operator);
    return value;
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}

import { pgTable, text, jsonb, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";

export const kx9Accounts = pgTable("kx9_accounts", {
  operator: text("operator").primaryKey(),
  state: jsonb("state").notNull().default({}),
  updatedAt: timestamp("updated_at", {withTimezone: true}).notNull().defaultNow(),
});
export const kx9Challenges = pgTable("kx9_challenges", {
  nonce: text("nonce").primaryKey(),
  operator: text("operator").notNull(),
  messageHash: text("message_hash").notNull(),
  origin: text("origin").notNull(),
  expiresAt: timestamp("expires_at", {withTimezone: true}).notNull(),
});
export const kx9Sessions = pgTable("kx9_sessions", {
  tokenHash: text("token_hash").primaryKey(),
  operator: text("operator").notNull(),
  expiresAt: timestamp("expires_at", {withTimezone: true}).notNull(),
});
export const insertKx9AccountSchema = createInsertSchema(kx9Accounts);
// Raw signed transactions are server-only recovery records, never exported.
export const kx9Outbox = pgTable("kx9_execution_outbox", {
  proposalId: text("proposal_id").primaryKey(),
  operator: text("operator").notNull(),
  txHash: text("tx_hash").notNull(),
  rawTx: text("raw_tx"),
  createdAt: timestamp("created_at", {withTimezone:true}).notNull().defaultNow(),
});
export type Kx9Account = typeof kx9Accounts.$inferSelect;

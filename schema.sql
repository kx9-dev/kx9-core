-- Schema only. No private or production data.
CREATE TABLE IF NOT EXISTS kx9_accounts (operator text PRIMARY KEY,state jsonb NOT NULL DEFAULT '{}'::jsonb,updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS kx9_challenges (nonce text PRIMARY KEY,operator text NOT NULL,message_hash text NOT NULL,origin text NOT NULL,expires_at timestamptz NOT NULL);
CREATE TABLE IF NOT EXISTS kx9_sessions (token_hash text PRIMARY KEY,operator text NOT NULL,expires_at timestamptz NOT NULL);
CREATE TABLE IF NOT EXISTS kx9_execution_outbox (proposal_id text PRIMARY KEY,operator text NOT NULL,tx_hash text NOT NULL,raw_tx text,created_at timestamptz NOT NULL DEFAULT now());

# KX-9 Core

Wallet-authenticated Core API, deterministic trading rules, risk checks and mainnet execution controls.

[Website](https://kx9.tech) · [Command app](https://app.kx9.tech) · [Documentation](https://github.com/kx9-dev/kx9-docs) · [Releases](https://github.com/kx9-dev/kx9-core/releases) · [Contact](mailto:dev@kx9.tech)

**Source release 0.1.0.** MIT-licensed source, not an audit or a claim of
active trading. Robinhood mainnet chain ID: **4663**. KX-9 is not affiliated
with Robinhood Markets or NVIDIA Corporation. Physical AI · NVDA is a
rule-based stock-token allocation strategy, not an NVIDIA AI service.

## Features
- Exact-message, domain/chain-bound wallet sign-in with single-use challenges.
- PostgreSQL-backed sessions, account defaults and per-unit records.
- Five deterministic protocols, fresh oracle checks and real router quotes.
- Verified on-chain ownership, supervised approvals and transaction receipts.
- Authenticated SSE with polling fallback in the web app.
- Durable exact-transaction recovery and cross-instance nonce serialization.
- Text-only optional narration; no authority over amounts, limits or signing.
- Owner-scoped account export and explicit off-chain deletion.

## Setup
Requires Node.js 22+, npm, and PostgreSQL 14+.

```sh
npm ci
cp .env.example .env
# Fill the blank variables privately. Never commit .env.
npm run db:init
npm run typecheck
npm test
npm run build
npm start
```

The service reads `.env` through Node's environment-file option. Set PORT=8080
and DATABASE_URL before schema initialization. Database initialization only
creates the documented tables; it does not import or seed private records.
Production migrations must be reviewed and applied explicitly, not at startup.

## Mainnet readiness
RPC_URL is server-only and must verify chain 4663. Missing factory configuration
returns an empty unit list; signed-in wallets can still save protocol defaults.
Supply verified FACTORY, KX9_TOKEN, TOKENS, FEEDS, SEQUENCER_FEED, ROUTER,
QUOTER and positive CLASS_THRESHOLDS to configure the actual chain.

Execution is **off by default**. A signer must match the vault executor and
ENABLE_LIVE_EXECUTION must be explicitly true. Token deployment, funding,
mainnet verification and spending authorization are separate owner actions.
This release has not proven funded mainnet execution. Keep it disabled until
local recovery/failure cases and the target deployment have been verified.

## API and operations
All Core routes use /api/v1; read-only RPC uses /api/rpc. See
[OpenAPI](openapi.yaml) and the [operating flows](https://github.com/kx9-dev/kx9-docs/blob/main/FLOWS.md).
Start only one service per configured port. Monitor /api/v1/health, database
availability, oracle freshness and pending transaction reconciliation.
The strategy worker needs a continuously running process; do not assume
scale-to-zero hosting runs scheduled decisions while idle.

## Tests
`npm test` runs RPC-boundary tests. With an isolated test database and the
server running on port 8080, `npm run test:integration` tests sign-in replay
protection, settings persistence, wallet isolation, historical dates and
explicit deletion. It creates and deletes disposable test accounts only.
No funded key or mainnet transaction is used.

## Repositories
| Repository | Responsibility |
| --- | --- |
| [kx9-web](https://github.com/kx9-dev/kx9-web) | KX-9 landing page and wallet-connected Command app for Robinhood mainnet. |
| [kx9-core](https://github.com/kx9-dev/kx9-core) | Wallet-authenticated Core API, deterministic trading rules, risk checks and mainnet execution controls. |
| [kx9-contracts](https://github.com/kx9-dev/kx9-contracts) | Solidity Shield vaults and factory with operator limits, supervised approvals and local-chain tests. |
| [kx9-docs](https://github.com/kx9-dev/kx9-docs) | Architecture, operating flows, OpenAPI specification, security boundaries and mainnet configuration. |

## Contributing and security
Read [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md) and
[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md). Maintainer contact: **dev@kx9.tech**.

## License
[MIT](LICENSE). Third-party dependencies and externally loaded fonts/libraries
retain their respective licenses; see [NOTICE](NOTICE).

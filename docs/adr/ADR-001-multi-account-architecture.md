# ADR-001: Multi-Account Architecture and Isolation Pattern

## Status
Accepted

## Context
The `zalo-tg` bridge was originally architected as a single-tenant application with global module singletons for configuration, in-memory topic stores, message mappings, and Zalo/Telegram connections. To support running multiple Zalo accounts simultaneously (e.g. 4 accounts) mapping to 4 distinct Telegram supergroups without spawning separate container stacks, we require a multi-account runtime architecture that guarantees state isolation, rate-limit resilience, and operational simplicity.

## Decisions

### 1. Configuration: Indexed Environment Variables (`Option 1B`)
- Multi-account mode is configured via an indexed environment list in `.env`:
  `ACCOUNTS=acc1,acc2,acc3,acc4`
- Each account defines its scoped configuration variables:
  - `TG_TOKEN_<ID>`: Dedicated Telegram Bot Token for that account.
  - `TG_GROUP_ID_<ID>`: Dedicated Telegram Forum Supergroup ID.
  - `ZALO_CREDENTIALS_PATH_<ID>`: Path to session credentials (default: `data/accounts/<id>/credentials.json`).
  - `DATA_DIR_<ID>`: Storage directory for the account (default: `data/accounts/<id>`).
  - `ZALO_SKIP_MUTED_GROUPS_<ID>`, `ZALO_MUTE_SILENT_<ID>`, `ZALO_EXCLUDED_GROUPS_<ID>`: Per-account feature flags.
- **Backward Compatibility**: If `ACCOUNTS` is omitted, the bridge transparently defaults to the standard single-account environment variables (`TG_TOKEN`, `TG_GROUP_ID`, `DATA_DIR`, etc.).

### 2. Telegram Bot Model: Dedicated Bot Tokens (`Option 2B`)
- Each Zalo account is paired with its own dedicated Telegram Bot token.
- **Rationale**: Isolates Telegram API rate limits (30 requests/sec per bot). A burst of messages or media in Account 1's supergroup will not throttle or trigger 429 back-off pauses for Accounts 2, 3, or 4.

### 3. Concurrency Model: In-Process Multi-Tenant (`Option 3A`)
- A single Node.js process manages $N$ distinct `AccountBridge` contexts.
- Shared resources:
  - Global `withMediaSlot` concurrency pool (max 3 concurrent `ffmpeg` / Lottie canvas renders) to prevent OS CPU saturation.
  - Asynchronous non-blocking file I/O engine.
- Staggered initialization (2.5s delay between account logins) to prevent Zalo IP-level rate limits during startup.

### 4. State & Data Isolation: Sub-directory Scoping (`Option 4A`)
- Every account stores its persistent files in `data/accounts/<account_id>/`:
  - `topics.json`: Telegram topic $\leftrightarrow$ Zalo thread mappings.
  - `msg-map.json.gz`: Gzipped bidirectional message ID index.
  - `user-cache.json.gz`: Gzipped contact and group member cache.
  - `polls.json.gz`: Native poll tracking state.
  - `credentials.json`: Zalo session credentials.
- All in-memory Maps and caches are encapsulated within an `AccountStoreContext` instance to ensure zero cross-tenant contamination.

## Consequences

### Positive
- **Complete Tenant Isolation**: Topic mappings, user display names, quotes, and friend lists from Account A are physically and logically segregated from Account B.
- **Independent Failure Domains**: A disconnect or invalid session in Account 1 does not interrupt message delivery in Accounts 2, 3, or 4.
- **Resource Efficiency**: Low memory footprint (~150MB total for 4 accounts) compared to running 4 separate Node.js / Docker runtimes.

### Negative / Trade-offs
- **Process Fate Sharing**: A fatal Node.js unhandled crash would restart all 4 accounts together (mitigated by the global error handlers and the hourly Windows Watchdog).
- **Setup Overhead**: Requires creating 4 Telegram bots via @BotFather and setting up 4 forum supergroups.

## Testing Strategy
- Unit tests verify `config` parser with single-account and multi-account `.env` configurations.
- Store isolation tests verify that two independent `StoreContext` instances with different `dataDir` paths do not share mappings, quotes, or cache entries.
- Queue tests verify that Telegram API calls dispatched across different bot instances are handled cleanly.

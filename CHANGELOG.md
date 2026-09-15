# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Added
- **Google Magika AI File Security & Disguised Payload Defense**:
  - Automated deep content inspection on all files and media attachments across both `Zalo → Telegram` and `Telegram → Zalo` pipelines.
  - Neural detection of disguised payloads (e.g. executables, shell/batch scripts, polyglots, and archives masquerading as images, audio, video, or documents).
  - Diagnostic security alert messages delivered directly to the relevant Telegram forum topic with claimed type, detected true type, confidence percentage, and SHA-256 digest.
  - Configurable via `MAGIKA_BLOCK_DISGUISED` and `MAGIKA_CONFIDENCE_THRESHOLD` (default: `0.85`, allow-with-warning below threshold).
- **Interactive Telegram Setup Wizard (`/setup`)**:
  - Interactive bot command allowing administrators to adjust bridge configuration variables via Telegram inline buttons and group chat inputs, writing changes directly to `.env`.
- **Transient Network Error Resiliency**:
  - Transparent `zaloApiWithRetry` proxy for Zalo API calls with 4-stage exponential backoff on `ECONNRESET`, `ETIMEDOUT`, and transient socket failures.
  - Inline transient retry handling within `tgQueue.ts`.
- **Reaction Server Action Deduplication & Multi-Tap Counting**:
  - Upgraded `reactionSummaryStore` to aggregate multiple taps per user (`❤️ ×3 Alice`).
  - Server `actionId` indexing in `reactionEventDedupeStore` to allow genuine repeated reactions while eliminating replayed WebSocket reaction echoes.
- **Recall Reconnect Synchronization Deduplication**:
  - Added `recallNotifiedStore` with bounded FIFO tracking to eliminate duplicate recall notices during reconnect catch-up sync.
- **Telegram Audio Bridging**:
  - Native bridging of Telegram audio messages (`mp3`, `flac`, `wav`, `m4r`) to Zalo as document attachments with preserved filenames.
- **Multi-Account Support**:
  - Indexed environment variable parser supporting $N$ Zalo accounts mapped to $N$ dedicated Telegram supergroups (`ACCOUNTS=acc1,acc2,...` + `TG_TOKEN_<ID>`, `TG_GROUP_ID_<ID>`).
  - Sub-directory data isolation (`data/accounts/<account_id>/`) for topic mappings, quote maps, member caches, and session credentials.
  - Dedicated Architecture Decision Record: [`docs/adr/ADR-001-multi-account-architecture.md`](docs/adr/ADR-001-multi-account-architecture.md).
- **Interactive Duplicate Connection Login Prompt**:
  - Interactive inline keyboard with `[🔄 Đăng nhập lại ngay]` callback button when Zalo disconnects due to duplicate session login.
- **Scheduled Daily Noon Restart**:
  - Node.js internal scheduler triggering clean store flush and graceful exit (code `42`) at 12:00 PM noon daily.
- **Windows Hourly Watchdog**:
  - PowerShell watchdog script (`scripts/windows-watchdog.ps1`) for automated 1-hour liveness monitoring and auto-restart via Windows Task Scheduler.
- **Telegram Priority Queueing**:
  - Dual-priority queue (`high` for user commands/reactions, `normal` for background forwards) in `src/utils/tgQueue.ts` with timer-based 429 back-off sleep.
- **Media Conversion Worker Pool**:
  - Concurrency limiter (`withMediaSlot`) restricting concurrent `ffmpeg` and Lottie canvas conversions to 3 workers to prevent CPU saturation.

### Improved
- **Non-Blocking Store Persistence**:
  - Converted `msgStore`, `userCache`, and `pollStore` debounced flush routines from synchronous `gzipSync` + `writeFileSync` to non-blocking async gzip level 6 and `fs/promises.writeFile`.

### Fixed
- **Duplicate connection issue**: Fixed Zalo reconnection logic to TG bridge getting duplicate connection error after ~1 day by properly stopping the old WebSocket listener before starting a new one (`src/index.ts`)
- **Session keepalive**: Added 2-minute periodic `keepAlive()` call to maintain Zalo session freshness and prevent silent disconnects (`src/index.ts`)
- **Graceful shutdown**: Added proper cleanup of keepalive interval and Zalo listener on shutdown (`src/index.ts`)

### Improved
- **Hidden group member scanning** (`src/zalo/handler.ts`):
  - Added exponential backoff with jitter for `getUserInfo()` batch calls (3 retries, max 10s delay)
  - Added rate limiting awareness: increases delay on 429 errors, decreases on success
  - Persistent scan cache with 24h TTL survives restarts (prevents re-scanning on boot)
  - Lazy scanning: groups only scanned when messages arrive or user triggers via `/group_info` or opening topic
  - Better logging for hidden-member groups with clear `/loginapp` guidance
- **Per-group exclusion & topic pause** (`src/store.ts`, `src/telegram/handler.ts`):
  - Added `paused` flag to `TopicEntry` to temporarily stop forwarding
  - Added `excludedZaloIds` array persisted in `topics.json`
  - New commands: `/topic pause`, `/topic resume`, `/topic exclude`, `/topic delete` (excludes automatically)
  - `/topic delete` now adds group to exclusion list to prevent auto-recreate
  - `/topic resume` removes from exclusion list
  - ENV support: `ZALO_EXCLUDED_GROUPS=123,456`
- **Search enrichment** (`src/telegram/handler.ts`):
  - `/search` now shows Date of Birth (🎂) for top 5 friend results
  - `/search` now shows friend status (✅ Bạn bè, ⏳ Đang chờ, 📩 Đã gửi, 👤 Chưa kết bạn) for top 5 friend results
  - Limited to top 5 to avoid rate limits
- **Group member rescan on topic open** (`src/telegram/handler.ts`):
  - When clicking a group in `/search` results or `/addgroup` to open/create topic, triggers member scan
  - Logs `[Rescan] Triggering member scan for group <id> on topic open` or `[Rescan] Triggering member scan for new group <id>`
- **Login commands**: Added `/loginapp` for PC App API login (required for hidden-member groups)

### Added
- `ZALO_EXCLUDED_GROUPS` environment variable for pre-configured exclusions
- `/topic pause` - pause message forwarding for current topic
- `/topic resume` - resume forwarding and remove from exclusion list
- `/topic exclude` - permanently exclude group and remove topic
- `/topic info` - now shows paused/excluded status
- Member scan logging for troubleshooting hidden-member groups

### Technical
- Exponential backoff helper `withRetry()` with configurable base delay and max retries
- Persistent member cache state (`data/member-cache-state.json.gz`)
- Keepalive interval properly cleared on reconnect and shutdown
- TypeScript strict mode compliance fixes

## [1.0.0] - Initial Release
- Basic Zalo-Telegram bridge with forum topics
- Message forwarding (text, media, albums, stickers, polls)
- Reaction sync (Telegram ↔ Zalo)
- Auto-reply for DMs
- Search, history, group management commands
# Zalo ↔ Telegram Bridge Migration Guide: Single Account to Multi-Account

This guide provides step-by-step instructions for existing users running a single-account `zalo-tg` bridge to transition to the multi-account architecture without losing conversation topics, message maps, user caches, or active Zalo login sessions.

---

## Overview of Changes

| Feature | Single-Account (Legacy) | Multi-Account (New) |
| :--- | :--- | :--- |
| **Configuration** | Flat variables (`TG_TOKEN`, `TG_GROUP_ID`) | Indexed variables (`ACCOUNTS=acc1,acc2` + `TG_TOKEN_<ID>`, etc.) |
| **Data Directory** | `data/` | `data/accounts/<account_id>/` |
| **Credentials** | `credentials.json` | `data/accounts/<account_id>/credentials.json` |
| **Rate Limits** | Shared Telegram quota | Dedicated Telegram Bot token & quota per account |
| **Backward Compatibility** | ✅ Fully supported (if `ACCOUNTS` is unset) | ✅ Supported |

---

## Migration Steps

### Step 1: Gracefully Stop the Running Bridge
If you are running the bridge in terminal, Docker, or Windows Service, stop the process:
- Terminal: Press `Ctrl + C`
- Docker: `docker compose down`

---

### Step 2: Migrate Existing Data & Credentials to Account 1

To preserve your existing topic mappings, message quotes, user caches, and login session for your primary account, move the legacy files into `data/accounts/acc1/`.

#### On Windows (PowerShell):
```powershell
# Create the isolated account directory
New-Item -ItemType Directory -Force -Path "data\accounts\acc1"

# Move existing database and cache files
Move-Item -Path "data\topics.json" -Destination "data\accounts\acc1\" -ErrorAction SilentlyContinue
Move-Item -Path "data\msg-map.json.gz" -Destination "data\accounts\acc1\" -ErrorAction SilentlyContinue
Move-Item -Path "data\user-cache.json.gz" -Destination "data\accounts\acc1\" -ErrorAction SilentlyContinue
Move-Item -Path "data\polls.json.gz" -Destination "data\accounts\acc1\" -ErrorAction SilentlyContinue

# Move existing credentials
Move-Item -Path "credentials.json" -Destination "data\accounts\acc1\credentials.json" -ErrorAction SilentlyContinue
```

#### On Linux / macOS (Bash):
```bash
mkdir -p data/accounts/acc1
mv data/topics.json data/accounts/acc1/ 2>/dev/null || true
mv data/msg-map.json.gz data/accounts/acc1/ 2>/dev/null || true
mv data/user-cache.json.gz data/accounts/acc1/ 2>/dev/null || true
mv data/polls.json.gz data/accounts/acc1/ 2>/dev/null || true
mv credentials.json data/accounts/acc1/credentials.json 2>/dev/null || true
```

---

### Step 3: Create Additional Telegram Bots & Supergroups

For each new Zalo account you want to connect:
1. Open [@BotFather](https://t.me/BotFather) on Telegram and create a new bot (e.g. `ZaloBridgeWorkBot`) to receive a unique `TG_TOKEN`.
2. Create a new Telegram supergroup.
3. Open group settings and **enable Topics**.
4. Add your new bot into the supergroup and grant it **Administrator** privileges.
5. Retrieve the negative supergroup ID (`TG_GROUP_ID`).

---

### Step 4: Update `.env` Configuration

Open your `.env` file and define the `ACCOUNTS` list and indexed account variables:

```env
# ─── 1. Multi-Account Index (comma-separated list of account IDs) ─────────────
ACCOUNTS=acc1,acc2

# ─── Account 1: Personal (Migrated Existing Session) ──────────────────────────
ACCOUNT_NAME_ACC1=Personal Zalo
TG_TOKEN_ACC1=your_existing_primary_tg_bot_token
TG_GROUP_ID_ACC1=-100xxxxxxxxxx
ZALO_CREDENTIALS_PATH_ACC1=./data/accounts/acc1/credentials.json
DATA_DIR_ACC1=./data/accounts/acc1
ZALO_SKIP_MUTED_GROUPS_ACC1=0
ZALO_MUTE_SILENT_ACC1=1

# ─── Account 2: Work (New Account) ────────────────────────────────────────────
ACCOUNT_NAME_ACC2=Work Zalo
TG_TOKEN_ACC2=your_second_tg_bot_token_from_botfather
TG_GROUP_ID_ACC2=-100yyyyyyyyyy
ZALO_CREDENTIALS_PATH_ACC2=./data/accounts/acc2/credentials.json
DATA_DIR_ACC2=./data/accounts/acc2
ZALO_SKIP_MUTED_GROUPS_ACC2=1
ZALO_MUTE_SILENT_ACC2=1
```

---

### Step 5: Build and Start the Bridge

Recompile TypeScript and start the bridge:

```bash
npm run build
npm start
```

### Expected Startup Behavior:
1. **Account 1 (Migrated)**: Loads `data/accounts/acc1/credentials.json`, authenticates automatically, and resumes message forwarding into Supergroup 1 without requiring QR scanning.
2. **Account 2 (New)**: Posts an alert into Supergroup 2:
   ```
   ⚠️ Chưa đăng nhập Zalo. Gửi /login để đăng nhập.
   ```
3. Send `/login` in Supergroup 2 and scan the QR code using your second Zalo mobile app.
4. Both accounts will now run concurrently in the same process instance with isolated topics and quotas.

---

## Troubleshooting

- **Q: What if I only have one account for now?**
  - You can leave `ACCOUNTS` commented out or unset in `.env`. The bridge will continue to read the traditional `TG_TOKEN`, `TG_GROUP_ID`, `DATA_DIR`, and `ZALO_CREDENTIALS_PATH` variables.
- **Q: Can accounts share the same Telegram supergroup?**
  - To prevent topic ID collisions and preserve clean conversation context, each Zalo account must have its own dedicated Telegram supergroup.

# Xposter

Human-in-the-loop X (Twitter) reply automation for Pune / Marathi topics.

Runs locally on macOS. Reads your logged-in X timeline via Playwright, filters for
Marathi/English posts about Pune/rain/traffic, generates replies with Groq's free LLM,
and sends a push notification to your iPhone for approval before posting anything.

---

## 3. Setup Instructions

### Required accounts & API keys

#### A. Groq API (free, required for LLM)
1. Go to <https://console.groq.com>
2. Sign up for a free account
3. Navigate to **API Keys → Create API Key**
4. Copy the key — it starts with `gsk_`
5. Free tier: 14,400 requests/day, no credit card required

#### B. ntfy (free, required for iPhone notifications)
1. Install the **ntfy** app from the iOS App Store
2. No account needed — just pick a private topic name (treat it like a password)
   - Example: `xposter-akshay-4f8b2c` (use something hard to guess)
3. In the ntfy app: tap **+** → enter your topic name → subscribe
4. That's it — no server-side registration needed for `ntfy.sh`

#### C. Find your Mac's local IP (for ntfy action buttons)
```bash
ipconfig getifaddr en0
# Example output: 192.168.1.105
```
This must be reachable from your iPhone. Both devices must be on the same WiFi network,
**or** you can use Tailscale/ngrok and put that URL as `CALLBACK_BASE_URL`.

---

### Environment variables

```bash
cp .env.example .env
```

Edit `.env`:

| Variable | Required | Description |
|---|---|---|
| `GROQ_API_KEY` | ✅ | From Groq console |
| `NTFY_TOPIC` | ✅ | Your private ntfy topic name |
| `CALLBACK_BASE_URL` | ✅ | `http://<mac-lan-ip>:3000` |
| `API_KEY` | Recommended | Random secret for ntfy callbacks (`openssl rand -hex 32`) |
| `BROWSER_HEADLESS` | — | `false` for first login, `true` after |
| `INGEST_CRON` | — | Default `*/15 * * * *` (every 15 min) |
| `GROQ_MODEL` | — | Default `llama-3.3-70b-versatile` |

---

## 4. Local setup

```bash
# 1. Install Node 20+ (via nvm or brew)
node --version  # must be >= 20

# 2. Clone / enter project
cd /path/to/Xposter

# 3. Install dependencies + Playwright browser
npm run setup

# 4. Configure environment
cp .env.example .env
# Edit .env with your GROQ_API_KEY, NTFY_TOPIC, CALLBACK_BASE_URL
```

---

## 5. First-time X login

The browser session is stored in `./browser-profile/` and persists across restarts.
You only need to do this once.

```bash
# Step 1: open browser visibly
echo "BROWSER_HEADLESS=false" >> .env  # or edit .env manually

# Step 2: start the app — a browser window opens
npm run dev

# Step 3: in the browser that opens, go to x.com and log in normally
# Step 4: once logged in, close the app (Ctrl+C)

# Step 5: switch back to headless
# Edit .env: set BROWSER_HEADLESS=true
npm run dev  # runs silently in background from now on
```

---

## 7. Run instructions

### Development (with live reload)
```bash
npm run dev
```

### Production
```bash
npm run build
npm start
```

### Dashboard
Open <http://localhost:3000> in your browser.

### Run as a macOS background service (launchd)

Create `~/Library/LaunchAgents/com.xposter.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>             <string>com.xposter</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>/Users/YOUR_USERNAME/Xposter/dist/index.js</string>
  </array>
  <key>WorkingDirectory</key>  <string>/Users/YOUR_USERNAME/Xposter</string>
  <key>RunAtLoad</key>         <true/>
  <key>KeepAlive</key>         <true/>
  <key>StandardOutPath</key>   <string>/Users/YOUR_USERNAME/Xposter/logs/launchd.log</string>
  <key>StandardErrorPath</key> <string>/Users/YOUR_USERNAME/Xposter/logs/launchd-err.log</string>
</dict>
</plist>
```

```bash
launchctl load ~/Library/LaunchAgents/com.xposter.plist
launchctl start com.xposter
```

---

## Approval workflow

1. Xposter ingests your X timeline every 15 minutes (configurable)
2. Relevant posts → scored → top 3 sent to Groq for reply generation
3. iPhone receives ntfy notification:
   - Shows original tweet + generated reply
   - Two action buttons: **✅ Approve** / **❌ Skip**
4. Tap **Approve** → reply is posted via browser automation with human-like delays
5. Tap **Skip** → post is discarded
6. Alternatively: use the web dashboard at `http://localhost:3000`

---

## Tests

```bash
npm test                  # run all tests
npm run test:watch        # watch mode
npm run test:coverage     # with coverage report
```

---

## 8. Future improvements

- **Tailscale integration**: auto-detect Tailscale IP for always-reachable callbacks
- **Multiple LLM fallbacks**: try Groq → OpenRouter → Hugging Face in sequence
- **Reply tone settings**: formal / casual / humorous selector per topic type
- **Engagement tracking**: track which posted replies got liked/replied to, feed back into scoring
- **Smart deduplication**: semantic similarity via embeddings (not just Jaccard)
- **macOS menu bar app**: status indicator + quick approve from menu bar
- **X API v2 integration**: supplement browser ingestion with official API for reliability
- **Multi-account support**: route different topics to different accounts

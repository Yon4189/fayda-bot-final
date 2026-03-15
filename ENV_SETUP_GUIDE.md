# Complete .env Setup Guide

Step-by-step guide to get every variable correct for **local** and **Railway** deployment.

---

## Quick checklist

| Variable        | Source                              | Description                             |
|----------------|-------------------------------------|-----------------------------------------|
| BOT_TOKEN      | @BotFather                          | Your bot token                          |
| MONGODB_URI    | MongoDB Atlas                       | Database connection string              |
| REDIS_URL      | Upstash / Railway                   | Redis connection string                 |
| SESSION_SECRET | Random string                       | For dashboard login security            |
| WEBHOOK_DOMAIN | Railway / Ngrok                     | Your application URL                    |
| CAPTCHA_KEY    | 2Captcha                            | 2Captcha API Key (for captcha solving)  |
| FAYDA_APP_API_KEY | Admin-provided                   | Mobile API Key (No captcha needed)      |

---

### Step 2: 2Captcha API Key (Fallback)

If you do not have a `FAYDA_APP_API_KEY`, the bot will use the Resident Portal API which requires solving captchas.

1.  Create an account at [2Captcha](https://2captcha.com/).
2.  Add funds (a small amount is enough for many downloads).
3.  Copy your **API Key** from the dashboard.

| Variable | Description | Example |
| :--- | :--- | :--- |
| `BOT_TOKEN` | Telegram Bot Token from BotFather | `123456:ABC-DEF...` |
| `CAPTCHA_KEY` | 2Captcha API Key | `41c7b8...` |
| `FAYDA_APP_API_KEY` | (Optional) Mobile App Token | `ey...` |
| `MONGODB_URI` | MongoDB Connection String | `mongodb+srv://...` |

## 1. BOT_TOKEN (Telegram)

1. Open Telegram, search for **@BotFather**.
2. Send: `/newbot`.
3. Choose a name (e.g. "Fayda PDF Bot").
4. Choose a username ending in `bot` (e.g. `fayda_pdf_bot`).
5. BotFather replies with a token like: `8251825611:AAH7mlvidD-jA65FQxO5dKNDfq2ZjLzm7pM`.
6. Copy that **entire** string into `.env`:
   ```env
   BOT_TOKEN=8251825611:AAH7mlvidD-jA65FQxO5dKNDfq2ZjLzm7pM
   ```
   No spaces, no quotes.

---

## 2. Databases (MongoDB & Redis)

---

## 3. MONGODB_URI (MongoDB)

### Option A: MongoDB Atlas (free, recommended)

1. Go to **https://www.mongodb.com/cloud/atlas** → Create account.
2. **Create a project** (e.g. "Fayda Bot").
3. **Build a database** → choose **M0 FREE** → pick a region (e.g. AWS, closest to you).
4. **Create database user**:
   - Username: e.g. `fayda_user`
   - Password: generate and **save it** (e.g. `MySecurePass123!`)
5. **Where to connect from**: **Cloud Environment** → Add **0.0.0.0/0** (allow from anywhere; required for Railway).
6. **Finish** → **Connect** → **Drivers** (or "Connect your application").
7. Copy the connection string. It looks like:
   ```text
   mongodb+srv://fayda_user:<password>@cluster0.xxxxx.mongodb.net/?retryWrites=true&w=majority
   ```
8. Replace `<password>` with your actual password (if it has `@`, `#`, etc., URL-encode it).
9. Add a database name before `?`: use `fayda_bot`:
   ```text
   mongodb+srv://fayda_user:MySecurePass123@cluster0.xxxxx.mongodb.net/fayda_bot?retryWrites=true&w=majority
   ```
10. In `.env`:
    ```env
    MONGODB_URI=mongodb+srv://fayda_user:MySecurePass123@cluster0.xxxxx.mongodb.net/fayda_bot?retryWrites=true&w=majority
    ```

**Common mistakes:**

- Forgetting to replace `<password>`.
- Special characters in password not URL-encoded (e.g. `@` → `%40`).
- Missing database name before `?`.

### Option B: Railway MongoDB

1. In Railway: your project → **New** → **Database** → **Add MongoDB**.
2. Click the MongoDB service → **Variables** (or **Connect**).
3. Copy the variable that looks like `MONGO_URL` or `MONGODB_URI`, e.g.:
   ```text
   mongodb://mongo:27017
   ```
4. Add database name if needed:
   ```env
   MONGODB_URI=mongodb://mongo:27017/fayda_bot
   ```
5. Paste that into Railway **Variables** for your app (and in local `.env` if you use it locally).

---

## 4. REDIS_URL (Redis)

### Option A: Upstash (free, works well with Railway)

1. Go to **https://upstash.com** → Sign up.
2. **Create Database**:
   - Name: e.g. `fayda-bot-redis`
   - Region: same as your app (e.g. us-east-1 if app is in US).
   - Type: **Regional**.
3. Open the database → **REST API** or **Redis Connect**.
4. Copy the **Redis URL**. It looks like:
   ```text
   rediss://default:AXyz...@us1-xxxxx.upstash.io:6379
   ```
   (`rediss` = TLS; the app supports both `redis` and `rediss`.)
5. In `.env` / Railway Variables:
   ```env
   REDIS_URL=rediss://default:AXyz...@us1-xxxxx.upstash.io:6379
   ```
   Paste the **entire** string, no spaces or quotes.

### Option B: Railway Redis

1. In Railway: **New** → **Database** → **Add Redis**.
2. Open the Redis service → **Variables**.
3. Copy **REDIS_URL** (e.g. `redis://default:xxx@redis.railway.internal:6379` or similar).
4. Use that exact value in your app’s **Variables** and in local `.env` if needed.

---

## 5. SESSION_SECRET

Any long random string (at least 32 characters). Used to sign sessions.

**Generate:**

- Terminal: `openssl rand -hex 32`
- Or: https://randomkeygen.com (e.g. "CodeIgniter Encryption Keys")

Example:

```env
SESSION_SECRET=a1b2c3d4e5f6789012345678901234567890abcdef1234567890abcdef
```

Use one value for local and the **same** (or a new one) for Railway.

---

## 6. WEBHOOK_DOMAIN (deployment only)

This **must** be the exact public URL of your app.

**On Railway:**

1. Open your **app service** (not MongoDB/Redis).
2. **Settings** → **Networking** / **Public Networking**.
3. Copy the generated domain, e.g. `idfayda-bot-production.up.railway.app`.
4. Use it **with** `https://` and **no** trailing slash:
   ```env
   WEBHOOK_DOMAIN=https://idfayda-bot-production.up.railway.app
   ```

Wrong:

- `http://...` (must be **https**)
- `https://.../` (no trailing slash)
- `https://.../webhook` (domain only, no path)

---

## 7. PORT and NODE_ENV

- **Railway** usually sets `PORT` (e.g. 8080). You don’t have to set it unless you want to override.
- For **local**:
  ```env
  PORT=3000
  NODE_ENV=development
  ```
- For **Railway** (optional):
  ```env
  NODE_ENV=production
  ```

---

## Example: full .env for local

```env
BOT_TOKEN=...
MONGODB_URI=...
REDIS_URL=...
SESSION_SECRET=...
WEBHOOK_DOMAIN=...
FAYDA_APP_API_KEY=...
PORT=3000
NODE_ENV=development
```

(For local webhook testing you can use a tunnel like ngrok and put that URL in `WEBHOOK_DOMAIN`; for production use the Railway URL.)

---

## Example: Railway Variables

In Railway → your **app service** → **Variables**, add (with your real values):

| Name           | Value                                                                 |
|----------------|-----------------------------------------------------------------------|
| BOT_TOKEN      | (generated from BotFather)                                            |
| MONGODB_URI    | (from MongoDB Cloud)                                                  |
| REDIS_URL      | (from Upstash/Railway)                                                |
| SESSION_SECRET | (any random string)                                                   |
| WEBHOOK_DOMAIN | (your Railway app public domain)                                       |
| FAYDA_APP_API_KEY | (provided separately)                                              |
| NODE_ENV       | production                                                            |

Do **not** commit `.env` to git. Use `.env.example` as a template and this guide to fill it correctly.

---

## Verify

- **MongoDB**: App logs should show `✅ MongoDB connected successfully`. If not, check username/password, IP allowlist (0.0.0.0/0 for Atlas), and that the URI starts with `mongodb`.
- **Redis**: No error on startup about Redis. If rate limit or queue fails, check REDIS_URL (correct `redis://` or `rediss://`, full URL).
- **Webhook**: Logs show `🤖 Webhook active at https://.../webhook`. In Telegram, send `/start` and the bot should reply.

If you tell me which part you’re on (MongoDB, Redis, or Railway Variables), I can give you a minimal checklist for that part only.

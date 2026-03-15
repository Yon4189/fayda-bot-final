# Add Environment Variables to Your Deployment

Your app is failing because **environment variables are not set** in your deployment platform. Add them in the dashboard (not in code).

---

## Required variables

Add these **exact names** and your **real values**:

| Variable         | Where to get it | Description                             |
|------------------|-----------------|-----------------------------------------|
| `BOT_TOKEN`      | Telegram @BotFather                        | Your bot's unique token                 |
| `MONGODB_URI`    | MongoDB Atlas / Local                       | Connection string (starts with `mongodb://`) |
| `REDIS_URL`      | Redis Cloud / Local                         | Connection string (starts with `redis://`) |
| `SESSION_SECRET` | Anything long & random                      | For web dashboard sessions              |
| `WEBHOOK_DOMAIN` | Your deployment URL                         | e.g. `https://fayda-bot.up.railway.app` |
| `FAYDA_APP_API_KEY` | Admin provided                      | Key for direct Fayda API access         |

---

## Railway

1. Open your project: https://railway.app/dashboard  
2. Click your **service** (fayda-bot).  
3. Open the **Variables** tab.  
4. Click **+ New Variable** or **Raw Editor**.  
5. Add each variable:

```
BOT_TOKEN=your_token_here
MONGODB_URI=mongodb://...
REDIS_URL=redis://...
SESSION_SECRET=long_random_string
WEBHOOK_DOMAIN=https://your-app.railway.app
FAYDA_APP_API_KEY=your_fayda_api_key_here
```

6. Replace every value with your real data.  
7. For **WEBHOOK_DOMAIN**: use the URL Railway shows for your service (e.g. **Settings → Domains**).  
8. Save. Railway will **redeploy** automatically.

---

## Render

1. Open https://dashboard.render.com  
2. Click your **Web Service**.  
3. Go to **Environment** in the left menu.  
4. Click **Add Environment Variable**.  
5. Add each variable (name + value).  
6. **WEBHOOK_DOMAIN** = your Render URL, e.g. `https://fayda-bot.onrender.com`  
7. Save. Trigger a **Manual Deploy** if it doesn’t redeploy.

---

## Where to get each value

- **BOT_TOKEN** – From your local `.env` (same as development).  
- **CAPTCHA_KEY** – From your local `.env`.  
- **MONGODB_URI** – From MongoDB Atlas or Railway MongoDB connection string.  
- **REDIS_URL** – From Upstash (https://upstash.com) or Railway Redis.  
- **SESSION_SECRET** – Copy from `.env` or generate: `openssl rand -hex 32`.  
- **WEBHOOK_DOMAIN** – **Must be your live app URL** (Railway/Render domain), with `https://`, no trailing slash.

---

## After adding variables

1. Save in the dashboard.  
2. Wait for the platform to redeploy (or click **Deploy**).  
3. Check logs – the “Missing required environment variables” error should be gone.  
4. Test: open `https://YOUR-DOMAIN/health` and send `/start` to your bot.

---

## Checklist

- [ ] All 6 variables added in the platform (not only in `.env` locally).  
- [ ] `WEBHOOK_DOMAIN` is the **public** URL of the deployed app (e.g. `https://xxx.railway.app`).  
- [ ] No quotes around values in the dashboard.  
- [ ] No spaces before/after `=` if using raw editor.  
- [ ] Redeploy triggered after saving variables.

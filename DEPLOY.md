# NS OS Portal — Deploy Instructions

## What's in this folder

```
ns-os-portal/
├── index.html              ← Login page
├── dashboard.html          ← Main app (dashboard + chat + history)
├── app.js                  ← Login logic
├── netlify.toml            ← Netlify config (routes /api/chat to the function)
├── netlify/
│   └── functions/
│       └── chat.js         ← Serverless function (calls Anthropic API)
└── DEPLOY.md               ← This file
```

## Before you deploy — 2 things to fill in

### 1. Supabase Anon Key
In BOTH `index.html` (line with app.js) and `dashboard.html`, find this placeholder:
```
SUPABASE_ANON_KEY_PLACEHOLDER
```
Replace it with your Supabase **anon** (public) key.
Find it at: https://supabase.com/dashboard/project/omjsqianefykbebnrdmp/settings/api
It starts with: eyJhbGci...

Also replace the same placeholder in `app.js`.

### 2. DO NOT put the Anthropic key in any file
The Anthropic key goes into Netlify as an environment variable (see step 4 below).
It never touches the code files.

---

## Deploy steps

### Step 1 — Zip the folder
Select all files inside `ns-os-portal/` → compress to `ns-os-portal.zip`
(Include the netlify/ subfolder — that's the serverless function)

### Step 2 — Go to Netlify
You're already at: https://app.netlify.com/start
Drag the zip file into the "Upload your project files" box.
Click Deploy.

### Step 3 — Wait ~30 seconds
Netlify will give you a URL like: https://cheerful-sundae-abc123.netlify.app
That's your portal. Write it down.

### Step 4 — Add environment variables
In Netlify dashboard → Your site → Site configuration → Environment variables → Add variable:

| Key | Value |
|-----|-------|
| ANTHROPIC_API_KEY | (the key from Supabase config table, key name: ns-os-custom-build) |

Click Save. Then: Deploys → Trigger deploy → Deploy site.

### Step 5 — Enable Supabase Auth
Go to: https://supabase.com/dashboard/project/omjsqianefykbebnrdmp/auth/providers
Turn ON: Email provider
Turn OFF: "Confirm email" (for now — makes testing easier)

### Step 6 — Create your login
In Supabase: Authentication → Users → Invite user
Enter: coveted.consultant@gmail.com
Set a password.

### Step 7 — Test
Go to your Netlify URL → log in → dashboard should load your data.
Open Daily Brief → say "give me my brief" → Claude should respond with your actual data.

---

## If something breaks
Open Cowork → tell Claude what happened → Claude reads the code and fixes it.
That's the whole maintenance loop.

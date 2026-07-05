# CLAUDE.md — North Star OS Admin Project

This file is read automatically at the start of every session. Follow it in order.

---

## 1 — SESSION START CHECKLIST

Do these before anything else:

1. **Open the Master Tracker artifact** — `ns-custom-build-checklist` in the sidebar. This is the single source of truth for all open work. Do not rely on a handoff document alone.
2. **Read any HANDOFF-*.md files** in this folder — they carry decisions and open items from the previous session.
3. **Read all active LOG- documents relevant to the repo you're touching.** Query Supabase `system_prompts` for active protocol_ids starting with `LOG-` and read them in full — not just the handoff and Master Tracker. Preferred over a static named list, since new LOG docs get created often and a hardcoded list falls behind. `SELECT protocol_id FROM system_prompts WHERE protocol_id LIKE 'LOG-%' AND active = true;`
4. **Establish which mode this session is** — Strategy or Execution (see Section 2).
5. **Read the relevant mode reference documents** before starting work (see Sections 4 and 5).
6. **If something breaks** — go to REF-ERRORS.md before troubleshooting independently. Many errors are already solved and documented there.
7. **Before any change to the data layer** — read `ref-ns-data-architecture` from Supabase system_prompts. This covers every dashboard module, every Supabase field, write paths, formats, and known gaps. A "data layer change" includes: adding/modifying Supabase columns or tables, changing buildContextString() in chat.js, updating CS-11/CS-12/CS-7/TR-2/CS-1 prompt logic, or modifying the dashboard data layer. Fetch it with: `SELECT system_prompt FROM system_prompts WHERE protocol_id = 'ref-ns-data-architecture';`
8. **Before any change to chat.js or any file under netlify/functions/lib/** — read `ref-chat-js-architecture` from Supabase system_prompts. chat.js is the triggering component of the entire portal — every client message routes through it. This document maps the router/per-room-file/shared-module split, the handler pattern every room follows, and the failure modes already caught during the 2026-07-02 restructuring (ERR-NET-31, ERR-NET-32). Fetch it with: `SELECT system_prompt FROM system_prompts WHERE protocol_id = 'ref-chat-js-architecture';`
9. **Before editing dashboard.html or any file under netlify/functions/ from the local workspace folder copy** — check ERR-NET-26 in `LOG-DEPLOY-ERRORS` (Supabase system_prompts) and apply it now, at edit-start, not just at push time. It governs workspace-freshness risk (the local folder is a mirror, not a live clone) and the exact check to run. Do not restate or re-derive this logic here — ERR-NET-26 is the single source of truth and gets refined over time; read it fresh each time. Fetch it with: `SELECT system_prompt FROM system_prompts WHERE protocol_id = 'LOG-DEPLOY-ERRORS' AND active = true;`

**At the end of every session:** Update the Master Tracker artifact to reflect what was completed, what is still open, and any new items discovered. This is not optional.

---

## 2 — HOW TO WORK IN THIS PROJECT

Every session operates in one of two modes. Establish which one applies before doing anything.

### Strategy Mode
Alzay is thinking through product design, architecture, user experience, onboarding flow, prompt design, or tier structure. Claude's job is to understand the full connected system, hold the implications of decisions across all three layers (frontend, serverless, Supabase), and push back with informed perspective.

**The strategist rule:** Every design decision has execution implications. Before agreeing to a direction, name what it would require to build, what it could break, and what else would need to change. A strategy session that ignores execution produces plans that break things.

### Execution Mode
Alzay wants something built, changed, pushed, or fixed. Claude's job is to identify everything that needs to change across all three layers, flag what could break, and execute precisely.

**The executor rule:** Every execution task has a strategic context. Before touching anything, confirm the change aligns with the current architectural direction. An execution that ignores strategy solves the wrong problem.

### Why They Must Stay Connected
The custom portal is a three-layer system — frontend (dashboard.html), serverless function (chat.js), and Supabase (prompts + data). A change to one layer almost always has implications for the others. A strategist who doesn't know the execution constraints will design something unbuildable. An executor who doesn't know the strategic direction will build the wrong thing precisely. These modes are lenses, not silos.

### How To Identify the Mode
- Alzay is talking through options, asking "what do you think," or mapping how something should work → **Strategy**
- Alzay says "let's build it," "make that change," "push that," or names a specific file or prompt to update → **Execution**
- A session that starts in strategy often shifts to execution. When it does, apply the executor rule before touching anything.

### Execution Trigger — go-build-it Skill
When Alzay says "go build it," "update the site," "push it," or "execute" — automatically invoke the **go-build-it** skill. Do not ask permission. Do not freestyle the sequencing. The skill governs how changes are sorted by layer (Supabase → serverless → frontend), batched by size, and pushed one at a time with a countdown. Always use it. This is the standing default for all execution in this project.

---

## 3 — WHAT THIS PROJECT IS

Two parallel tracks:

**1. Custom Build (primary focus as of June 9, 2026)** — A direct NS OS client portal on Supabase + Anthropic API. No intermediary platform. Claude manages all code, pushes via GitHub MCP, Netlify auto-deploys in ~10 seconds.

**2. Pickaxe (sunset in progress)** — The original deployment. Still serving real clients. Do not build new things in Pickaxe. Maintain it only while clients remain on the platform. Full operational reference is in REF-PICKAXE.md.

**Three things happen in this project:**
1. Build and iterate on the custom portal (primary)
2. Maintain Pickaxe while clients are still on it (secondary)
3. Manage the shared Supabase database — used by both

### Source of Truth Convention
**Decided June 10, 2026 — architectural commitment, not a preference.**

- **Supabase = live environment.** The `system_prompts` table is where governing docs and protocols live, are edited, and are read from. Edits happen here directly.
- **Google Drive = legacy archive.** Drive documents represent the last known good Pickaxe-era version. Frozen. Do not sync Drive to Supabase. Drive is useful only as a reference for what the old version said.
- **If Drive and Supabase ever conflict — Drive wins.** Fix Drive first, then sync to Supabase.

How document updates work: read current doc from Supabase → discuss and revise → write updated version back to Supabase. No Drive paste step.

**Every protocol edit must archive the outgoing version to `changelog` (table in Supabase) BEFORE overwriting the `system_prompts` row.** The `changelog` table holds every superseded version plus `entry_type` (protocol / update / archived_before_rewrite) and `changed_by` — it is the actual version history and audit trail for every skill file. Skipping this step means the old version is gone with no record. This was found to be silently skipped at least once (CS-1 s1.1 → s1.2, July 1, 2026) — the archive was backfilled after the fact, but the underlying step should never be skipped going forward.

### Architecture Decisions (Permanent)

- **One shared Supabase database** for Alzay + all clients. Separation via UUID. No split until 15-20 clients or Q3 2026 review.
- **Email is the lookup key** at session start. UUID governs all downstream queries.
- **`profiles` table** is the user identity table — never `users` (namespace collision with Supabase internals).
- **RLS not implemented** — WHERE clause filtering only. Must enable before first real client on custom portal.
- **Custom build passes email via Supabase Auth session** — serverless function reads authenticated user's email, looks up UUID in profiles, uses UUID for all downstream queries.
- **Two-tier product structure (decided June 10, 2026):** Digital users ($99/month) get a bronze operating picture built through the CS-11 onboarding conversation. Coaching/advanced clients get a gold operating picture built through formal documents uploaded via CS-12. CS-12 is gated to the advanced tier. Every user — including coaching clients — starts with CS-11 first.
- **Chat A routes automatically (decided June 10, 2026):** The serverless function checks `annual_operating_picture` for the user's UUID before loading any prompt. If no row exists → fire CS-11 silently. If a row exists → route to CS-12. The user never sees the routing decision. Chat A's governing document is effectively retired — routing is handled by the function, not the prompt.
- **NEVER use a person's name as a Supabase filter value.** The ONLY valid filter for all downstream queries is `user_id=eq.[UUID]`. This has caused production errors and must be stated explicitly in every prompt that touches Supabase.

---

## 4 — STRATEGY MODE: WHAT TO READ

When the session is strategic, read these before forming opinions or making recommendations:

| Document | What it contains |
|----------|-----------------|
| REF-PHILOSOPHY-ARCHITECTURE.md | NS OS architectural intent, three-chat standard, governing doc vs. protocol distinction, loading order, naming conventions, permanent design decisions |
| REF-STACK.md | Full system map — all tools, how they connect, what depends on what |
| `system_prompts` table in Supabase | What is currently built and live — governing docs, protocols, agent prompts. Query by `skill_id`. |
| REF-ojoy_walkthrough_visual.html | Onboarding design benchmark — Frank Kern / oJoy 11-page walkthrough with NS OS design decisions extracted |

**The strategist standard:** Before recommending a change, name what it touches across all three layers, what it could break, and what else would need to change. Strategy without execution awareness is a liability.

---

## 5 — EXECUTION MODE: WHAT TO TOUCH

When the session is execution, use these references:

### Custom Build — Stack + Deploy

| Thing | Value |
|-------|-------|
| GitHub repo | github.com/covetedconsultant/ns-os-portal (public) |
| Live URL | sprightly-starburst-210796.netlify.app |
| Serverless function | netlify/functions/chat.js |
| Dashboard | dashboard.html |
| GitHub token | Supabase config table, key = `github_token` |
| Anthropic API key | Supabase config table, key = `ns-os-custom-build` |

**Deploy workflow:** As of 2026-07-04, the Claude GitHub MCP connector (`api.githubcopilot.com/mcp`) is confirmed broken for writes — it authenticates and reads fine, but every write call (`create_or_update_file`, `push_files`) returns `403 Resource not accessible by integration`. GitHub's own Authorized GitHub Apps page confirms the app has only ever been OAuth-authorized, never actually installed — a full disconnect/revoke/reconnect cycle did not fix it. Treat this as a known Anthropic-side connector gap, not a local misconfiguration.

**Until that connector is fixed, push via direct sandbox PUT to the GitHub Contents API** (per ERR-NET-11 in REF-ERRORS.md): read the target file fresh from disk, base64-encode it in the sandbox, and `curl -X PUT` to `https://api.github.com/repos/covetedconsultant/ns-os-portal/contents/[path]` using `Authorization: Bearer [token]`, with the token pulled fresh from Supabase `config` table key `github_token`. Never hand-type or reconstruct file content — always read fresh from disk immediately before the push. After every push, verify by fetching the file back and confirming byte-for-byte match against the local source (see ERR-NET-9, ERR-NET-11 for why this check matters). Netlify still auto-deploys off the GitHub push in ~10 seconds — no manual step there.

Periodically retest whether `mcp__github__push_files` works again after an Anthropic-side fix; revert to it once confirmed.

**Visual changes rule:** For any CSS or layout change to dashboard.html, build and verify in a Cowork artifact first before pushing. Logic, routing, and data changes (chat.js, Supabase queries) push directly — no artifact needed.

### Test Login Credentials (hardcoded in app.js — no real auth yet)

| User | Email | Password | UUID |
|------|-------|----------|------|
| Alzay | coveted.consultant@gmail.com | alzay123 | 39d59f4c-3c98-4469-b65c-000ee97cf913 |
| Diana (test) | moveoutofmichigan@gmail.com | diana123 | 149ec2e7-27f1-48fc-9a7c-abacd9be2fc1 |

**To test as Diana:** go to live URL, log in as Diana, open Daily Brief, type `b`.

### MCP Connections

- **Supabase MCP** — connected to project `omjsqianefykbebnrdmp`
- **GitHub MCP** — reads fine; writes currently broken (see Deploy Workflow above). Use sandbox-direct PUT for all pushes until fixed.
- **Zapier MCP** — connected to Alzay's Zapier account
- **ActiveCampaign MCP** — contact/list/automation management
- **Google Drive MCP** — reading/editing Drive skill files

### Supabase Access

**Project ID:** omjsqianefykbebnrdmp
**Service role key:** stored in config table as `supabase_service_role_key` — retrieve from there, never paste in chat.

**Key People**

| Person | UUID | Email |
|--------|------|-------|
| Alzay | 39d59f4c-3c98-4469-b65c-000ee97cf913 | coveted.consultant@gmail.com |
| Diana (test) | 149ec2e7-27f1-48fc-9a7c-abacd9be2fc1 | moveoutofmichigan@gmail.com |

**Table Names**
- `profiles` — user identity (was `users` — renamed June 3, 2026)
- `annual_operating_picture` — core user operating picture
- `session_receipts` — session history
- `quarterly_dashboard_content` — quarterly focus data
- `daily_dashboard_content` — daily dashboard
- `weekly_planning_reports` — weekly plans
- `config` — API keys and configuration values
- `playbook_sessions` — VT playbook session records
- `system_prompts` — all governing docs, protocols, agent prompts

**Query Pattern:** All queries use `user_id` (UUID), not `user_name`.
```sql
SELECT * FROM annual_operating_picture WHERE user_id = '[UUID]' ORDER BY created_at DESC LIMIT 1;
```

**system_prompts table structure:**
- `prompt_type`: `governing` (what the CoS IS) | `protocol` (what the CoS DOES) | `agent` (full routing prompt for chat-a/b/c)
- `source`: `google_drive` (Drive is authoritative) | `supabase` (lives only in Supabase)
- Fetch by skill_id: `getPrompt('chat-b')`, `getPrompt('cs-1')`, etc.

### Execution Reference Documents

| Document | When to use |
|----------|------------|
| REF-SUPABASE.md | Any Supabase work — schemas, query patterns, critical rules |
| REF-ERRORS.md | When something breaks — indexed by tool and symptom |
| REF-PICKAXE.md | Any Pickaxe work — agents, CLI, API, supabasequery action |
| REF-ZAPIER.md | Any Zapier work — full Zap architecture |
| REF-AC.md | Any ActiveCampaign work — lists, tags, automations, diagnostic commands |
| REF-TEST-USERS.md | Any time a new test user is needed — naming convention, email pattern, tracking table, next available number |

### Testing Protocol

**Diana Reyes test:** Log in as `moveoutofmichigan@gmail.com`, open Daily Brief, type `b`. Expected: greets as "Diana," assembles brief from her `annual_operating_picture`.

**Diagnostic:** After any test, check the Action runs tab on `supabase_query` in Pickaxe. Look at "AI Filled Inputs" — if blank, the agent called the action but passed no parameters.

**Weekly health check:** Log in as Diana, open Daily Brief, say "hi." If greeted as "Diana" — Supabase connection is healthy.

---

## 6 — OPERATIONAL QUICK REFERENCE

### ActiveCampaign — NS OS Automation

**Automation name:** NS OS Chief of Staff Customers
**Direct URL:** https://evenbetterconsulting.activehosted.com/app/builder/259
**Status:** Active
**Trigger:** Contact subscribes to list "NS OS Chief of Staff Customers"
**Steps:** Send email ("Your Chief of Staff account is being set up") → Subscribe to Coveted Consultant Customer Lis
// netlify/functions/chat.js
// deploy: 2026-07-01-cs16-direct-dispatch
// ERR-NET-25 fix: verifyUserId() rejects any request whose Authorization
// bearer token doesn't match the claimed userId. See LOG-DEPLOY-ERRORS.
// Daily Brief active memory (Item 4): room='chat' loads the rolling DAILY_LOOKBACK_DAYS
// of its own verbatim conversation as context; older history carried by receipts.
// Routing by room:
//   room=setup        → CS-11 (no AOP) or CS-12 (has AOP) — onboarding/document intake
//   room=chat         → direct dispatch via detectDailyBriefRoute(): CS-1 (North Star Brief)
//                        or CS-16 (Talk Something Through). chat-b RETIRED 2026-07-01 — see
//                        LOG-cs-16 and LOG-c-north-star-room. No base document loads underneath
//                        either path; CS-1 and CS-16 are each fully self-contained.
//   room=prep         → chat-c (Prep Room agent)
//   room=virtualteam  → a Virtual Team box prompt (vt-*), selected by boxId from the frontend
// CS-9, CS-Receipt load on-demand inside chat (room=chat) only.
// CS-Receipt also loads on-demand inside virtualteam (close fires the unified receipt + box_built).
// AOP write: when CS-11 outputs %%AOP%%...%%END_AOP%%, chat.js extracts the JSON
// and writes the row to annual_operating_picture before returning the response.
// REPORT WRITES (2026-07-01): CS-15 (Weekly Plan) and CS-13/CS-14 (quarterly Look
// Backward/Forward) instruct the AI to "write to Supabase" as if it has direct tool
// access. It does not — chat.js is the only thing that can write, same as AOP/RECEIPT.
// Fixed by adding two more marker/extract/write pairs, same shape as AOP:
//   %%WEEKLY_PLAN%%...%%END_WEEKLY_PLAN%%  → weekly_planning_reports
//   %%QUARTERLY%%...%%END_QUARTERLY%%      → quarterly_reviews + quarterly_dashboard_content
// Conversation logging: user message written BEFORE Anthropic call; assistant message written after.
// Same-day restore: response includes hasLogsToday flag so frontend can restore thread if same day.

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const SUPABASE_URL = 'https://omjsqianefykbebnrdmp.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const MODEL = 'claude-sonnet-4-6';

// Virtual Team box prompts — the ONLY protocol_ids room=virtualteam may load.
// Frontend buttons send the entry-point boxId (the "a" prompt where a box has sub-flows).
// The b/c sub-flows are reachable from inside their parent box, so they are allowlisted too.
const VT_BOX_IDS = ['vt-2a','vt-2b','vt-3a','vt-3b','vt-4a','vt-4b','vt-4c','vt-5','vt-6','vt-7','vt-8','vt-8b','vt-9','vt-10'];

// Map of Box N → human label, used for rooms_visited in the receipt close block.
const VT_BOX_LABELS = {
  'vt-2a':'Box 2 Avatar Leader','vt-2b':'Box 2 Avatar Leader','vt-3a':'Box 3 Invite Leader','vt-3b':'Box 3 Invite Leader',
  'vt-4a':'Box 4 Converse Leader','vt-4b':'Box 4 Converse Leader','vt-4c':'Box 4 Service Package',
  'vt-5':'Box 5 Onboard Leader','vt-6':'Box 6 Deliver Leader','vt-7':'Box 7 Recap Leader',
  'vt-8':'Box 8 Consult Leader','vt-8b':'Box 8 CXO Service Summary','vt-9':'Box 9 Repeat Leader','vt-10':'Box 10 Delight Leader'
};

// ── PREP ROOM ROUTING ────────────────────────────────────────────────────────
// Detects the opening message and loads the correct protocol directly.
// Prevents the mid-conversation load hang where chat-c instructs the AI to
// 'load and execute' a downstream protocol — which fails in the portal because
// the AI has no Supabase tool access inside chat.js.
//
// Button phrases (from dashboard.html prefill-btn onclick values):
//   'My weekly check-in.'               → cs-15 (was tr-2 — tr-2 retired 2026-07-01, see LOG-cs-15)
//   "I'd like to do my quarterly review." → menu-quarterly-review-prep
//   anything else                        → chat-c (shows A/B menu)
function detectPrepRoute(messages) {
  if (!messages || messages.length === 0) return 'chat-c';
  const firstUserMsg = messages.find(m => m.role === 'user');
  if (!firstUserMsg) return 'chat-c';
  const text = firstUserMsg.content.toLowerCase().trim();
  if (text.includes('weekly check-in') || text.includes('weekly checkin') || text.includes('weekly check in')) {
    return 'cs-15';
  }
  if (text.includes('quarterly review')) {
    return 'menu-quarterly-review-prep';
  }
  return 'chat-c';
}

// ── DAILY BRIEF ROOM ROUTING (added 2026-07-01) ─────────────────────────────
// Detects the opening message and dispatches directly to CS-1 or CS-16 — no
// base document (chat-b) loads underneath either path anymore. Mirrors the
// detectPrepRoute model above. Replaces the prior "always load chat-b first,
// append CS-1 on top" pattern (chat-b retired — see LOG-cs-16).
//
// Button phrases (from dashboard.html prefill-btn onclick values, room=chat group):
//   "I'd like to see my North Star brief."     → cs-1
//   "I'd like to talk something through."      → cs-16
// Edge-case redirects (previously chat-b's own text, folded in here so they
// aren't duplicated inside CS-1 or CS-16):
//   mentions document upload                    → redirect-upload
//   mentions quarterly review                    → redirect-quarterly
//   anything else / ambiguous                    → cs-16 (accompanying mode is
//     the correct default for an unmatched opening — CS-16 receives whatever
//     the client arrives with, which is the safer fallback than CS-1's
//     structured brief for a message that doesn't clearly ask for one)
function detectDailyBriefRoute(messages) {
  if (!messages || messages.length === 0) return 'cs-16';
  const firstUserMsg = messages.find(m => m.role === 'user');
  if (!firstUserMsg) return 'cs-16';
  const text = firstUserMsg.content.toLowerCase().trim();

  if (text.includes('upload') && (text.includes('document') || text.includes('file'))) {
    return 'redirect-upload';
  }
  if (text.includes('quarterly review')) {
    return 'redirect-quarterly';
  }
  if (text.includes('north star brief') || text.includes('morning brief') ||
      text.includes('my brief') || text.includes('show me my') || text === 'b') {
    return 'cs-1';
  }
  if (text.includes('talk something through') || text.includes('talk it through') ||
      text.includes('talk something out') || text === 'a') {
    return 'cs-16';
  }
  // Ambiguous opening — default to CS-16's accompanying mode, which is built
  // to receive whatever the client arrives with rather than force a brief.
  return 'cs-16';
}

// Build the receipt close-protocol block appended to a room's system prompt when the user
// signals close. Shared by room=chat (Daily Work) and room=virtualteam (a VT box session).
// `opts` overrides the receipt defaults so VT closes carry trigger_context=virtual_team,
// the right rooms_visited, and box_built.
function buildReceiptCloseBlock(csReceiptPrompt, opts) {
  const o = opts || {};
  const triggerContext = o.triggerContext || 'daily_work';
  const roomsVisited = o.roomsVisited || 'Daily Work — Chief of Staff';
  const boxBuiltLine = o.boxBuilt ? `,"box_built":"${o.boxBuilt}"` : '';
  return '\n\n---\n\n## CS-RECEIPT — SESSION CLOSE PROTOCOL\n\n' + csReceiptPrompt +
    '\n\n---\n\n## CUSTOM BUILD OUTPUT OVERRIDE — REQUIRED\n\n' +
    'You are running inside the custom portal (sprightly-starburst-210796.netlify.app). ' +
    'After completing the parking lot sweep, output your session close in EXACTLY this format — no exceptions:\n\n' +
    '[Your brief closing words — 1-3 sentences max]\n' +
    '%%RECEIPT%%{"session_scope":"[one sentence]","bronze_task":"[the task]","bronze_status":"yes","completion_status":"bronze","trigger_context":"' + triggerContext + '","outcome_type":"task_completed","thread_tag":"[topic slug]","rooms_visited":"' + roomsVisited + '","carried_forward":"[any open items or none]"' + boxBuiltLine + '}%%END_RECEIPT%%\n' +
    'Session closed. [receipt pending]\n\n' +
    'RULES:\n- Do NOT output a bullet list of receipt fields.\n- Do NOT output any text after "Session closed. [receipt pending]".\n- The %%RECEIPT%% block must be valid JSON — no trailing commas, no line breaks inside.\n- The frontend detects this block, strips it from display, writes it to Supabase, and replaces [receipt pending] with the real receipt number.\n- If you output a human-readable summary instead, the receipt write FAILS and the session is not recorded.';
}

// ── REPORT OUTPUT OVERRIDE (2026-07-01) ──────────────────────────────────────
// Appended to CS-15 (Weekly Plan) and CS-13/CS-14 (Quarterly Look Backward/Forward)
// system prompts, same mechanism as buildReceiptCloseBlock above. Neither protocol's
// own text can be trusted to produce a chat.js-parseable marker on its own — CS-15
// says "Write to weekly_planning_reports" and CS-13/CS-14 say "INSERT to quarterly_reviews
// (MCP direct write)" as if the AI has live Supabase tool access inside this function.
// It does not. This override forces the actual output contract chat.js can act on.
function buildWeeklyPlanOutputBlock() {
  return '\n\n---\n\n## CUSTOM BUILD OUTPUT OVERRIDE — REQUIRED (WEEKLY PLAN WRITE)\n\n' +
    'You are running inside the custom portal (sprightly-starburst-210796.netlify.app). You do NOT have direct ' +
    'Supabase write access — chat.js performs the write for you. Do not attempt to describe yourself as writing to ' +
    'the database. Instead, once Produce mode is complete and the Weekly Plan report HTML is rendered, output the ' +
    'report to the client as normal, then append this block after everything the client should see:\n\n' +
    '%%WEEKLY_PLAN%%{"quarter":"[e.g. Q3-2026]","week_number":[integer],"quarterly_focus_professional":"[value]",' +
    '"quarterly_focus_personal":"[value]","professional_story":"[Step 1 content]","personal_story":"[Step 2 content]",' +
    '"bronze_standard_met":[true or false],"this_week_bronze":"[value]","this_week_silver":"[value]","this_week_gold":"[value]",' +
    '"coaching_call_say":"[value]","coaching_call_ask":"[value]","coaching_call_request":"[value]",' +
    '"playbook_recommendation":"[value or null]","carried_forward":"[value or null]","full_report":"[the full rendered report HTML, escaped for JSON]"}%%END_WEEKLY_PLAN%%\n\n' +
    'RULES:\n- The %%WEEKLY_PLAN%% block must be valid JSON — escape quotes and newlines inside full_report properly, no trailing commas.\n' +
    '- Do NOT show the %%WEEKLY_PLAN%% block or its contents to the client — it is stripped before display.\n' +
    '- Do NOT claim in your visible response that you have "written" or "saved" anything yourself — chat.js does that after you respond.\n' +
    '- If this block is missing or malformed, the report is NOT saved and will not appear in Meeting Receipts or be downloadable as a PDF next time.';
}

function buildQuarterlyOutputBlock(reviewType) {
  return '\n\n---\n\n## CUSTOM BUILD OUTPUT OVERRIDE — REQUIRED (QUARTERLY ' + (reviewType === 'look_forward' ? 'LOOK FORWARD' : 'LOOK BACKWARD') + ' WRITE)\n\n' +
    'You are running inside the custom portal (sprightly-starburst-210796.netlify.app). You do NOT have direct ' +
    'Supabase / MCP write access from inside this conversation — chat.js performs the write for you. Ignore any instruction ' +
    'in the protocol above that describes an "MCP direct write" — that applies only to the separate North Star Room ' +
    'environment, not here. Instead, once Mini-mode 3 (Synthesis + Output) is complete and both the client report and ' +
    'Coach\'s POV are rendered, output the client report to the client as normal, then append this block after everything ' +
    'the client should see:\n\n' +
    '%%QUARTERLY%%{"type":"' + reviewType + '","quarter":"[e.g. Q3-2026]","client_html":"[full rendered client report HTML, escaped for JSON]",' +
    '"coach_pov":"[full Coach\'s POV text, escaped for JSON]","personal_grade":"[value or null]","professional_grade":"[value or null]",' +
    '"personal_explanation":"[value or null]","professional_explanation":"[value or null]","gold_expression":"[value or null]",' +
    '"hardest_box":"[value or null]","unfinished_thing":"[value or null]","credit_attribution":"[value or null]",' +
    '"defining_moment":"[value or null]","improvement_ask":"[value or null]",' +
    '"quarterly_dashboard_updates":{"quarterly_focus_personal":"[value or omit]","quarterly_focus_professional":"[value or omit]",' +
    '"quarterly_focus_personal_goal":"[value or omit]","quarterly_focus_professional_goal":"[value or omit]",' +
    '"personal_task":"[value or omit]","professional_task":"[value or omit]","personal_task_why":"[value or omit]",' +
    '"professional_task_why":"[value or omit]","personal_metric":"[value or omit]","professional_metric":"[value or omit]",' +
    '"personal_watch_out_limit":"[value or omit]","professional_watch_out_limit":"[value or omit]",' +
    '"look_backward_summary":"[value or omit — look_backward only]"}}%%END_QUARTERLY%%\n\n' +
    'RULES:\n- The %%QUARTERLY%% block must be valid JSON — escape quotes and newlines inside client_html/coach_pov properly, no trailing commas.\n' +
    '- quarterly_dashboard_updates may be an empty object {} if this session locked no dashboard-relevant fields.\n' +
    '- Do NOT show the %%QUARTERLY%% block or its contents to the client — it is stripped before display.\n' +
    '- Do NOT claim in your visible response that you have "written", "saved", or "inserted" anything yourself — chat.js does that after you respond.\n' +
    '- If this block is missing or malformed, the report is NOT saved and will not appear in Meeting Receipts or be downloadable as a PDF next time.';
}

function buildVTPlaybookOutputBlock(boxLabel) {
  return '\n\n---\n\n## CUSTOM BUILD OUTPUT OVERRIDE — REQUIRED (VIRTUAL TEAM PLAYBOOK CONTENT)\n\n' +
    'You are running inside the custom portal (sprightly-starburst-210796.netlify.app). Ignore any instruction above ' +
    'that says to "deliver the playbook as a response in the chat thread so it renders" or that describes rendering ' +
    'a full styled HTML document yourself — in THIS environment, chat.js applies the master design standard\'s styling ' +
    'MECHANICALLY, after you respond. You do NOT generate <style>, <html>, <head>, or <body> tags, and you do NOT need ' +
    'to reproduce the design standard\'s CSS or header/footer lines — chat.js adds all of that automatically from a ' +
    'fixed template. Your ONLY job is the CONTENT: the section headings, body text, tables, lists, and blockquotes for ' +
    'this playbook, using plain semantic HTML tags (<h2>, <h3>, <h4>, <p>, <table>, <ul>, <ol>, <blockquote> — per ' +
    'Section 5 of the design standard\'s element rules) with NO styling attributes and NO wrapper document.\n\n' +
    'Once the playbook content is fully written, do this: first output one short line to the client confirming the ' +
    'playbook is ready (e.g. "Your ' + boxLabel + ' playbook is ready below."), then append this block after that ' +
    'line — the block itself is NEVER shown to the client:\n\n' +
    '%%VT_PLAYBOOK%%\nTITLE: [use this box\'s exact title format, e.g. CC-BOX02-YYYY-MM-DD-ClientLastName-Client-Avatar-Profile]\n' +
    '[the playbook CONTENT ONLY — semantic HTML tags for headings/paragraphs/tables/lists/blockquotes, starting directly ' +
    'with the first section heading, NO <style>, NO <html>/<head>/<body> tags, NO header or footer line — chat.js adds ' +
    'those]\n%%END_VT_PLAYBOOK%%\n\n' +
    'RULES:\n- Do NOT paste or repeat the playbook content anywhere in your visible response outside this block — the block is the ONLY place it should appear.\n' +
    '- Do NOT include <style>, <html>, <head>, <body>, or any header/footer "[Client] | [Firm] | [Date]" line inside the block — chat.js adds these mechanically. Including them will cause duplication.\n' +
    '- The content inside the block must be complete and unabridged — do not summarize, truncate, or cut it short for length.\n' +
    '- Do NOT claim you have "rendered", "displayed", or "shown" the playbook yourself in your visible text — the portal builds and renders it from this block after you respond.\n' +
    '- If this block is missing, malformed, or missing its closing %%END_VT_PLAYBOOK%% tag, the playbook will not display for the client at all.';
}

// ── VT PLAYBOOK TEMPLATE WRAP (2026-07-02, Phase 1 CSS-injection fix) ────────────
// General, reusable mechanism: takes marker-extracted content (from ANY box's
// %%VT_PLAYBOOK%% output) and mechanically wraps it in REF-pdf-html-standard's
// actual template, fetched live from Supabase — never hardcoded/retyped. Same
// pattern is intended to extend to Weekly Plan / Quarterly in Phase 2 (their own
// wrap calls, not built here yet — Phase 1 scope is VT only per the handoff).
// Extracts just the <style>...</style> block from REF-pdf-html-standard (the doc
// itself is prose + one illustrative example, not a machine-splicable shell) and
// builds a fixed header/footer per the standard's own Section 7 rule.
async function wrapVTPlaybookInTemplate(contentHtml, title, meta) {
  const m = meta || {};
  const clientName = m.clientName || 'Client';
  const firmName = m.firmName || 'Coveted Consultant';
  const dateStr = m.dateStr || new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  const displayTitle = title || 'Virtual Team Playbook';

  let styleBlock = '';
  try {
    const refDoc = await getPrompt('REF-pdf-html-standard');
    if (refDoc) {
      const styleMatch = refDoc.match(/<style>[\s\S]*?<\/style>/);
      if (styleMatch) styleBlock = styleMatch[0];
    }
  } catch (err) {
    console.error('wrapVTPlaybookInTemplate: REF-pdf-html-standard fetch/parse failed:', err);
  }

  // Fail soft: if the style block couldn't be fetched/parsed for any reason,
  // still return the content wrapped in a minimal shell rather than losing the
  // report entirely. The client gets an unstyled-but-complete document, not an error.
  const footerLine = '<p><em>' + clientName + ' | ' + firmName + ' | ' + dateStr + '</em></p>';
  return '<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="UTF-8">\n' + styleBlock +
    '\n</head>\n<body>\n' + footerLine + '\n<h1>' + displayTitle + '</h1>\n<hr>\n' +
    contentHtml + '\n<hr>\n' + footerLine + '\n</body>\n</html>';
}

// ── ERR-NET-25 fix (2026-07-01): verify the caller's Supabase access token ────
// actually belongs to the userId the request claims. Before this fix, chat.js
// trusted whatever userId the frontend sent in the JSON body with no check that
// the request was actually authenticated as that person -- someone editing the
// request in browser dev tools could ask for any other user's data (operating
// picture, session receipts, conversation history) just by changing the userId
// field. Fix: read the Authorization header, ask Supabase's own /auth/v1/user
// endpoint whose token this is, and reject the request unless that identity
// matches the claimed userId. Does not touch any existing query or write path --
// this is a guard clause that runs before any of them.
async function verifyUserId(event, claimedUserId) {
  const authHeader = event.headers['authorization'] || event.headers['Authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return { ok: false, reason: 'missing_token' };
  }
  const token = authHeader.slice('Bearer '.length);
  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { 'apikey': SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${token}` }
    });
    if (!res.ok) return { ok: false, reason: 'invalid_token' };
    const userData = await res.json();
    if (!userData || !userData.id) return { ok: false, reason: 'invalid_token' };
    if (!claimedUserId || userData.id !== claimedUserId) {
      return { ok: false, reason: 'user_mismatch' };
    }
    return { ok: true };
  } catch (err) {
    console.error('verifyUserId error:', err);
    return { ok: false, reason: 'verify_error' };
  }
}

async function getPrompt(skillId) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/system_prompts?protocol_id=eq.${skillId}&active=eq.true&select=system_prompt&limit=1`, {
    headers: {
      'apikey': SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`
    }
  });
  const data = await res.json();
  return data?.[0]?.system_prompt || null;
}

async function hasOperatingPicture(userId) {
  if (!userId) return false;
  const res = await fetch(`${SUPABASE_URL}/rest/v1/annual_operating_picture?user_id=eq.${userId}&select=id&limit=1`, {
    headers: {
      'apikey': SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`
    }
  });
  const data = await res.json();
  return Array.isArray(data) && data.length > 0;
}

async function writeAOP(aopData) {
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!aopData.user_id || !uuidPattern.test(aopData.user_id)) {
    throw new Error('AOP write rejected: user_id must be a valid UUID');
  }

  const checkRes = await fetch(`${SUPABASE_URL}/rest/v1/annual_operating_picture?user_id=eq.${aopData.user_id}&select=id&limit=1`, {
    headers: { 'apikey': SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}` }
  });
  const existing = await checkRes.json();

  if (existing && existing.length > 0) {
    const patchRes = await fetch(`${SUPABASE_URL}/rest/v1/annual_operating_picture?user_id=eq.${aopData.user_id}`, {
      method: 'PATCH',
      headers: {
        'apikey': SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=representation'
      },
      body: JSON.stringify(aopData)
    });
    if (!patchRes.ok) throw new Error('AOP PATCH failed: ' + await patchRes.text());
    return await patchRes.json();
  } else {
    const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/annual_operating_picture`, {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=representation'
      },
      body: JSON.stringify(aopData)
    });
    if (!insertRes.ok) throw new Error('AOP INSERT failed: ' + await insertRes.text());
    return await insertRes.json();
  }
}

function extractAndWriteAOP(text, userId) {
  const start = text.indexOf('%%AOP%%');
  const end = text.indexOf('%%END_AOP%%');
  if (start === -1 || end === -1 || end <= start) return null;

  const jsonStr = text.slice(start + '%%AOP%%'.length, end).trim();
  try {
    const aopData = JSON.parse(jsonStr);
    aopData.user_id = userId;
    return aopData;
  } catch (e) {
    console.error('AOP JSON parse failed:', e, 'Raw:', jsonStr);
    return null;
  }
}

// ── WEEKLY PLAN WRITE (2026-07-01) ────────────────────────────────────────────
// Same shape as extractAndWriteAOP/writeAOP above. Extracts %%WEEKLY_PLAN%% JSON
// from the assistant's raw response text and inserts a row into weekly_planning_reports.
// Weekly Plan is always a fresh row per week (not an upsert) — CS-15 Assemble mode
// already reads the last 3 rows for streak detection, so history must be preserved.
function extractWeeklyPlan(text) {
  const start = text.indexOf('%%WEEKLY_PLAN%%');
  const end = text.indexOf('%%END_WEEKLY_PLAN%%');
  if (start === -1 || end === -1 || end <= start) return null;
  const jsonStr = text.slice(start + '%%WEEKLY_PLAN%%'.length, end).trim();
  try {
    return JSON.parse(jsonStr);
  } catch (e) {
    console.error('WEEKLY_PLAN JSON parse failed:', e, 'Raw:', jsonStr);
    return null;
  }
}

async function writeWeeklyPlan(reportData, userId, clientName) {
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!userId || !uuidPattern.test(userId)) {
    throw new Error('Weekly Plan write rejected: user_id must be a valid UUID');
  }
  const payload = {
    user_id: userId,
    // user_name and session_date are NOT NULL with no DB default (confirmed live 2026-07-02
    // via a 23502 insert failure) -- writeWeeklyPlan previously omitted both entirely.
    user_name: clientName || 'Client',
    session_date: new Date().toISOString().slice(0, 10),
    quarter: reportData.quarter || null,
    week_number: typeof reportData.week_number === 'number' ? reportData.week_number : null,
    quarterly_focus_professional: reportData.quarterly_focus_professional || null,
    quarterly_focus_personal: reportData.quarterly_focus_personal || null,
    professional_story: reportData.professional_story || null,
    personal_story: reportData.personal_story || null,
    bronze_standard_met: typeof reportData.bronze_standard_met === 'boolean' ? reportData.bronze_standard_met : null,
    this_week_bronze: reportData.this_week_bronze || null,
    this_week_silver: reportData.this_week_silver || null,
    this_week_gold: reportData.this_week_gold || null,
    coaching_call_say: reportData.coaching_call_say || null,
    coaching_call_ask: reportData.coaching_call_ask || null,
    coaching_call_request: reportData.coaching_call_request || null,
    playbook_recommendation: reportData.playbook_recommendation || null,
    carried_forward: reportData.carried_forward || null,
    full_report: reportData.full_report || null,
    created_at: new Date().toISOString()
  };
  const res = await fetch(`${SUPABASE_URL}/rest/v1/weekly_planning_reports`, {
    method: 'POST',
    headers: {
      'apikey': SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=representation'
    },
    body: JSON.stringify(payload)
  });
  if (!res.ok) throw new Error('weekly_planning_reports INSERT failed: ' + await res.text());
  return await res.json();
}

// ── QUARTERLY REVIEW WRITE (2026-07-01) ───────────────────────────────────────
// Extracts %%QUARTERLY%% JSON (type: look_backward | look_forward) and writes:
//   1. a fresh row to quarterly_reviews (always insert — one row per session, per
//      the same history-preserving pattern as weekly_planning_reports)
//   2. an UPSERT-style update to quarterly_dashboard_content for the fields the
//      session locked (only whatever keys are present in quarterly_dashboard_updates
//      are touched — never blindly overwrites the whole row)
function extractQuarterly(text) {
  const start = text.indexOf('%%QUARTERLY%%');
  const end = text.indexOf('%%END_QUARTERLY%%');
  if (start === -1 || end === -1 || end <= start) return null;
  const jsonStr = text.slice(start + '%%QUARTERLY%%'.length, end).trim();
  try {
    return JSON.parse(jsonStr);
  } catch (e) {
    console.error('QUARTERLY JSON parse failed:', e, 'Raw:', jsonStr);
    return null;
  }
}

function extractVTPlaybook(text) {
  // VT playbooks have no dedicated Supabase table (no schema to parse into) —
  // the marker just delimits the raw playbook HTML plus an optional title line.
  // Format emitted by vt-* prompts:
  //   %%VT_PLAYBOOK%%
  //   TITLE: CC-BOX02-2026-07-01-Mendes-Client-Avatar-Profile
  //   <html>...full styled playbook...</html>
  //   %%END_VT_PLAYBOOK%%
  const start = text.indexOf('%%VT_PLAYBOOK%%');
  const end = text.indexOf('%%END_VT_PLAYBOOK%%');
  if (start === -1 || end === -1 || end <= start) return null;
  let block = text.slice(start + '%%VT_PLAYBOOK%%'.length, end).trim();
  let title = null;
  const titleMatch = block.match(/^TITLE:\s*(.+)$/m);
  if (titleMatch) {
    title = titleMatch[1].trim();
    block = block.replace(/^TITLE:\s*.+\n?/m, '').trim();
  }
  if (!block) return null;
  return { html: block, title };
}

async function writeQuarterlyReview(reviewData, userId) {
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!userId || !uuidPattern.test(userId)) {
    throw new Error('Quarterly review write rejected: user_id must be a valid UUID');
  }
  if (reviewData.type !== 'look_backward' && reviewData.type !== 'look_forward') {
    throw new Error('Quarterly review write rejected: type must be look_backward or look_forward');
  }

  const reviewPayload = {
    user_id: userId,
    quarter: reviewData.quarter || null,
    type: reviewData.type,
    client_html: reviewData.client_html || null,
    coach_pov: reviewData.coach_pov || null,
    personal_grade: reviewData.personal_grade || null,
    professional_grade: reviewData.professional_grade || null,
    personal_explanation: reviewData.personal_explanation || null,
    professional_explanation: reviewData.professional_explanation || null,
    gold_expression: reviewData.gold_expression || null,
    hardest_box: reviewData.hardest_box || null,
    unfinished_thing: reviewData.unfinished_thing || null,
    credit_attribution: reviewData.credit_attribution || null,
    defining_moment: reviewData.defining_moment || null,
    improvement_ask: reviewData.improvement_ask || null,
    created_at: new Date().toISOString()
  };
  const reviewRes = await fetch(`${SUPABASE_URL}/rest/v1/quarterly_reviews`, {
    method: 'POST',
    headers: {
      'apikey': SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=representation'
    },
    body: JSON.stringify(reviewPayload)
  });
  if (!reviewRes.ok) throw new Error('quarterly_reviews INSERT failed: ' + await reviewRes.text());
  const insertedReview = await reviewRes.json();

  // Only touch quarterly_dashboard_content if the session actually locked fields for it.
  const updates = reviewData.quarterly_dashboard_updates;
  if (updates && typeof updates === 'object' && Object.keys(updates).length > 0) {
    const allowedFields = [
      'quarterly_focus_personal','quarterly_focus_professional',
      'quarterly_focus_personal_goal','quarterly_focus_professional_goal',
      'personal_task','professional_task','personal_task_why','professional_task_why',
      'personal_metric','professional_metric',
      'personal_watch_out_limit','professional_watch_out_limit',
      'look_backward_summary'
    ];
    const patchBody = {};
    for (const key of allowedFields) {
      if (updates[key] !== undefined && updates[key] !== null && updates[key] !== '') {
        patchBody[key] = updates[key];
      }
    }
    if (Object.keys(patchBody).length > 0) {
      patchBody.updated_at = new Date().toISOString();
      const checkRes = await fetch(`${SUPABASE_URL}/rest/v1/quarterly_dashboard_content?user_id=eq.${userId}&quarter=eq.${encodeURIComponent(reviewData.quarter || '')}&select=id&limit=1`, {
        headers: { 'apikey': SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}` }
      });
      const existing = await checkRes.json();
      if (existing && existing.length > 0) {
        const patchRes = await fetch(`${SUPABASE_URL}/rest/v1/quarterly_dashboard_content?user_id=eq.${userId}&quarter=eq.${encodeURIComponent(reviewData.quarter || '')}`, {
          method: 'PATCH',
          headers: {
            'apikey': SUPABASE_SERVICE_KEY,
            'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
            'Content-Type': 'application/json',
            'Prefer': 'return=minimal'
          },
          body: JSON.stringify(patchBody)
        });
        if (!patchRes.ok) console.error('quarterly_dashboard_content PATCH failed:', await patchRes.text());
      } else {
        patchBody.user_id = userId;
        patchBody.quarter = reviewData.quarter || null;
        patchBody.created_at = new Date().toISOString();
        const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/quarterly_dashboard_content`, {
          method: 'POST',
          headers: {
            'apikey': SUPABASE_SERVICE_KEY,
            'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
            'Content-Type': 'application/json',
            'Prefer': 'return=minimal'
          },
          body: JSON.stringify(patchBody)
        });
        if (!insertRes.ok) console.error('quarterly_dashboard_content INSERT failed:', await insertRes.text());
      }
    }
  }

  return insertedReview;
}

// ── CONVERSATION LOG WRITE ──────────────────────────────────────────────────────
// Split into two functions: user message written BEFORE Anthropic call,
// assistant message written AFTER. This ensures at least the user's message
// is captured even if the function times out during the Anthropic call.

async function writeUserMessageLog(userId, room, userMessage, sessionKey) {
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!userId || !uuidPattern.test(userId)) {
    console.error('Conversation log rejected: invalid userId');
    return;
  }
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/conversation_logs`, {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal'
      },
      body: JSON.stringify([{ user_id: userId, room, role: 'user', content: userMessage, session_key: sessionKey }])
    });
    if (!res.ok) console.error('User message log write failed:', await res.text());
  } catch (err) {
    console.error('User message log write error:', err);
  }
}

async function writeAssistantMessageLog(userId, room, assistantMessage, sessionKey) {
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!userId || !uuidPattern.test(userId)) return;
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/conversation_logs`, {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal'
      },
      body: JSON.stringify([{ user_id: userId, room, role: 'assistant', content: assistantMessage, session_key: sessionKey }])
    });
    if (!res.ok) console.error('Assistant message log write failed:', await res.text());
  } catch (err) {
    console.error('Assistant message log write error:', err);
  }
}

// ── DAILY BRIEF ACTIVE MEMORY: rolling N-day verbatim thread ──────────────────
// Item 4 (2026-06-13): the Daily Brief holds the last DAILY_LOOKBACK_DAYS days of its
// OWN verbatim conversation in active memory, so it picks up where you left off across
// days. Anything older than the window is carried forward by the session receipts, not
// here (transcript inside the window; receipt beyond it). This is the Daily Brief's
// setting ONLY (room='chat') — other rooms are unchanged. session_key, receipts, the
// admin grouping, and orphan-recovery are all untouched: this only changes which prior
// turns the model reads, never how anything is stored.
const DAILY_LOOKBACK_DAYS = 7;        // the rolling window — the dial Alzay sets
const DAILY_LOOKBACK_MAX_TURNS = 60;  // safety cap so an unusually heavy week can't bloat context

async function loadRecentThread(userId, room, days, maxTurns) {
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!userId || !uuidPattern.test(userId)) return [];
  try {
    const since = new Date(Date.now() - days * 86400000).toISOString();
    const url = `${SUPABASE_URL}/rest/v1/conversation_logs?user_id=eq.${userId}&room=eq.${room}`
      + `&created_at=gte.${since}&select=role,content,created_at&order=created_at.desc&limit=${maxTurns}`;
    const res = await fetch(url, { headers: { 'apikey': SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}` } });
    if (!res.ok) { console.error('loadRecentThread fetch failed:', await res.text()); return []; }
    const rows = await res.json();
    if (!Array.isArray(rows) || rows.length === 0) return [];
    // Rows come newest-first (capped at maxTurns); reverse to chronological for the model.
    return rows.reverse()
      .filter(r => r && r.content && (r.role === 'user' || r.role === 'assistant'))
      .map(r => ({ role: r.role, content: r.content }));
  } catch (err) {
    console.error('loadRecentThread error:', err);
    return [];
  }
}

// Guarantee the turns sent to Anthropic start with a user turn and strictly alternate
// (merging any consecutive same-role turns from a missing/lagged log). Prevents a
// "roles must alternate" API error if the logged thread has a gap.
function normalizeTurns(turns) {
  const out = [];
  for (const t of turns) {
    if (!t || !t.content || (t.role !== 'user' && t.role !== 'assistant')) continue;
    if (out.length === 0 && t.role !== 'user') continue; // must start with a user turn
    const last = out[out.length - 1];
    if (last && last.role === t.role) { last.content += '\n\n' + t.content; }
    else { out.push({ role: t.role, content: t.content }); }
  }
  return out;
}

function cs9ShouldLoad(messages) {
  const assistantPresentedOffers = messages.some(msg =>
    msg.role === 'assistant' &&
    (
      msg.content.includes('Here are three ways I can help') ||
      msg.content.includes('three ways I can help right now') ||
      msg.content.includes('How I Can Help Right Now') ||
      msg.content.includes('Here are three places we could start')
    )
  );
  if (!assistantPresentedOffers) return false;
  const offerPresentedIdx = messages.findIndex(msg =>
    msg.role === 'assistant' &&
    (
      msg.content.includes('Here are three ways I can help') ||
      msg.content.includes('three ways I can help right now') ||
      msg.content.includes('How I Can Help Right Now') ||
      msg.content.includes('Here are three places we could start')
    )
  );
  const afterOffers = messages.slice(offerPresentedIdx + 1);
  const confirmSignals = ['1','2','3','4','a','b','c','d','option 1','option 2','option 3','yes',"let's do that",'that one','go with'];
  for (const msg of afterOffers) {
    if (msg.role !== 'user') continue;
    const text = msg.content.toLowerCase().trim();
    if (confirmSignals.some(s => text === s || text.startsWith(s + ' ') || text.startsWith(s + ','))) return true;
  }
  return false;
}

function csReceiptShouldLoad(messages) {
  const closeSignals = [
    "that's it",'that is it',"we're done",'we are done',
    'close it out','close the session','session closed',
    'close the meeting','close the chat','end the meeting','end the session',
    'close out','wrap up','wrap it up',
    "i'm done",'i am done','all done',
    "that's all",'that is all',"nope that's all","nope, that's all",
    "thanks, that's all","that's all for now",'nothing else',
    'good to go',"let's close",'you can close','please close',
    'nothing more',"we're good",'we are good',
    "i'll send that",'i will send that','send it',"i'll do it",
    'close it','done for today','that does it'
  ];
  const userMessages = messages.filter(m => m.role === 'user');
  if (userMessages.length === 0) return false;
  const lastUserMsg = userMessages[userMessages.length - 1].content.toLowerCase().trim();
  if (lastUserMsg.includes('receipt')) return true;
  return closeSignals.some(s => lastUserMsg.includes(s));
}

// ── SESSION START: CHECK FOR ORPHANED SESSION, WRITE PARTIAL RECEIPT ──────────
async function checkAndWritePartialReceipt(userId, room) {
  try {
    const receiptRes = await fetch(
      `${SUPABASE_URL}/rest/v1/session_receipts?user_id=eq.${userId}&room_id=eq.north-star-room&select=session_date,completion_status,receipt_number&order=session_date.desc&limit=1`,
      { headers: { 'apikey': SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}` } }
    );
    const receipts = await receiptRes.json();
    const lastReceipt = receipts?.[0] || null;
    const lastReceiptDate = lastReceipt?.session_date || null;

    let logsFilter = `user_id=eq.${userId}&room=eq.${room}&select=role,content,session_key,created_at&order=created_at.asc`;
    if (lastReceiptDate) {
      logsFilter += `&created_at=gt.${lastReceiptDate}T23:59:59.999Z`;
    }
    const logsRes = await fetch(
      `${SUPABASE_URL}/rest/v1/conversation_logs?${logsFilter}&limit=100`,
      { headers: { 'apikey': SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}` } }
    );
    const logs = await logsRes.json();

    if (!logs || logs.length === 0) return null;

    const sessionKeys = [...new Set(logs.map(l => l.session_key).filter(Boolean))];
    if (sessionKeys.length === 0) return null;

    const mostRecentKey = sessionKeys[sessionKeys.length - 1];
    const sessionLogs = logs.filter(l => l.session_key === mostRecentKey);

    const keyParts = mostRecentKey.split('-');
    let orphanDate = null;
    if (keyParts.length >= 8) {
      orphanDate = `${keyParts[5]}-${keyParts[6]}-${keyParts[7]}`;
    } else {
      orphanDate = new Date().toISOString().slice(0, 10);
    }

    const transcript = sessionLogs.map(l => `${l.role}: ${l.content}`).join('\n').slice(0, 3000);
    const synthRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 300,
        system: 'You are a session summarizer. Output ONLY a JSON object with these exact fields: {"session_scope":"one sentence describing what was discussed","bronze_task":"main task or topic","thread_tag":"one-word-slug"}. No other text.',
        messages: [{ role: 'user', content: 'Summarize this conversation:\n\n' + transcript }]
      })
    });
    const synthData = await synthRes.json();
    let fields = { session_scope: 'Session cut short — no receipt written', bronze_task: 'Unknown', thread_tag: 'incomplete' };
    try {
      const raw = synthData.content?.[0]?.text || '{}';
      const parsed = JSON.parse(raw);
      if (parsed.session_scope) fields = parsed;
    } catch(e) {}

    const partialPayload = {
      user_id: userId,
      session_date: orphanDate,
      room_id: 'north-star-room',
      receipt_number: null,
      session_scope: fields.session_scope,
      bronze_task: fields.bronze_task,
      bronze_status: 'incomplete',
      completion_status: 'incomplete',
      trigger_context: 'auto_partial',
      outcome_type: 'session_cut_short',
      thread_tag: fields.thread_tag,
      rooms_visited: room === 'chat' ? 'Daily Brief' : room === 'prep' ? 'Prep Room' : 'Setup',
      carried_forward: 'Session ended without a receipt — context preserved above'
    };
    const writeRes = await fetch(`${SUPABASE_URL}/rest/v1/session_receipts`, {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
        'Content-Type': 'application/json', 'Prefer': 'return=minimal'
      },
      body: JSON.stringify(partialPayload)
    });
    if (!writeRes.ok) {
      console.error('Partial receipt write failed:', await writeRes.text());
      return null;
    }

    return `[SYSTEM NOTE — DO NOT DISPLAY VERBATIM: The user's last ${room === 'chat' ? 'Daily Brief' : 'Prep Room'} session on ${orphanDate} ended without a receipt — it was cut short. A partial receipt has been written automatically. On your FIRST response this session, briefly acknowledge that your last conversation together didn't get a proper close, and invite them to continue from where they left off or start fresh. Keep it conversational — one or two sentences, no drama.]`;

  } catch (err) {
    console.error('checkAndWritePartialReceipt error:', err);
    return null;
  }
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: corsHeaders(), body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };
  if (!ANTHROPIC_API_KEY) return { statusCode: 500, headers: corsHeaders(), body: JSON.stringify({ error: 'API key not configured' }) };

  try {
    const { messages, context, userName, userId, room, boxId } = JSON.parse(event.body);

    // ── ERR-NET-25: reject requests whose Authorization token doesn't match ────
    // the claimed userId. userId is required for every real room; only allow it
    // to be absent if the frontend genuinely sent none (defensive, should not
    // happen in practice since every call site sends userId).
    if (userId) {
      const verification = await verifyUserId(event, userId);
      if (!verification.ok) {
        console.error('Auth verification failed:', verification.reason, 'claimed userId:', userId);
        return { statusCode: 401, headers: corsHeaders(), body: JSON.stringify({ error: 'Unauthorized' }) };
      }
    }

    let systemPrompt;
    let prepRoute = null; // set below when room === 'prep'; used later for report-write dispatch

    if (room === 'chat') {
      // Direct dispatch (2026-07-01) — replaces the prior "always load chat-b
      // first, append on top" pattern. chat-b retired; see LOG-cs-16.
      const dailyBriefRoute = detectDailyBriefRoute(messages);

      if (dailyBriefRoute === 'redirect-upload') {
        // Folded in from chat-b's former edge-case text — no protocol load needed,
        // this is a short fixed redirect message.
        return {
          statusCode: 200, headers: corsHeaders(),
          body: JSON.stringify({ reply: "Document uploads happen in the Upload Documents chat. Head there and it will walk you through the process." })
        };
      }
      if (dailyBriefRoute === 'redirect-quarterly') {
        return {
          statusCode: 200, headers: corsHeaders(),
          body: JSON.stringify({ reply: "Quarterly reviews have their own dedicated space — the Preparation Work chat. Head there when you're ready." })
        };
      }

      if (dailyBriefRoute === 'cs-1') {
        const cs1Prompt = await getPrompt('cs-1');
        if (!cs1Prompt) return { statusCode: 500, headers: corsHeaders(), body: JSON.stringify({ error: 'cs-1 prompt not found in Supabase' }) };
        systemPrompt = cs1Prompt;
      } else {
        // dailyBriefRoute === 'cs-16' (Talk Something Through, or ambiguous-opening fallback)
        const cs16Prompt = await getPrompt('cs-16');
        if (!cs16Prompt) return { statusCode: 500, headers: corsHeaders(), body: JSON.stringify({ error: 'cs-16 prompt not found in Supabase' }) };
        systemPrompt = cs16Prompt;
      }

      if (cs9ShouldLoad(messages)) {
        const cs9Prompt = await getPrompt('cs-9');
        if (cs9Prompt) systemPrompt += '\n\n---\n\n## CS-9 — RECOMMENDATIONS RESPONSE PROTOCOL\n\n' + cs9Prompt;
      }
      if (csReceiptShouldLoad(messages)) {
        const csReceiptPrompt = await getPrompt('cs-receipt');
        if (csReceiptPrompt) {
          systemPrompt += buildReceiptCloseBlock(csReceiptPrompt, {
            triggerContext: 'daily_work',
            roomsVisited: 'Daily Work — Chief of Staff'
          });
        }
      }

    } else if (room === 'virtualteam') {
      // Box selection: frontend sends boxId (e.g. "vt-5"). Validate against the allowlist
      // — NEVER load an arbitrary skill_id from client input.
      const requestedBox = (typeof boxId === 'string' && VT_BOX_IDS.includes(boxId)) ? boxId : null;
      if (!requestedBox) {
        return { statusCode: 400, headers: corsHeaders(), body: JSON.stringify({ error: 'virtualteam room requires a valid boxId' }) };
      }
      const vtPrompt = await getPrompt(requestedBox);
      if (!vtPrompt) return { statusCode: 500, headers: corsHeaders(), body: JSON.stringify({ error: requestedBox + ' prompt not found in Supabase' }) };
      systemPrompt = vtPrompt;

      // (2026-07-02, Phase 1 fix) REF-pdf-html-standard is no longer appended here —
      // the model no longer generates styled HTML itself, so it doesn't need to see the
      // design standard at generation time. wrapVTPlaybookInTemplate() fetches it fresh
      // at response-assembly time instead, after the model returns content-only output.

      // %%VT_PLAYBOOK%% marker override (2026-07-01): raw HTML delivered directly into
      // the chat thread does NOT render on the custom portal — renderMarkdown() escapes
      // all HTML before display. This block overrides each box's "deliver in chat thread"
      // instruction so the model emits the finished playbook wrapped in the marker instead,
      // matching the same isolation pattern as Weekly Plan / Quarterly.
      systemPrompt += buildVTPlaybookOutputBlock(VT_BOX_LABELS[requestedBox] || requestedBox);

      // (2026-07-02, Phase 3 proof-of-concept) TIMING-SWEEP EXPANSION: vt-6, vt-2a, vt-10
      // route their real trigger phrases to the background-function path instead of the
      // normal synchronous call below. Covers all 11 report-producing VT boxes as of
      // 2026-07-02 (vt-6/vt-2a/vt-10 proven first; remaining 8 added same day after
      // confirming each box's real trigger phrase directly from its Supabase protocol
      // text — see project_vt_background_generation_lessons memory note). vt-2b, vt-3b,
      // vt-4b are non-report companion/practice skills and are intentionally excluded —
      // they never produce a %%VT_PLAYBOOK%% block, so they stay on the synchronous path.
      const VT_BACKGROUND_TRIGGER_PHRASES = {
        'vt-2a': 'create box 2 playbook',
        'vt-3a': 'create box 3 playbook',
        'vt-4a': 'create box 4 playbook',
        'vt-4c': 'create box 4 playbook',
        'vt-5': 'create box 5 playbook',
        'vt-6': 'create box 6 playbook',
        'vt-7': 'create box 7 playbook',
        'vt-8': 'create box 8 playbook',
        'vt-8b': 'create box 8 playbook',
        'vt-9': 'create box 9 playbook',
        'vt-10': 'create box 10 playbook'
      };
      const lastUserMsgForTrigger = [...messages].reverse().find(m => m.role === 'user');
      const isVtBackgroundRealTrigger = VT_BACKGROUND_TRIGGER_PHRASES[requestedBox] &&
        lastUserMsgForTrigger && typeof lastUserMsgForTrigger.content === 'string' &&
        lastUserMsgForTrigger.content.trim().toLowerCase() === VT_BACKGROUND_TRIGGER_PHRASES[requestedBox];

      if (isVtBackgroundRealTrigger && userId) {
        const jobPayload = {
          systemPrompt,
          messages: [
            { role: 'user', content: '[CONTEXT — DO NOT DISPLAY TO USER]\n' + buildContextString(context) + '\n[END CONTEXT]\n\nUser first name: ' + (userName || 'there') },
            { role: 'assistant', content: 'Understood. I have the full operating picture. Ready.' },
            ...messages.map(m => ({ role: m.role, content: m.content }))
          ],
          boxLabel: VT_BOX_LABELS[requestedBox] || requestedBox,
          meta: { clientName: userName || 'Client' }
        };

        const createRes = await fetch(`${SUPABASE_URL}/rest/v1/report_jobs`, {
          method: 'POST',
          headers: {
            'apikey': SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
            'Content-Type': 'application/json', 'Prefer': 'return=representation'
          },
          body: JSON.stringify({ user_id: userId, box_id: requestedBox, room: 'virtualteam', request_payload: jobPayload })
        });
        const createdJob = (await createRes.json())?.[0];

        if (createdJob && createdJob.id) {
          // Fix (2026-07-02, 2nd pass): AWAIT the invocation handshake (the 202 ack Netlify
          // returns immediately per their own docs -- "the client receives an empty 202
          // response immediately"), NOT the background job's completion. A fire-and-forget
          // fetch() with no await was silently failing to actually leave the sandbox before
          // this parent (non-background) function returned its own response and Netlify tore
          // down its execution environment -- a known invoke-after-response serverless gotcha.
          // Awaiting just the 202 handshake costs a few hundred ms, confirmed negligible against
          // Netlify's docs description of an "immediate" 202, and guarantees the invocation
          // actually fires before this function exits.
          try {
            const invokeRes = await fetch(`${process.env.URL || 'https://sprightly-starburst-210796.netlify.app'}/generate-report-background`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ jobId: createdJob.id })
            });
            if (invokeRes.status !== 202) {
              console.error('Background function invocation returned unexpected status:', invokeRes.status);
            }
          } catch (err) {
            console.error('Failed to invoke background function:', err);
          }

          return {
            statusCode: 200, headers: corsHeaders(),
            body: JSON.stringify({
              message: 'Your ' + (VT_BOX_LABELS[requestedBox] || requestedBox) + ' playbook is being built. This usually takes about 30-75 seconds — feel free to check back.',
              reportJobId: createdJob.id,
              hasLogsToday: true
            })
          };
        }
        // If job creation failed for any reason, fall through to the normal synchronous path
        // below rather than losing the request entirely.
      }

      // VT close fires the same unified cs-receipt — carrying virtual_team context + box_built.
      if (csReceiptShouldLoad(messages)) {
        const csReceiptPrompt = await getPrompt('cs-receipt');
        if (csReceiptPrompt) {
          const boxNum = requestedBox.replace('vt-', 'box_');
          systemPrompt += buildReceiptCloseBlock(csReceiptPrompt, {
            triggerContext: 'virtual_team',
            roomsVisited: 'Virtual Team Room — ' + (VT_BOX_LABELS[requestedBox] || requestedBox),
            boxBuilt: boxNum
          });
        }
      }

    } else if (room === 'prep') {
      // Full chain injection — all REF/LOG documents fetched upfront by chat.js.
      // The AI never makes a mid-conversation Supabase load call. Prevents portal hang.
      prepRoute = detectPrepRoute(messages);
      if (prepRoute === 'cs-15') {
        // Weekly check-in — fetch base protocol + template (was tr-2, retired 2026-07-01)
        const [cs15Prompt, refWeeklyTemplate] = await Promise.all([
          getPrompt('cs-15'),
          getPrompt('REF-cs-15-weekly-plan-template')
        ]);
        if (!cs15Prompt) return { statusCode: 500, headers: corsHeaders(), body: JSON.stringify({ error: 'cs-15 prompt not found in Supabase' }) };
        systemPrompt = cs15Prompt;
        if (refWeeklyTemplate) systemPrompt += '\n\n---\n\n## REF — CS-15 WEEKLY PLAN TEMPLATE\n\n[SYSTEM: This document has been loaded into this session by chat.js. The AI does not need to fetch it.]\n\n' + refWeeklyTemplate;
        systemPrompt += buildWeeklyPlanOutputBlock();
      } else if (prepRoute === 'menu-quarterly-review-prep') {
        // Quarterly review — fetch full chain upfront
        const [menuPrompt, cs13Prompt, cs14Prompt, refConvStd, refLookBack, refLookFwd, refCoachesPov, logQR] = await Promise.all([
          getPrompt('menu-quarterly-review-prep'),
          getPrompt('cs-13'),
          getPrompt('cs-14'),
          getPrompt('REF-quarterly-review-conversation-standard'),
          getPrompt('REF-quarterly-review-look-backward'),
          getPrompt('REF-quarterly-review-look-forward'),
          getPrompt('REF-quarterly-review-coaches-pov'),
          getPrompt('LOG-quarterly-review')
        ]);
        if (!menuPrompt) return { statusCode: 500, headers: corsHeaders(), body: JSON.stringify({ error: 'menu-quarterly-review-prep not found in Supabase' }) };
        systemPrompt = menuPrompt;
        if (cs13Prompt) systemPrompt += '\n\n---\n\n## CS-13 — LOOK BACKWARD\n\n[SYSTEM: Loaded by chat.js. No mid-conversation fetch needed.]\n\n' + cs13Prompt;
        if (cs14Prompt) systemPrompt += '\n\n---\n\n## CS-14 — LOOK FORWARD\n\n[SYSTEM: Loaded by chat.js. No mid-conversation fetch needed.]\n\n' + cs14Prompt;
        if (refConvStd) systemPrompt += '\n\n---\n\n## REF — QUARTERLY REVIEW CONVERSATION STANDARD\n\n' + refConvStd;
        if (refLookBack) systemPrompt += '\n\n---\n\n## REF — LOOK BACKWARD\n\n' + refLookBack;
        if (refLookFwd) systemPrompt += '\n\n---\n\n## REF — LOOK FORWARD\n\n' + refLookFwd;
        if (refCoachesPov) systemPrompt += '\n\n---\n\n## REF — COACHES POV\n\n' + refCoachesPov;
        if (logQR) systemPrompt += '\n\n---\n\n## LOG — QUARTERLY REVIEW\n\n' + logQR;
        // Both look_backward and look_forward output blocks are appended — the AI only
        // ever runs one branch per session (CS-13 or CS-14), so only the relevant block
        // will actually be triggered, but both markers are safe to have available.
        systemPrompt += buildQuarterlyOutputBlock('look_backward');
        systemPrompt += buildQuarterlyOutputBlock('look_forward');
      } else {
        // Ambiguous — show A/B menu via chat-c
        const chatCPrompt = await getPrompt('chat-c');
        if (!chatCPrompt) return { statusCode: 500, headers: corsHeaders(), body: JSON.stringify({ error: 'chat-c prompt not found in Supabase' }) };
        systemPrompt = chatCPrompt;
      }
      if (csReceiptShouldLoad(messages)) {
        const csReceiptPrompt = await getPrompt('cs-receipt');
        if (csReceiptPrompt) {
          const roomLabel = prepRoute === 'cs-15' ? 'Prep Room — Weekly Plan' :
                            prepRoute === 'menu-quarterly-review-prep' ? 'Prep Room — Quarterly Review' : 'Prep Room';
          const triggerCtx = prepRoute === 'cs-15' ? 'weekly_plan' :
                             prepRoute === 'menu-quarterly-review-prep' ? 'quarterly_review' : 'prep_room';
          // CS-15 and quarterly reviews are their own receipt (see CS-15 Section 7 / CS-13-14
          // "Does NOT hand off to CS-Receipt" logic) — skip the RECEIPT close block for those,
          // matching the protocols' own stated dependency rules.
          if (prepRoute !== 'cs-15' && prepRoute !== 'menu-quarterly-review-prep') {
            systemPrompt += buildReceiptCloseBlock(csReceiptPrompt, { triggerContext: triggerCtx, roomsVisited: roomLabel });
          }
        }
      }

      // ── PREP ROOM BACKGROUND BUILD TRIGGER (cs-15, 2026-07-02) ────────────────
      // Same pattern as the VT background trigger above. cs-15 v1.1 added an explicit
      // "Build my weekly plan" gate between Mode 2 (Ask) and Mode 3 (Produce) specifically
      // so this could exist -- Mode 3's report-assembly call was confirmed live to hit
      // Netlify's ~30s sync ceiling under the old flow, where Produce began automatically
      // the instant Mode 2 closed with no client-side pause to intercept.
      if (prepRoute === 'cs-15' && userId) {
        const lastUserMsgForPrepTrigger = [...messages].reverse().find(m => m.role === 'user');
        const isWeeklyPlanRealTrigger = lastUserMsgForPrepTrigger &&
          typeof lastUserMsgForPrepTrigger.content === 'string' &&
          lastUserMsgForPrepTrigger.content.trim().toLowerCase() === 'build my weekly plan';

        if (isWeeklyPlanRealTrigger) {
          const jobPayload = {
            systemPrompt,
            messages: [
              { role: 'user', content: '[CONTEXT — DO NOT DISPLAY TO USER]\n' + buildContextString(context) + '\n[END CONTEXT]\n\nUser first name: ' + (userName || 'there') },
              { role: 'assistant', content: 'Understood. I have the full operating picture. Ready.' },
              ...messages.map(m => ({ role: m.role, content: m.content }))
            ],
            reportKind: 'weekly_plan',
            meta: { clientName: userName || 'Client' }
          };

          const createRes = await fetch(`${SUPABASE_URL}/rest/v1/report_jobs`, {
            method: 'POST',
            headers: {
              'apikey': SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
              'Content-Type': 'application/json', 'Prefer': 'return=representation'
            },
            body: JSON.stringify({ user_id: userId, box_id: 'weekly_plan', room: 'prep', request_payload: jobPayload })
          });
          const createdJob = (await createRes.json())?.[0];

          if (createdJob && createdJob.id) {
            try {
              const invokeRes = await fetch(`${process.env.URL || 'https://sprightly-starburst-210796.netlify.app'}/generate-report-background`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ jobId: createdJob.id })
              });
              if (invokeRes.status !== 202) {
                console.error('Background function invocation returned unexpected status:', invokeRes.status);
              }
            } catch (err) {
              console.error('Failed to invoke background function:', err);
            }

            return {
              statusCode: 200, headers: corsHeaders(),
              body: JSON.stringify({
                message: 'Your Weekly Plan is being built. This usually takes about 30-75 seconds — feel free to check back.',
                reportJobId: createdJob.id,
                hasLogsToday: true
              })
            };
          }
          // If job creation failed for any reason, fall through to the normal synchronous
          // path below rather than losing the request entirely.
        }
      }
    } else {
      const hasOP = await hasOperatingPicture(userId);
      if (!hasOP) {
        const cs11Prompt = await getPrompt('cs-11');
        if (!cs11Prompt) return { statusCode: 500, headers: corsHeaders(), body: JSON.stringify({ error: 'CS-11 not found in Supabase' }) };
        systemPrompt = cs11Prompt;
      } else {
        const cs12Prompt = await getPrompt('cs-12');
        if (!cs12Prompt) return { statusCode: 500, headers: corsHeaders(), body: JSON.stringify({ error: 'CS-12 not found in Supabase' }) };
        systemPrompt = cs12Prompt;
      }
    }

    const isFirstMessage = messages.filter(m => m.role === 'user').length === 1;
    if (isFirstMessage && userId && (room === 'chat' || room === 'prep')) {
      const acknowledgment = await checkAndWritePartialReceipt(userId, room);
      if (acknowledgment) {
        systemPrompt = acknowledgment + '\n\n' + systemPrompt;
      }
    }

    // ── WRITE USER MESSAGE BEFORE ANTHROPIC CALL ─────────────────────────────
    let sessionKey = null;
    let lastUserMsg = null;
    if (userId && messages && messages.length > 0) {
      lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
      if (lastUserMsg && lastUserMsg.content !== '__AUTOSTART__') {
        const today = new Date().toISOString().slice(0, 10);
        const roomName = room || 'unknown';
        sessionKey = `${userId}-${today}-${roomName}`;
        await writeUserMessageLog(userId, roomName, lastUserMsg.content, sessionKey);
      }
    }

    // ── DAILY BRIEF active memory ────────────────────────────────────────────
    // Only the Daily Brief (room='chat') holds the rolling N-day verbatim thread.
    // The current user message was already logged above, so the loaded thread ends
    // with it (no duplication). Falls back to the frontend-sent messages if there is
    // no thread yet or this isn't the Daily Brief. Older history is in the receipts.
    let convoMessages = messages;
    if (room === 'chat' && userId) {
      const recentThread = await loadRecentThread(userId, 'chat', DAILY_LOOKBACK_DAYS, DAILY_LOOKBACK_MAX_TURNS);
      if (recentThread.length > 0) {
        const assembled = recentThread.slice();
        // The __AUTOSTART__ trigger is never logged; re-attach it so an auto-opened
        // brief still knows to generate the opening, now WITH the prior week in view.
        if (lastUserMsg && lastUserMsg.content === '__AUTOSTART__') {
          assembled.push({ role: 'user', content: '__AUTOSTART__' });
        }
        const normalized = normalizeTurns(assembled);
        if (normalized.length > 0) convoMessages = normalized;
      }
    }

    const contextStr = buildContextString(context);
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: MODEL,
        // max_tokens: 4096 (2026-07-02, Phase 1 fix). Real Netlify function logs (not
        // available on 07-01, obtained 07-02) showed the true sync ceiling is ~30s
        // (504 Gateway Timeout at 30199ms), not the ~10s assumed on 07-01 -- explaining
        // why both prior guesses (10000, then 5000) failed identically with a generic
        // Connection error: the actual blocker was CSS generation TIME, not the token
        // BUDGET. Root fix (this commit): VT playbooks no longer generate CSS/full-HTML
        // at all -- buildVTPlaybookOutputBlock() now asks for content-only, and
        // wrapVTPlaybookInTemplate() applies REF-pdf-html-standard's styling mechanically
        // after the model responds, at zero LLM-token cost. Evidence for 4096: the
        // <style> block alone was 3,511 chars (~878 tokens) of the old per-turn cost,
        // now removed entirely; a working quarterly_reviews row (full styled HTML incl.
        // its own CSS) was 18,807 chars (~4,701 tokens) -- with CSS removed, real
        // content-only VT playbook length should land well under half that. 4096 gives
        // ~2x headroom above that content-only estimate while finishing generation far
        // faster than either failed CSS-inclusive attempt.
        max_tokens: 4096,
        system: systemPrompt,
        messages: [
          { role: 'user', content: '[CONTEXT — DO NOT DISPLAY TO USER]\n' + contextStr + '\n[END CONTEXT]\n\nUser first name: ' + (userName || 'there') },
          { role: 'assistant', content: 'Understood. I have the full operating picture. Ready.' },
          ...convoMessages.map(m => ({ role: m.role, content: m.content }))
        ]
      })
    });

    if (!response.ok) { const err = await response.text(); console.error('Anthropic error:', err); throw new Error('Anthropic API error'); }
    const data = await response.json();
    const message = data.content?.[0]?.text || 'No response received.';

    if (message.includes('%%AOP%%') && message.includes('%%END_AOP%%') && userId) {
      const aopData = extractAndWriteAOP(message, userId);
      if (aopData) {
        try {
          await writeAOP(aopData);
          console.log('AOP row written for user:', userId);
        } catch (aopErr) {
          console.error('AOP write failed:', aopErr);
        }
      }
    }

    // ── WEEKLY PLAN write-back (2026-07-01) ──────────────────────────────────
    // reportHtml/reportType (2026-07-01, Task A): the frontend needs the actual
    // rendered report HTML to build the PDF-download toolbar + iframe. Previously
    // this HTML was parsed here only to write to Supabase, then discarded — the
    // frontend never received it. Now the same parsed value is also returned in
    // the response body. reportHtml/reportType stay null/absent on every normal
    // turn — only populated the one turn a report marker actually fires.
    let reportHtml = null;
    let reportType = null;
    if (message.includes('%%WEEKLY_PLAN%%') && message.includes('%%END_WEEKLY_PLAN%%') && userId) {
      const weeklyPlanData = extractWeeklyPlan(message);
      if (weeklyPlanData) {
        // weekly_planning_reports' HTML field is full_report (per CS-15's own
        // write-list) — NOT client_html, which is the quarterly_reviews field name.
        if (weeklyPlanData.full_report) {
          reportHtml = weeklyPlanData.full_report;
          reportType = 'weekly_plan';
        }
        try {
          await writeWeeklyPlan(weeklyPlanData, userId, userName);
          console.log('Weekly Plan row written for user:', userId);
        } catch (wpErr) {
          console.error('Weekly Plan write failed:', wpErr);
        }
      }
    }

    // ── QUARTERLY REVIEW write-back (2026-07-01) ─────────────────────────────
    if (message.includes('%%QUARTERLY%%') && message.includes('%%END_QUARTERLY%%') && userId) {
      const quarterlyData = extractQuarterly(message);
      if (quarterlyData) {
        // quarterly_reviews' HTML field is client_html (per CS-13/CS-14's own
        // write-list) — NOT full_report, which is the weekly_planning_reports field name.
        if (quarterlyData.client_html) {
          reportHtml = quarterlyData.client_html;
          reportType = quarterlyData.type === 'look_forward' ? 'look_forward' : 'look_backward';
        }
        try {
          await writeQuarterlyReview(quarterlyData, userId);
          console.log('Quarterly review row written for user:', userId, 'type:', quarterlyData.type);
        } catch (qErr) {
          console.error('Quarterly review write failed:', qErr);
        }
      }
    }

    // ── VIRTUAL TEAM PLAYBOOK passthrough (2026-07-01) ──────────────────────
    // No Supabase write — VT playbooks have no dedicated persistence table (their only
    // durable trace is the CS-Receipt, already wired). This just isolates the HTML out
    // of the marker so it never hits renderMarkdown() as raw escaped text, and hands it
    // to the frontend the same way Weekly Plan / Quarterly reports are handed off.
    if (message.includes('%%VT_PLAYBOOK%%') && message.includes('%%END_VT_PLAYBOOK%%')) {
      const vtPlaybookData = extractVTPlaybook(message);
      if (vtPlaybookData && vtPlaybookData.html) {
        // (2026-07-02, Phase 1 fix) Model now returns CONTENT ONLY (no CSS/wrapper) —
        // wrap it in REF-pdf-html-standard's actual template here, mechanically, using
        // context already available on this request (client/firm/date), same general
        // mechanism intended to extend to Weekly Plan / Quarterly in Phase 2.
        try {
          reportHtml = await wrapVTPlaybookInTemplate(vtPlaybookData.html, vtPlaybookData.title, {
            clientName: (userName || 'Client'),
            firmName: 'Coveted Consultant',
            dateStr: new Date().toLocaleDateString('en-US', { timeZone: 'America/New_York', year: 'numeric', month: 'long', day: 'numeric' })
          });
        } catch (wrapErr) {
          console.error('wrapVTPlaybookInTemplate failed, falling back to unwrapped content:', wrapErr);
          reportHtml = vtPlaybookData.html;
        }
        reportType = 'vt_playbook';
      } else {
        console.error('VT_PLAYBOOK marker present but extraction failed or produced empty HTML');
      }
    }

    // ── WRITE ASSISTANT MESSAGE AFTER ANTHROPIC RESPONSE ────────────────────────
    if (sessionKey && lastUserMsg) {
      const cleanMessage = message
        .replace(/%%AOP%%[\s\S]*?%%END_AOP%%/g, '')
        .replace(/%%RECEIPT%%[\s\S]*?%%END_RECEIPT%%/g, '')
        .replace(/%%WEEKLY_PLAN%%[\s\S]*?%%END_WEEKLY_PLAN%%/g, '')
        .replace(/%%QUARTERLY%%[\s\S]*?%%END_QUARTERLY%%/g, '')
        .replace(/%%VT_PLAYBOOK%%[\s\S]*?%%END_VT_PLAYBOOK%%/g, '')
        .replace(/\[NORTH_STAR_COMPLETE\]/g, '')
        .trim();
      writeAssistantMessageLog(userId, room || 'unknown', cleanMessage, sessionKey).catch(err => {
        console.error('Assistant log fire-and-forget error:', err);
      });
    }

    // Strip report markers from the response body too — the raw marker JSON should
    // never appear in the visible chat text. The parsed HTML itself is carried
    // separately via reportHtml/reportType (set above), not left inside message.
    const cleanForClient = message
      .replace(/%%WEEKLY_PLAN%%[\s\S]*?%%END_WEEKLY_PLAN%%/g, '')
      .replace(/%%QUARTERLY%%[\s\S]*?%%END_QUARTERLY%%/g, '')
      .replace(/%%VT_PLAYBOOK%%[\s\S]*?%%END_VT_PLAYBOOK%%/g, '')
      .trim();

    const responseBody = { message: cleanForClient, hasLogsToday: !!sessionKey };
    if (reportHtml) {
      responseBody.reportHtml = reportHtml;
      responseBody.reportType = reportType;
    }

    return { statusCode: 200, headers: corsHeaders(), body: JSON.stringify(responseBody) };

  } catch (err) {
    console.error('Chat function error:', err);
    return { statusCode: 500, headers: corsHeaders(), body: JSON.stringify({ error: err.message }) };
  }
};

function buildContextString(ctx) {
  if (!ctx) return 'No context available.';
  const lines = [];
  const todayET = new Date().toLocaleDateString('en-US', { timeZone: 'America/New_York', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  lines.push('TODAY\'S DATE: ' + todayET);
  if (ctx.annual_operating_picture) {
    const a = ctx.annual_operating_picture;
    lines.push('\n=== ANNUAL OPERATING PICTURE ===');
    if (a.annual_arrival) lines.push('Annual Arrival: ' + a.annual_arrival);
    if (a.mission_statement) lines.push('Mission: ' + a.mission_statement);
    if (a.annual_picture_rendered) lines.push('Annual Picture: ' + a.annual_picture_rendered);
    if (a.session_translation) lines.push('Session Translation: ' + a.session_translation);
    if (a.limiting_belief_raw) lines.push('Limiting Belief: ' + a.limiting_belief_raw);
    if (a.congruent_behavior_raw) lines.push('Congruent Behavior: ' + a.congruent_behavior_raw);
    if (a.defining_moment_summary) lines.push('Defining Moment: ' + a.defining_moment_summary);
    if (a.one_line_case_study) lines.push('One-Line Case Study: ' + a.one_line_case_study);
    if (a.one_line_case_study_expanded) lines.push('Case Study Expanded: ' + a.one_line_case_study_expanded);
    if (a.revenue_floor_bronze) lines.push('Revenue Floor (Bronze): ' + a.revenue_floor_bronze);
    if (a.revenue_floor_gold) lines.push('Revenue Floor (Gold): ' + a.revenue_floor_gold);
    if (a.five_freedoms_stated) lines.push('Five Freedoms: ' + JSON.stringify(a.five_freedoms_stated));
    if (a.first_focus) lines.push('First Focus This Week: ' + a.first_focus);
  }
  if (ctx.quarterly_dashboard) {
    const q = ctx.quarterly_dashboard;
    lines.push('\n=== CURRENT QUARTER ===');
    if (q.quarter) lines.push('Quarter: ' + q.quarter);
    if (q.quarterly_focus_professional) lines.push('Professional Focus: ' + q.quarterly_focus_professional);
    if (q.quarterly_focus_personal) lines.push('Personal Focus: ' + q.quarterly_focus_personal);
    if (q.quarterly_watch_out) lines.push('Watch Out: ' + q.quarterly_watch_out);
    if (q.quarterly_picture_rendered) lines.push('Quarterly Picture: ' + q.quarterly_picture_rendered);
    if (q.quarterly_connection_sentence) lines.push('Connection Sentence: ' + q.quarterly_connection_sentence);
    if (q.professional_action_plan) lines.push('Professional Action Plan: ' + JSON.stringify(q.professional_action_plan));
    if (q.current_professional_step) lines.push('Current Professional Step: ' + q.current_professional_step);
    if (q.personal_action_plan) lines.push('Personal Action Plan: ' + JSON.stringify(q.personal_action_plan));
    if (q.current_personal_step) lines.push('Current Personal Step: ' + q.current_personal_step);
  }
  if (ctx.recent_sessions && ctx.recent_sessions.length > 0) {
    lines.push('\n=== RECENT SESSIONS ===');
    ctx.recent_sessions.forEach(function(r, i) {
      lines.push('\nSession ' + (i+1) + ' — ' + r.session_date);
      if (r.session_scope) lines.push('  Scope: ' + r.session_scope);
      if (r.bronze_task) lines.push('  Bronze: ' + r.bronze_task + ' [' + (r.bronze_status || 'unknown') + ']');
      if (r.thread_tag) lines.push('  Thread: ' + r.thread_tag);
      if (r.progress_position) lines.push('  Position: ' + r.progress_position);
      if (r.say_ask_request) lines.push('  Coaching Prep: ' + r.say_ask_request);
    });
  }
  if (ctx.open_parking_lot && ctx.open_parking_lot.length > 0) {
    lines.push('\n=== OPEN PARKING LOT ===');
    ctx.open_parking_lot.forEach(function(p) {
      lines.push('- ' + p.item + (p.due_date ? ' (due ' + p.due_date + ')' : '') + (p.why ? ' — ' + p.why : ''));
    });
  }
  if (ctx.user) {
    lines.push('\n=== USER ===');
    lines.push('[SYSTEM: SESSION_USER_ID = ' + ctx.user.id + ']');
    lines.push('display_name: ' + ctx.user.display_name);
  }
  return lines.join('\n');
}

function corsHeaders() {
  return { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Content-Type': 'application/json' };
}


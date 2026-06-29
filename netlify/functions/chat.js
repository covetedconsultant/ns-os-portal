// netlify/functions/chat.js
// deploy: 2026-06-29-full-prep-chain-injection
// Daily Brief active memory (Item 4): room='chat' loads the rolling DAILY_LOOKBACK_DAYS
// of its own verbatim conversation as context; older history carried by receipts.
// Routing by room:
//   room=setup        → CS-11 (no AOP) or CS-12 (has AOP) — onboarding/document intake
//   room=chat         → chat-b (Daily Brief / Chief of Staff agent)
//   room=prep         → chat-c (Prep Room agent)
//   room=virtualteam  → a Virtual Team box prompt (vt-*), selected by boxId from the frontend
// CS-1, CS-9, CS-Receipt load on-demand inside chat (room=chat) only.
// CS-Receipt also loads on-demand inside virtualteam (close fires the unified receipt + box_built).
// AOP write: when CS-11 outputs %%AOP%%...%%END_AOP%%, chat.js extracts the JSON
// and writes the row to annual_operating_picture before returning the response.
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
//   'My weekly check-in.'               → tr-2
//   "I'd like to do my quarterly review." → menu-quarterly-review-prep
//   anything else                        → chat-c (shows A/B menu)
function detectPrepRoute(messages) {
  if (!messages || messages.length === 0) return 'chat-c';
  const firstUserMsg = messages.find(m => m.role === 'user');
  if (!firstUserMsg) return 'chat-c';
  const text = firstUserMsg.content.toLowerCase().trim();
  if (text.includes('weekly check-in') || text.includes('weekly checkin') || text.includes('weekly check in')) {
    return 'tr-2';
  }
  if (text.includes('quarterly review')) {
    return 'menu-quarterly-review-prep';
  }
  return 'chat-c';
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

function userSelectedOptionB(messages) {
  const signals = ['option b', 'show me my brief', 'north star brief', 'my brief', 'morning brief'];
  for (const msg of messages) {
    if (msg.role !== 'user') continue;
    const text = msg.content.toLowerCase().trim();
    if (text === 'b') return true;
    if (signals.some(s => text.includes(s))) return true;
  }
  return false;
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

    let systemPrompt;

    if (room === 'chat') {
      const chatBPrompt = await getPrompt('chat-b');
      if (!chatBPrompt) return { statusCode: 500, headers: corsHeaders(), body: JSON.stringify({ error: 'chat-b prompt not found in Supabase' }) };
      systemPrompt = chatBPrompt;

      if (userSelectedOptionB(messages)) {
        const cs1Prompt = await getPrompt('cs-1');
        if (cs1Prompt) systemPrompt += '\n\n---\n\n## CS-1 — MORNING MEETING\n\n' + cs1Prompt;
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

      // Every VT box renders its playbook HTML to the shared master design standard.
      // Load it once from Supabase and append so the box always has it in context.
      const designStandard = await getPrompt('REF-pdf-html-standard');
      if (designStandard) systemPrompt += '\n\n---\n\n## NS-OS-PDF-HTML-STANDARD — MASTER DESIGN STANDARD (render all playbook HTML to this)\n\n' + designStandard;

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
      const prepRoute = detectPrepRoute(messages);
      if (prepRoute === 'tr-2') {
        // Weekly check-in — fetch base protocol + REF
        const [tr2Prompt, refWeekly] = await Promise.all([
          getPrompt('tr-2'),
          getPrompt('REF-weekly-planning-conversation-standard')
        ]);
        if (!tr2Prompt) return { statusCode: 500, headers: corsHeaders(), body: JSON.stringify({ error: 'tr-2 prompt not found in Supabase' }) };
        systemPrompt = tr2Prompt;
        if (refWeekly) systemPrompt += '\n\n---\n\n## REF — WEEKLY PLANNING CONVERSATION STANDARD\n\n[SYSTEM: This document has been loaded into this session by chat.js. The AI does not need to fetch it.]\n\n' + refWeekly;
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
      } else {
        // Ambiguous — show A/B menu via chat-c
        const chatCPrompt = await getPrompt('chat-c');
        if (!chatCPrompt) return { statusCode: 500, headers: corsHeaders(), body: JSON.stringify({ error: 'chat-c prompt not found in Supabase' }) };
        systemPrompt = chatCPrompt;
      }
      if (csReceiptShouldLoad(messages)) {
        const csReceiptPrompt = await getPrompt('cs-receipt');
        if (csReceiptPrompt) {
          const roomLabel = prepRoute === 'tr-2' ? 'Prep Room — Weekly Planning Partner' :
                            prepRoute === 'menu-quarterly-review-prep' ? 'Prep Room — Quarterly Review' : 'Prep Room';
          const triggerCtx = prepRoute === 'tr-2' ? 'weekly_planning' :
                             prepRoute === 'menu-quarterly-review-prep' ? 'quarterly_review' : 'prep_room';
          systemPrompt += buildReceiptCloseBlock(csReceiptPrompt, { triggerContext: triggerCtx, roomsVisited: roomLabel });
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
        max_tokens: 2048,
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

    // ── WRITE ASSISTANT MESSAGE AFTER ANTHROPIC RESPONSE ────────────────────────
    if (sessionKey && lastUserMsg) {
      const cleanMessage = message
        .replace(/%%AOP%%[\s\S]*?%%END_AOP%%/g, '')
        .replace(/%%RECEIPT%%[\s\S]*?%%END_RECEIPT%%/g, '')
        .replace(/\[NORTH_STAR_COMPLETE\]/g, '')
        .trim();
      writeAssistantMessageLog(userId, room || 'unknown', cleanMessage, sessionKey).catch(err => {
        console.error('Assistant log fire-and-forget error:', err);
      });
    }

    return { statusCode: 200, headers: corsHeaders(), body: JSON.stringify({ message, hasLogsToday: !!sessionKey }) };

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

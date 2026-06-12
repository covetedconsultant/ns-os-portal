// netlify/functions/chat.js
// deploy: 2026-06-12-f
// Routing by room:
//   room=setup → CS-11 (no AOP) or CS-12 (has AOP) — onboarding/document intake
//   room=chat  → chat-b (Daily Brief / Chief of Staff agent)
//   room=prep  → chat-c (Prep Room agent)
// CS-1, CS-9, CS-Receipt load on-demand inside chat (room=chat) only.
// AOP write: when CS-11 outputs %%AOP%%...%%END_AOP%%, chat.js extracts the JSON
// and writes the row to annual_operating_picture before returning the response.
// Conversation logging: every user+assistant exchange is written to conversation_logs.

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const SUPABASE_URL = 'https://omjsqianefykbebnrdmp.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const MODEL = 'claude-sonnet-4-6';

async function getPrompt(skillId) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/system_prompts?skill_id=eq.${skillId}&active=eq.true&select=system_prompt&limit=1`, {
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

// ── CONVERSATION LOG WRITE ──────────────────────────────────────────────
async function writeConversationLog(userId, room, userMessage, assistantMessage, sessionKey) {
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!userId || !uuidPattern.test(userId)) {
    console.error('Conversation log rejected: invalid userId');
    return;
  }

  const rows = [
    { user_id: userId, room, role: 'user', content: userMessage, session_key: sessionKey },
    { user_id: userId, room, role: 'assistant', content: assistantMessage, session_key: sessionKey }
  ];

  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/conversation_logs`, {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal'
      },
      body: JSON.stringify(rows)
    });
    if (!res.ok) {
      console.error('Conversation log write failed:', await res.text());
    }
  } catch (err) {
    console.error('Conversation log write error:', err);
  }
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
  // Also trigger if the user mentions "receipt" in any form
  if (lastUserMsg.includes('receipt')) return true;
  return closeSignals.some(s => lastUserMsg.includes(s));
}

// ── SESSION START: CHECK FOR ORPHANED SESSION, WRITE PARTIAL RECEIPT ────────────
// Called on first user message of each room session.
// If the user's last session for this room ended without a receipt, synthesize
// a partial receipt from conversation_logs and write it with completion_status='incomplete'.
// Returns acknowledgment text to prepend to the CoS context (or null if nothing to acknowledge).
async function checkAndWritePartialReceipt(userId, room) {
  try {
    // 1. Find most recent receipt for this user+room
    const receiptRes = await fetch(
      `${SUPABASE_URL}/rest/v1/session_receipts?user_id=eq.${userId}&room_id=eq.north-star-room&select=session_date,completion_status,receipt_number&order=session_date.desc&limit=1`,
      { headers: { 'apikey': SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}` } }
    );
    const receipts = await receiptRes.json();
    const lastReceipt = receipts?.[0] || null;
    const lastReceiptDate = lastReceipt?.session_date || null;
    const lastReceiptStatus = lastReceipt?.completion_status || null;

    // 2. Find conversation_logs for this user+room that post-date the last receipt (or all if no receipt)
    let logsFilter = `user_id=eq.${userId}&room=eq.${room}&select=role,content,session_key,created_at&order=created_at.asc`;
    if (lastReceiptDate) {
      // Only look at logs from after the last receipt date
      logsFilter += `&created_at=gt.${lastReceiptDate}T23:59:59.999Z`;
    }
    const logsRes = await fetch(
      `${SUPABASE_URL}/rest/v1/conversation_logs?${logsFilter}&limit=100`,
      { headers: { 'apikey': SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}` } }
    );
    const logs = await logsRes.json();

    // 3. If no orphaned logs — nothing to do
    if (!logs || logs.length === 0) return null;

    // 4. Determine which session_key(s) these belong to — take the most recent distinct session_key
    const sessionKeys = [...new Set(logs.map(l => l.session_key).filter(Boolean))];
    if (sessionKeys.length === 0) return null;

    // Get logs for the most recent orphaned session only
    const mostRecentKey = sessionKeys[sessionKeys.length - 1];
    const sessionLogs = logs.filter(l => l.session_key === mostRecentKey);

    // Extract the date from the session key (format: userId-YYYY-MM-DD-room)
    const keyParts = mostRecentKey.split('-');
    // session_key = UUID(5 parts)-YYYY-MM-DD-room → date is at index 5,6,7
    let orphanDate = null;
    if (keyParts.length >= 8) {
      orphanDate = `${keyParts[5]}-${keyParts[6]}-${keyParts[7]}`;
    } else {
      orphanDate = new Date().toISOString().slice(0, 10);
    }

    // 5. Synthesize a brief partial receipt using Claude
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

    // 6. Write the partial receipt to Supabase
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

    // 7. Return acknowledgment text to prepend to CoS context
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
    const { messages, context, userName, userId, room } = JSON.parse(event.body);

    let systemPrompt;

    // ── ROOM-BASED ROUTING ────────────────────────────────────────────────────────────────────────────
    if (room === 'chat') {
      // Daily Brief — always loads chat-b
      const chatBPrompt = await getPrompt('chat-b');
      if (!chatBPrompt) return { statusCode: 500, headers: corsHeaders(), body: JSON.stringify({ error: 'chat-b prompt not found in Supabase' }) };
      systemPrompt = chatBPrompt;

      // On-demand loaders for Daily Brief only
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
          systemPrompt += '\n\n---\n\n## CS-RECEIPT — SESSION CLOSE PROTOCOL\n\n' + csReceiptPrompt;
          systemPrompt += '\n\n---\n\n## CUSTOM BUILD OUTPUT OVERRIDE — REQUIRED\n\n' +
            'You are running inside the custom portal (sprightly-starburst-210796.netlify.app). ' +
            'After completing the parking lot sweep, output your session close in EXACTLY this format — no exceptions:\n\n' +
            '[Your brief closing words — 1-3 sentences max]\n' +
            '%%RECEIPT%%{"session_scope":"[one sentence]","bronze_task":"[the task]","bronze_status":"yes","completion_status":"bronze","trigger_context":"daily_work","outcome_type":"task_completed","thread_tag":"[topic slug]","rooms_visited":"Daily Work — Chief of Staff","carried_forward":"[any open items or none]"}%%END_RECEIPT%%\n' +
            'Session closed. [receipt pending]\n\n' +
            'RULES:\n- Do NOT output a bullet list of receipt fields.\n- Do NOT output any text after "Session closed. [receipt pending]".\n- The %%RECEIPT%% block must be valid JSON — no trailing commas, no line breaks inside.\n- The frontend detects this block, strips it from display, writes it to Supabase, and replaces [receipt pending] with the real receipt number.\n- If you output a human-readable summary instead, the receipt write FAILS and the session is not recorded.';
        }
      }

    } else if (room === 'prep') {
      // Prep Room — always loads chat-c
      const chatCPrompt = await getPrompt('chat-c');
      if (!chatCPrompt) return { statusCode: 500, headers: corsHeaders(), body: JSON.stringify({ error: 'chat-c prompt not found in Supabase' }) };
      systemPrompt = chatCPrompt;

    } else {
      // Setup room (or unknown) — AOP-based routing: CS-11 or CS-12
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

    // ── SESSION START CHECK: partial receipt synthesis ─────────────────────────────────────────
    // On the first user message of a session (only one user message so far),
    // check if the previous session ended without a receipt. If so, synthesize
    // a partial receipt and prepend an acknowledgment note to the system prompt.
    const isFirstMessage = messages.filter(m => m.role === 'user').length === 1;
    if (isFirstMessage && userId && (room === 'chat' || room === 'prep')) {
      const acknowledgment = await checkAndWritePartialReceipt(userId, room);
      if (acknowledgment) {
        systemPrompt = acknowledgment + '\n\n' + systemPrompt;
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
          ...messages.map(m => ({ role: m.role, content: m.content }))
        ]
      })
    });

    if (!response.ok) { const err = await response.text(); console.error('Anthropic error:', err); throw new Error('Anthropic API error'); }
    const data = await response.json();
    const message = data.content?.[0]?.text || 'No response received.';

    // ── AOP WRITE ────────────────────────────────────────────────────────────────────────────
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

    // ── CONVERSATION LOG WRITE ─────────────────────────────────────────────────────────────────────────
    if (userId && messages && messages.length > 0) {
      const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
      if (lastUserMsg && lastUserMsg.content !== '__AUTOSTART__') {
        const today = new Date().toISOString().slice(0, 10);
        const roomName = room || 'unknown';
        const sessionKey = `${userId}-${today}-${roomName}`;
        const cleanMessage = message
          .replace(/%%AOP%%[\s\S]*?%%END_AOP%%/g, '')
          .replace(/%%RECEIPT%%[\s\S]*?%%END_RECEIPT%%/g, '')
          .replace(/\[NORTH_STAR_COMPLETE\]/g, '')
          .trim();
        writeConversationLog(userId, roomName, lastUserMsg.content, cleanMessage, sessionKey).catch(err => {
          console.error('Conversation log fire-and-forget error:', err);
        });
      }
    }

    return { statusCode: 200, headers: corsHeaders(), body: JSON.stringify({ message }) };

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

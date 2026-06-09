// netlify/functions/chat.js
// Loads governing doc (chat-b) at session start.
// Fetches CS-1 on-demand when user selects Option B (North Star brief).
// Fetches CS-9 on-demand when user confirms a numbered offer from CS-1 or Option A.
// Fetches CS-Receipt on-demand when session close is detected.

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

// Option B selected: user wants their North Star brief
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

// CS-9 trigger: user has confirmed a numbered offer from CS-1 (Option B) or Option A.
// Signals: user replies with a single number 1-3, or explicitly confirms an offer.
// Only fires once CS-1 or Option A has already been active (i.e. Option B was selected
// or the conversation has reached the offer-presentation stage).
function cs9ShouldLoad(messages) {
  // CS-9 only relevant if Option B was selected OR assistant has presented numbered offers
  const assistantPresentedOffers = messages.some(msg =>
    msg.role === 'assistant' &&
    (
      msg.content.includes('Here are three ways I can help') ||
      msg.content.includes('three ways I can help right now') ||
      msg.content.includes('How I Can Help Right Now')
    )
  );
  if (!assistantPresentedOffers) return false;

  // Look for user confirming a numbered offer after the assistant presented them
  const offerPresentedIdx = messages.findIndex(msg =>
    msg.role === 'assistant' &&
    (
      msg.content.includes('Here are three ways I can help') ||
      msg.content.includes('three ways I can help right now') ||
      msg.content.includes('How I Can Help Right Now')
    )
  );

  // Check messages after the offer was presented
  const afterOffers = messages.slice(offerPresentedIdx + 1);
  const confirmSignals = ['1', '2', '3', 'option 1', 'option 2', 'option 3', 'yes', 'let\'s do that', 'that one', 'go with'];
  for (const msg of afterOffers) {
    if (msg.role !== 'user') continue;
    const text = msg.content.toLowerCase().trim();
    if (confirmSignals.some(s => text === s || text.startsWith(s + ' ') || text.startsWith(s + ','))) return true;
  }
  return false;
}

// CS-Receipt trigger: session is winding down.
// Signals: user or context indicates they are done for the session.
function csReceiptShouldLoad(messages) {
  const closeSignals = [
    'that\'s it', 'that is it', 'we\'re done', 'we are done',
    'close it out', 'close the session', 'session closed',
    'close out', 'wrap up', 'wrap it up',
    'i\'m done', 'i am done', 'all done',
    'thanks, that\'s all', 'that\'s all for now', 'nothing else',
    'good to go', 'let\'s close'
  ];
  // Only look at the most recent user message — avoid false positives from mid-session
  const userMessages = messages.filter(m => m.role === 'user');
  if (userMessages.length === 0) return false;
  const lastUserMsg = userMessages[userMessages.length - 1].content.toLowerCase().trim();
  return closeSignals.some(s => lastUserMsg.includes(s));
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: corsHeaders(), body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }
  if (!ANTHROPIC_API_KEY) {
    return { statusCode: 500, headers: corsHeaders(), body: JSON.stringify({ error: 'API key not configured' }) };
  }

  try {
    const { messages, context, userName } = JSON.parse(event.body);

    // Always load governing doc
    const governingPrompt = await getPrompt('chat-b');

    if (!governingPrompt) {
      return { statusCode: 500, headers: corsHeaders(), body: JSON.stringify({ error: 'Governing doc not found in Supabase' }) };
    }

    // Build system prompt — start with governing doc, append protocols as triggered
    let systemPrompt = governingPrompt;

    // CS-1: load when user selects Option B
    if (userSelectedOptionB(messages)) {
      const cs1Prompt = await getPrompt('cs-1');
      if (cs1Prompt) {
        systemPrompt += '\n\n---\n\n## CS-1 — MORNING MEETING\n\n' + cs1Prompt;
      }
    }

    // CS-9: load when user confirms a numbered offer (after CS-1 or Option A presents them)
    if (cs9ShouldLoad(messages)) {
      const cs9Prompt = await getPrompt('cs-9');
      if (cs9Prompt) {
        systemPrompt += '\n\n---\n\n## CS-9 — RECOMMENDATIONS RESPONSE PROTOCOL\n\n' + cs9Prompt;
      }
    }

    // CS-Receipt: load when session close is detected
    if (csReceiptShouldLoad(messages)) {
      const csReceiptPrompt = await getPrompt('cs-receipt');
      if (csReceiptPrompt) {
        systemPrompt += '\n\n---\n\n## CS-RECEIPT — SESSION CLOSE PROTOCOL\n\n' + csReceiptPrompt;
      }
    }

    const contextStr = buildContextString(context);

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 2048,
        system: systemPrompt,
        messages: [
          {
            role: 'user',
            content: '[CONTEXT — DO NOT DISPLAY TO USER]\n' + contextStr + '\n[END CONTEXT]\n\nUser first name: ' + (userName || 'there')
          },
          {
            role: 'assistant',
            content: 'Understood. I have the full operating picture. Ready.'
          },
          ...messages.map(m => ({ role: m.role, content: m.content }))
        ]
      })
    });

    if (!response.ok) {
      const err = await response.text();
      console.error('Anthropic error:', err);
      throw new Error('Anthropic API error');
    }

    const data = await response.json();
    const message = data.content?.[0]?.text || 'No response received.';

    return { statusCode: 200, headers: corsHeaders(), body: JSON.stringify({ message }) };

  } catch (err) {
    console.error('Chat function error:', err);
    return { statusCode: 500, headers: corsHeaders(), body: JSON.stringify({ error: err.message }) };
  }
};

function buildContextString(ctx) {
  if (!ctx) return 'No context available.';
  const lines = [];

  if (ctx.annual_operating_picture) {
    const a = ctx.annual_operating_picture;
    lines.push('=== ANNUAL OPERATING PICTURE ===');
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
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };
}

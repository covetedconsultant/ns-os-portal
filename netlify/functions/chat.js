// netlify/functions/chat.js
// Loads governing doc (chat-b) at session start.
// Fetches CS-1 on-demand only when user selects Option B (North Star brief).

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

// Detect whether the user has selected Option B (North Star brief)
// Looks across all user messages for clear Option B signals
function userSelectedOptionB(messages) {
  const signals = ['option b', 'show me my brief', 'north star brief', 'my brief', 'morning brief'];
  for (const msg of messages) {
    if (msg.role !== 'user') continue;
    const text = msg.content.toLowerCase().trim();
    // Single letter 'b' as standalone selection
    if (text === 'b') return true;
    // Check for any signal phrase
    if (signals.some(s => text.includes(s))) return true;
  }
  return false;
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

    // Only fetch CS-1 if user has selected Option B
    let systemPrompt = governingPrompt;
    if (userSelectedOptionB(messages)) {
      const cs1Prompt = await getPrompt('cs-1');
      if (cs1Prompt) {
        systemPrompt += '\n\n---\n\n## CS-1 — MORNING MEETING\n\n' + cs1Prompt;
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
    lines.push('user_id: ' + ctx.user.id);
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

// netlify/functions/lib/daily-brief-room.js
// The Daily Brief room (room='chat') handler, extracted from chat.js 2026-07-02.
// Same behavior as the prior inline block — route detection (CS-1 / CS-16 /
// redirect-upload / redirect-quarterly), CS-9 recommendations-response overlay,
// and the receipt close block. Pattern mirrors virtual-team-room.js and
// prep-room.js: one exported handler taking request fields + an explicit deps
// object, returning either { response } (caller returns immediately) or
// { systemPrompt } (caller continues the normal synchronous path).
//
// NOT moved here (deliberately stay in chat.js — shared/cross-room):
//   - buildReceiptCloseBlock (shared by chat, virtualteam, prep)
//   - loadRecentThread / normalizeTurns / DAILY_LOOKBACK_DAYS / DAILY_LOOKBACK_MAX_TURNS
//     (invoked later in chat.js's shared handler tail, outside the room-branch
//     chain entirely — gated on room==='chat' && userId but not part of this block)
//   - getPrompt, csReceiptShouldLoad, corsHeaders (shared deps, injected below)
//
// ── NORTH STAR BRIEF: LOOKUP-OR-GENERATE (added 2026-07-06) ─────────────────
// The brief is a fixed morning read, not something that regenerates on every
// visit. Auto-fire (dashboard.html's autobrief flag, fired once on landing)
// and the manual "I'd like to see my North Star brief" chip share this EXACT
// same path — neither ever calls cs-1 directly — so the two can never disagree
// about what "today's brief" is, even across five logins in one day.
//
// getTodayDateKeyET() reuses the same en-CA/America-New-York idiom
// dashboard.html's writeSessionReceipt() already uses for session_date — one
// Eastern-date source across the codebase, not a second one introduced here.
function getTodayDateKeyET() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

// Looks up today's saved brief for this user. Returns the row or null.
async function lookupDailyBrief(userId, deps) {
  const { SUPABASE_URL, SUPABASE_SERVICE_KEY } = deps;
  const dateKey = getTodayDateKeyET();
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/daily_briefs?user_id=eq.${userId}&brief_date=eq.${dateKey}&select=brief_content&limit=1`,
    { headers: { 'apikey': SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}` } }
  );
  if (!res.ok) return null;
  const data = await res.json();
  return (Array.isArray(data) && data.length > 0) ? data[0] : null;
}

// Saves a freshly generated brief for this user + today's date. Called from
// chat.js's tail AFTER the Anthropic response comes back — the route handler
// below resolves before the model has replied, so it cannot save the content
// itself. Uses upsert (Prefer: resolution=merge-duplicates) so a race between
// two near-simultaneous requests on the same day can't violate the unique
// (user_id, brief_date) constraint.
async function saveDailyBrief(userId, briefContent, deps) {
  const { SUPABASE_URL, SUPABASE_SERVICE_KEY } = deps;
  const dateKey = getTodayDateKeyET();
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/daily_briefs?on_conflict=user_id,brief_date`, {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'resolution=merge-duplicates'
      },
      body: JSON.stringify({ user_id: userId, brief_date: dateKey, brief_content: briefContent })
    });
  } catch (err) {
    console.error('daily_briefs save failed:', err);
  }
}

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

// handleDailyBriefRoom({ messages, userId, autobrief }, deps)
// deps: { getPrompt, buildReceiptCloseBlock, csReceiptShouldLoad, corsHeaders,
//         SUPABASE_URL, SUPABASE_SERVICE_KEY }
//
// autobrief: true when dashboard.html auto-fired this request on landing
// (the ?autobrief=true flag on arrival), as opposed to the user manually
// sending a message. Only affects what happens on a lookup MISS (force cs-1
// instead of falling through to detectDailyBriefRoute's cs-16 default, which
// is the right behavior for a real typed opening but not for a silent
// auto-fire with no user message yet).
async function handleDailyBriefRoom({ messages, userId, autobrief }, deps) {
  const { getPrompt, buildReceiptCloseBlock, csReceiptShouldLoad, corsHeaders, SUPABASE_URL, SUPABASE_SERVICE_KEY } = deps;

  // Direct dispatch (2026-07-01) — replaces the prior "always load chat-b
  // first, append on top" pattern. chat-b retired; see LOG-cs-16.
  let dailyBriefRoute = detectDailyBriefRoute(messages);

  // Autobrief with no user message yet (messages is empty or __AUTOSTART__-only)
  // would otherwise fall through detectDailyBriefRoute's ambiguous-opening
  // default (cs-16). Force cs-1 instead — this IS the brief-request path,
  // it just arrived silently instead of via a typed chip.
  if (autobrief && dailyBriefRoute !== 'cs-1') {
    dailyBriefRoute = 'cs-1';
  }

  // ── LOOKUP-OR-GENERATE (shared by autobrief AND the manual chip) ────────
  // Anything headed for cs-1 checks Supabase FIRST. A saved brief for today
  // short-circuits straight back as the reply — cs-1 never fires a second
  // time today, whether this is auto-fire attempt #1 or the user clicking
  // the manual chip for the fifth time today.
  if (dailyBriefRoute === 'cs-1' && userId && SUPABASE_URL && SUPABASE_SERVICE_KEY) {
    const savedBrief = await lookupDailyBrief(userId, { SUPABASE_URL, SUPABASE_SERVICE_KEY });
    if (savedBrief) {
      return {
        response: {
          statusCode: 200, headers: corsHeaders(),
          body: JSON.stringify({ message: savedBrief.brief_content, hasLogsToday: true })
        }
      };
    }
    // No row yet — fall through to cs-1 generating fresh below. chat.js's tail
    // saves the result once the model responds (this handler resolves before
    // that reply exists, so it cannot save here).
  }

  if (dailyBriefRoute === 'redirect-upload') {
    // Folded in from chat-b's former edge-case text — no protocol load needed,
    // this is a short fixed redirect message.
    return {
      response: {
        statusCode: 200, headers: corsHeaders(),
        body: JSON.stringify({ reply: "Document uploads happen in the Upload Documents chat. Head there and it will walk you through the process." })
      }
    };
  }
  if (dailyBriefRoute === 'redirect-quarterly') {
    return {
      response: {
        statusCode: 200, headers: corsHeaders(),
        body: JSON.stringify({ reply: "Quarterly reviews have their own dedicated space — the Preparation Work chat. Head there when you're ready." })
      }
    };
  }

  let systemPrompt;
  if (dailyBriefRoute === 'cs-1') {
    const cs1Prompt = await getPrompt('cs-1');
    if (!cs1Prompt) return { response: { statusCode: 500, headers: corsHeaders(), body: JSON.stringify({ error: 'cs-1 prompt not found in Supabase' }) } };
    systemPrompt = cs1Prompt;
  } else {
    // dailyBriefRoute === 'cs-16' (Talk Something Through, or ambiguous-opening fallback)
    const cs16Prompt = await getPrompt('cs-16');
    if (!cs16Prompt) return { response: { statusCode: 500, headers: corsHeaders(), body: JSON.stringify({ error: 'cs-16 prompt not found in Supabase' }) } };
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

  // dailyBriefRoute returned alongside systemPrompt (mirrors prep-room.js's
  // prepRoute) so chat.js's tail knows, after the Anthropic response comes
  // back, whether THIS turn was a fresh cs-1 generation that needs saving to
  // daily_briefs. cs-16 turns never get saved — only cs-1.
  return { systemPrompt, dailyBriefRoute };
}

module.exports = { detectDailyBriefRoute, cs9ShouldLoad, handleDailyBriefRoom, saveDailyBrief, getTodayDateKeyET };

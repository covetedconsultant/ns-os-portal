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

// handleDailyBriefRoom({ messages }, deps)
// deps: { getPrompt, buildReceiptCloseBlock, csReceiptShouldLoad, corsHeaders }
async function handleDailyBriefRoom({ messages }, deps) {
  const { getPrompt, buildReceiptCloseBlock, csReceiptShouldLoad, corsHeaders } = deps;

  // Direct dispatch (2026-07-01) — replaces the prior "always load chat-b
  // first, append on top" pattern. chat-b retired; see LOG-cs-16.
  const dailyBriefRoute = detectDailyBriefRoute(messages);

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

  return { systemPrompt };
}

module.exports = { detectDailyBriefRoute, cs9ShouldLoad, handleDailyBriefRoom };

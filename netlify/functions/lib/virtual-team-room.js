// netlify/functions/lib/virtual-team-room.js
// Extracted 2026-07-02 as part of the agreed chat.js restructuring plan
// (see project memory: project_chat_js_restructuring_plan.md).
//
// Holds everything specific to room === 'virtualteam': the box allowlist, box
// labels, the VT-only output-override block, the background-build trigger
// phrases, and the full handler that used to live inline inside chat.js's
// exports.handler. This is a pure relocation -- no logic changed. Every line
// below was verified against the live chat.js source before being moved here.
//
// Plain CommonJS (module.exports), loaded from chat.js with a normal require()
// -- unlike report-writers.mjs, this file has no reason to be an ES module, so
// there is no dynamic-import bridge needed here.
//
// Exports: VT_BOX_IDS, VT_BOX_LABELS, buildVTPlaybookOutputBlock, handleVirtualTeamRoom

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

// Handles the entire room === 'virtualteam' branch that used to live inline in
// chat.js's exports.handler. Same behavior, same early-return shapes, nothing
// changed except where the code lives.
//
// Returns either:
//   { response: {...} }        — caller should return this immediately (early exit,
//                                 same as the inline block's early `return` statements)
//   { systemPrompt: '...' }    — caller continues the normal synchronous path with
//                                 this as the assembled systemPrompt
//
// Params (all passed in explicitly -- this file has no implicit access to chat.js's
// scope, unlike the inline version which could see chat.js's top-level consts/functions
// directly):
//   boxId, messages, context, userName, userId  — from the parsed request body
//   deps: {
//     getPrompt, buildContextString, buildReceiptCloseBlock, csReceiptShouldLoad,
//     corsHeaders, SUPABASE_URL, SUPABASE_SERVICE_KEY
//   }
async function handleVirtualTeamRoom({ boxId, messages, context, userName, userId }, deps) {
  const { getPrompt, buildContextString, buildReceiptCloseBlock, csReceiptShouldLoad, corsHeaders, SUPABASE_URL, SUPABASE_SERVICE_KEY } = deps;

  // Box selection: frontend sends boxId (e.g. "vt-5"). Validate against the allowlist
  // — NEVER load an arbitrary skill_id from client input.
  const requestedBox = (typeof boxId === 'string' && VT_BOX_IDS.includes(boxId)) ? boxId : null;
  if (!requestedBox) {
    return { response: { statusCode: 400, headers: corsHeaders(), body: JSON.stringify({ error: 'virtualteam room requires a valid boxId' }) } };
  }
  const vtPrompt = await getPrompt(requestedBox);
  if (!vtPrompt) return { response: { statusCode: 500, headers: corsHeaders(), body: JSON.stringify({ error: requestedBox + ' prompt not found in Supabase' }) } };
  let systemPrompt = vtPrompt;

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
        response: {
          statusCode: 200, headers: corsHeaders(),
          body: JSON.stringify({
            message: 'Your ' + (VT_BOX_LABELS[requestedBox] || requestedBox) + ' playbook is being built. This usually takes about 30-75 seconds — feel free to check back.',
            reportJobId: createdJob.id,
            hasLogsToday: true
          })
        }
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

  return { systemPrompt };
}

module.exports = {
  VT_BOX_IDS,
  VT_BOX_LABELS,
  buildVTPlaybookOutputBlock,
  handleVirtualTeamRoom
};

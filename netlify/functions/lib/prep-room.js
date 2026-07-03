// netlify/functions/lib/prep-room.js
// Extracted 2026-07-02 as part of the agreed chat.js restructuring plan
// (see project memory: project_chat_js_restructuring_plan.md).
//
// Holds everything specific to room === 'prep': the route detector, the two
// output-override block builders (Weekly Plan / Quarterly), and the full
// handler that used to live inline inside chat.js's exports.handler.
//
// BUG FIX applied during this extraction (2026-07-02): the live code being
// replaced had cs13Prompt, cs14Prompt, refConvStd, refLookBack, refLookFwd,
// refCoachesPov, and logQR declared with `const` INSIDE the
// `else if (prepRoute === 'menu-quarterly-review-prep')` branch of the
// assembly if/else-if chain -- but they were referenced later, in a SEPARATE
// sibling `if (prepRoute === 'menu-quarterly-review-prep' && userId)` block
// (the background-build trigger), where they are not in scope. In real
// JavaScript, that reference throws `ReferenceError: cs13Prompt is not
// defined` the moment a real client says "build my look backward" or "build
// my look forward" with a valid userId -- a production-breaking bug that had
// not yet been triggered by testing (prior live tests did not carry a real
// userId through that exact path). Fixed here by declaring those 7 variables
// in the outer function scope (see `let` block below) so both the assembly
// logic and the trigger logic can see them. No other behavior changed.
//
// Plain CommonJS (module.exports), loaded from chat.js with a normal require()
// -- same as virtual-team-room.js, no ES-module bridge needed.
//
// Exports: detectPrepRoute, buildWeeklyPlanOutputBlock, buildQuarterlyOutputBlock,
// handlePrepRoom

// ── PREP ROOM ROUTING ────────────────────────────────────────────────────────
// Detects the opening message and loads the correct protocol directly.
// Prevents the mid-conversation load hang where chat-c instructs the AI to
// 'load and execute' a downstream protocol — which fails in the portal because
// the AI has no Supabase tool access inside chat.js.
//
// Button phrases (from dashboard.html prefill-btn onclick values):
//   'My weekly check-in.'                     → cs-15 (was tr-2 — tr-2 retired 2026-07-01, see LOG-cs-15)
//   "I'd like to do my quarterly review."      → menu-quarterly-review-prep
//   "I'd like to build my North Star Notebook." → cs-17 (added 2026-07-03, see LOG-cs-17)
//   anything else                              → chat-c (shows A/B menu)
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
  if (text.includes('north star notebook')) {
    return 'cs-17';
  }
  return 'chat-c';
}

// ── REPORT OUTPUT OVERRIDE (2026-07-01) ──────────────────────────────────────
// Appended to CS-15 (Weekly Plan) and CS-13/CS-14 (Quarterly Look Backward/Forward)
// system prompts, same mechanism as buildReceiptCloseBlock (still in chat.js —
// shared across rooms). Neither protocol's own text can be trusted to produce a
// chat.js-parseable marker on its own — CS-15 says "Write to weekly_planning_reports"
// and CS-13/CS-14 say "INSERT to quarterly_reviews (MCP direct write)" as if the AI
// has live Supabase tool access inside this function. It does not. This override
// forces the actual output contract chat.js can act on.
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

// Handles the entire room === 'prep' branch that used to live inline in
// chat.js's exports.handler. Same behavior as the original, EXCEPT for the
// scoping bug fix described in the header comment above.
//
// Returns either:
//   { response: {...} }                        — caller should return this immediately
//   { systemPrompt: '...', prepRoute: '...' }   — caller continues the normal synchronous
//                                                  path; prepRoute is returned because
//                                                  chat.js's outer handler uses it later
//                                                  (receipt-skip logic, response labeling)
//
// Params:
//   messages, context, userName, userId  — from the parsed request body
//   deps: {
//     getPrompt, buildContextString, buildReceiptCloseBlock, csReceiptShouldLoad,
//     corsHeaders, SUPABASE_URL, SUPABASE_SERVICE_KEY
//   }
async function handlePrepRoom({ messages, context, userName, userId }, deps) {
  const { getPrompt, buildContextString, buildReceiptCloseBlock, csReceiptShouldLoad, corsHeaders, SUPABASE_URL, SUPABASE_SERVICE_KEY } = deps;

  // Full chain injection — all REF/LOG documents fetched upfront by chat.js.
  // The AI never makes a mid-conversation Supabase load call. Prevents portal hang.
  const prepRoute = detectPrepRoute(messages);
  let systemPrompt;

  // Fix (2026-07-02): declared here, in the function's outer scope, instead of
  // inside the `else if` branch below — so the quarterly background-build
  // trigger further down can actually see them. See header comment.
  let cs13Prompt, cs14Prompt, refConvStd, refLookBack, refLookFwd, refCoachesPov, logQR;

  if (prepRoute === 'cs-15') {
    // Weekly check-in — fetch base protocol + template (was tr-2, retired 2026-07-01)
    const [cs15Prompt, refWeeklyTemplate] = await Promise.all([
      getPrompt('cs-15'),
      getPrompt('REF-cs-15-weekly-plan-template')
    ]);
    if (!cs15Prompt) return { response: { statusCode: 500, headers: corsHeaders(), body: JSON.stringify({ error: 'cs-15 prompt not found in Supabase' }) } };
    systemPrompt = cs15Prompt;
    if (refWeeklyTemplate) systemPrompt += '\n\n---\n\n## REF — CS-15 WEEKLY PLAN TEMPLATE\n\n[SYSTEM: This document has been loaded into this session by chat.js. The AI does not need to fetch it.]\n\n' + refWeeklyTemplate;
    systemPrompt += buildWeeklyPlanOutputBlock();
  } else if (prepRoute === 'menu-quarterly-review-prep') {
    // Quarterly review — fetch full chain upfront
    let menuPrompt;
    [menuPrompt, cs13Prompt, cs14Prompt, refConvStd, refLookBack, refLookFwd, refCoachesPov, logQR] = await Promise.all([
      getPrompt('menu-quarterly-review-prep'),
      getPrompt('cs-13'),
      getPrompt('cs-14'),
      getPrompt('REF-quarterly-review-conversation-standard'),
      getPrompt('REF-quarterly-review-look-backward'),
      getPrompt('REF-quarterly-review-look-forward'),
      getPrompt('REF-quarterly-review-coaches-pov'),
      getPrompt('LOG-quarterly-review')
    ]);
    if (!menuPrompt) return { response: { statusCode: 500, headers: corsHeaders(), body: JSON.stringify({ error: 'menu-quarterly-review-prep not found in Supabase' }) } };
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
  } else if (prepRoute === 'cs-17') {
    // North Star Notebook (added 2026-07-03, see LOG-cs-17). Conversational
    // phase (Step 0-2, live capture across arcs 1-6) — Step 0 governing REF
    // is loaded upfront per the same full-chain-injection pattern used
    // above, so the AI never needs a mid-conversation Supabase fetch. Step 3
    // (synthesis) is a SEPARATE background-build trigger block below (see
    // "PREP ROOM BACKGROUND BUILD TRIGGER (cs-17 North Star Notebook)"),
    // wired 2026-07-03 once the job-scoping question in LOG-cs-17 /
    // REF-async-report-generation-standard was resolved: ONE report_jobs
    // entry per Notebook, matching the cs-15/cs-13/cs-14 pattern, with the
    // many-Anthropic-calls loop living entirely inside
    // generate-report-background.mts's north_star_notebook branch. No
    // %%NORTH_STAR_NOTEBOOK%% output-override marker is added to this
    // conversational systemPrompt — unlike cs-15/cs-13/cs-14, the synthesis
    // stage does not replay this conversation; it re-derives its own
    // prompts per section directly from north_star_notebook_sections rows.
    const [cs17Prompt, refNotebookConvStd] = await Promise.all([
      getPrompt('cs-17'),
      getPrompt('REF-north-star-notebook-conversation-standard')
    ]);
    if (!cs17Prompt) return { response: { statusCode: 500, headers: corsHeaders(), body: JSON.stringify({ error: 'cs-17 prompt not found in Supabase' }) } };
    systemPrompt = cs17Prompt;
    if (refNotebookConvStd) systemPrompt += '\n\n---\n\n## REF — NORTH STAR NOTEBOOK CONVERSATION STANDARD\n\n[SYSTEM: This document has been loaded into this session by chat.js. The AI does not need to fetch it.]\n\n' + refNotebookConvStd;
  } else {
    // Ambiguous — show A/B menu via chat-c
    const chatCPrompt = await getPrompt('chat-c');
    if (!chatCPrompt) return { response: { statusCode: 500, headers: corsHeaders(), body: JSON.stringify({ error: 'chat-c prompt not found in Supabase' }) } };
    systemPrompt = chatCPrompt;
  }
  if (csReceiptShouldLoad(messages)) {
    const csReceiptPrompt = await getPrompt('cs-receipt');
    if (csReceiptPrompt) {
      const roomLabel = prepRoute === 'cs-15' ? 'Prep Room — Weekly Plan' :
                        prepRoute === 'menu-quarterly-review-prep' ? 'Prep Room — Quarterly Review' :
                        prepRoute === 'cs-17' ? 'Prep Room — North Star Notebook' : 'Prep Room';
      const triggerCtx = prepRoute === 'cs-15' ? 'weekly_plan' :
                         prepRoute === 'menu-quarterly-review-prep' ? 'quarterly_review' :
                         prepRoute === 'cs-17' ? 'north_star_notebook' : 'prep_room';
      // CS-15 and quarterly reviews are their own receipt (see CS-15 Section 7 / CS-13-14
      // "Does NOT hand off to CS-Receipt" logic) — skip the RECEIPT close block for those,
      // matching the protocols' own stated dependency rules. cs-17 Section 6 states it
      // DOES hand off to CS-Receipt at close (Step 5), so it is NOT excluded here.
      if (prepRoute !== 'cs-15' && prepRoute !== 'menu-quarterly-review-prep') {
        systemPrompt += buildReceiptCloseBlock(csReceiptPrompt, { triggerContext: triggerCtx, roomsVisited: roomLabel });
      }
    }
  }

  // ── PREP ROOM BACKGROUND BUILD TRIGGER (cs-15, 2026-07-02) ────────────────
  // Same pattern as the VT background trigger. cs-15 v1.1 added an explicit
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
          response: {
            statusCode: 200, headers: corsHeaders(),
            body: JSON.stringify({
              message: 'Your Weekly Plan is being built. This usually takes about 30-75 seconds — feel free to check back.',
              reportJobId: createdJob.id,
              hasLogsToday: true
            })
          }
        };
      }
      // If job creation failed for any reason, fall through to the normal synchronous
      // path below rather than losing the request entirely.
    }
  }

  // ── PREP ROOM BACKGROUND BUILD TRIGGER (cs-13/cs-14 Quarterly Review, 2026-07-02) ──
  // Same pattern as the cs-15 trigger above. cs-13 v4.1 and cs-14 v4.1 each added an
  // explicit trigger phrase ("Build my Look Backward" / "Build my Look Forward") between
  // their final conversational lock step and Mini-mode 3 Synthesis + Output, for the
  // identical reason cs-15 needed one: that mode transition was confirmed live (via the
  // cs-15 case) to hit Netlify's ~30s sync ceiling, since Synthesis began automatically
  // the instant the prior step closed with no client-side pause to intercept. cs-13 and
  // cs-14 share this exact architecture, so the same fix pattern applies unchanged.
  if (prepRoute === 'menu-quarterly-review-prep' && userId) {
    const lastUserMsgForQRTrigger = [...messages].reverse().find(m => m.role === 'user');
    const qrTriggerText = lastUserMsgForQRTrigger && typeof lastUserMsgForQRTrigger.content === 'string'
      ? lastUserMsgForQRTrigger.content.trim().toLowerCase() : '';
    const isLookBackwardTrigger = qrTriggerText === 'build my look backward';
    const isLookForwardTrigger = qrTriggerText === 'build my look forward';

    if (isLookBackwardTrigger || isLookForwardTrigger) {
      const reviewType = isLookBackwardTrigger ? 'look_backward' : 'look_forward';

      // ── Trimmed system prompt for the background job (2026-07-02) ────────────
      // The conversational systemPrompt (built above, in scope) carries BOTH cs-13
      // and cs-14 plus BOTH their REF docs, because the menu router doesn't know
      // which document the client is doing until they say so. By this point, the
      // trigger phrase has already told us exactly which one -- so the background
      // job only needs to read its own protocol and its own REF doc, not its
      // sibling's. Confirmed live 2026-07-02: this was adding ~20-25K unnecessary
      // input tokens to every quarterly background build (both docs run ~19-23K
      // chars each). REF-quarterly-review-conversation-standard and LOG-quarterly-
      // review still apply to both document types, so those stay either way.
      // menuPrompt (the router document) is deliberately left out here -- its own
      // text says it "steps back entirely" once it routes to CS-13/CS-14, so the
      // background generation call has no use for it.
      let backgroundSystemPrompt = '';
      if (isLookBackwardTrigger) {
        if (cs13Prompt) backgroundSystemPrompt += '\n\n---\n\n## CS-13 — LOOK BACKWARD\n\n[SYSTEM: Loaded by chat.js. No mid-conversation fetch needed.]\n\n' + cs13Prompt;
        if (refConvStd) backgroundSystemPrompt += '\n\n---\n\n## REF — QUARTERLY REVIEW CONVERSATION STANDARD\n\n' + refConvStd;
        if (refLookBack) backgroundSystemPrompt += '\n\n---\n\n## REF — LOOK BACKWARD\n\n' + refLookBack;
      } else {
        if (cs14Prompt) backgroundSystemPrompt += '\n\n---\n\n## CS-14 — LOOK FORWARD\n\n[SYSTEM: Loaded by chat.js. No mid-conversation fetch needed.]\n\n' + cs14Prompt;
        if (refConvStd) backgroundSystemPrompt += '\n\n---\n\n## REF — QUARTERLY REVIEW CONVERSATION STANDARD\n\n' + refConvStd;
        if (refLookFwd) backgroundSystemPrompt += '\n\n---\n\n## REF — LOOK FORWARD\n\n' + refLookFwd;
      }
      if (refCoachesPov) backgroundSystemPrompt += '\n\n---\n\n## REF — COACHES POV\n\n' + refCoachesPov;
      if (logQR) backgroundSystemPrompt += '\n\n---\n\n## LOG — QUARTERLY REVIEW\n\n' + logQR;
      backgroundSystemPrompt += buildQuarterlyOutputBlock(reviewType);

      const jobPayload = {
        systemPrompt: backgroundSystemPrompt,
        messages: [
          { role: 'user', content: '[CONTEXT — DO NOT DISPLAY TO USER]\n' + buildContextString(context) + '\n[END CONTEXT]\n\nUser first name: ' + (userName || 'there') },
          { role: 'assistant', content: 'Understood. I have the full operating picture. Ready.' },
          ...messages.map(m => ({ role: m.role, content: m.content }))
        ],
        reportKind: 'quarterly_review',
        reviewType,
        meta: { clientName: userName || 'Client' }
      };

      const createRes = await fetch(`${SUPABASE_URL}/rest/v1/report_jobs`, {
        method: 'POST',
        headers: {
          'apikey': SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
          'Content-Type': 'application/json', 'Prefer': 'return=representation'
        },
        body: JSON.stringify({ user_id: userId, box_id: reviewType, room: 'prep', request_payload: jobPayload })
      });
      const createdQRJob = (await createRes.json())?.[0];

      if (createdQRJob && createdQRJob.id) {
        try {
          const invokeRes = await fetch(`${process.env.URL || 'https://sprightly-starburst-210796.netlify.app'}/generate-report-background`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jobId: createdQRJob.id })
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
              message: (isLookBackwardTrigger ? 'Your Look Backward report is being built.' : 'Your Look Forward report is being built.') + ' This usually takes about 30-90 seconds — feel free to check back.',
              reportJobId: createdQRJob.id,
              hasLogsToday: true
            })
          }
        };
      }
      // If job creation failed for any reason, fall through to the normal synchronous
      // path below rather than losing the request entirely.
    }
  }

  // ── PREP ROOM BACKGROUND BUILD TRIGGER (cs-17 North Star Notebook, 2026-07-03) ──
  // Same pattern as the cs-15 / cs-13-cs-14 triggers above, with one structural
  // difference: this job's request_payload carries notebookId + sections DATA
  // instead of a systemPrompt/messages pair, because generate-report-
  // background.mts's north_star_notebook branch constructs its OWN prompts
  // per section/page internally (per REF-north-star-notebook-synthesis-
  // templates) rather than replaying this chat conversation. Per cs-17's own
  // protocol text, synthesis "fires only when all six arcs are confirmed
  // closed" — the trigger phrase below is the explicit client-facing signal
  // for that, matching the exact "build my ___" pattern cs-15/cs-13/cs-14 use.
  //
  // Job-scoping decision (2026-07-03, resolving the open item in LOG-cs-17 /
  // REF-async-report-generation-standard): ONE report_jobs entry for the
  // whole Notebook synthesis stage, not split into multiple tracked jobs —
  // matches the existing single-job-per-report pattern above. Each section's
  // scribed_output/analysis_output/measurable_goal is still written to
  // north_star_notebook_sections incrementally, inside the background
  // function, as each section's call succeeds — so nothing generated is lost
  // even on a mid-job failure, though the client-facing signal is still a
  // single done/error outcome per the html template's own "never render
  // partially complete" rule.
  if (prepRoute === 'cs-17' && userId) {
    const lastUserMsgForNotebookTrigger = [...messages].reverse().find(m => m.role === 'user');
    const isNotebookRealTrigger = lastUserMsgForNotebookTrigger &&
      typeof lastUserMsgForNotebookTrigger.content === 'string' &&
      lastUserMsgForNotebookTrigger.content.trim().toLowerCase() === 'build my north star notebook';

    if (isNotebookRealTrigger) {
      // Look up the notebook row for this user — most recent 'in_progress'
      // notebook, since a user could theoretically have a prior 'complete'
      // notebook from an earlier year still in the table.
      const notebookRes = await fetch(
        `${SUPABASE_URL}/rest/v1/north_star_notebooks?user_id=eq.${userId}&status=eq.in_progress&select=id,year&order=created_at.desc&limit=1`,
        { headers: { 'apikey': SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}` } }
      );
      const notebookRow = (await notebookRes.json())?.[0];

      if (!notebookRow || !notebookRow.id) {
        return {
          response: {
            statusCode: 200, headers: corsHeaders(),
            body: JSON.stringify({
              message: "I couldn't find an in-progress North Star Notebook for you yet — let's make sure all six arcs are captured first.",
              hasLogsToday: true
            })
          }
        };
      }

      const notebookId = notebookRow.id;

      // Pull every captured section for this notebook — section_key, arc_name,
      // and everything captured live during arcs 1-6 (raw_response,
      // gold_silver_bronze, emotion, intensity, reason, goal_confirmed). This
      // is the INPUT data the background function's per-section Anthropic
      // calls need; scribed_output/analysis_output/measurable_goal are NOT
      // selected here because they don't exist yet — they are what synthesis
      // is about to produce.
      const sectionsRes = await fetch(
        `${SUPABASE_URL}/rest/v1/north_star_notebook_sections?notebook_id=eq.${notebookId}&select=section_key,arc_name,raw_response,gold_silver_bronze,emotion,intensity,reason,goal_confirmed&order=section_key.asc`,
        { headers: { 'apikey': SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}` } }
      );
      const allSections = await sectionsRes.json();

      const unconfirmed = (allSections || []).filter(s => !s.goal_confirmed);
      if (!allSections || allSections.length === 0 || unconfirmed.length > 0) {
        return {
          response: {
            statusCode: 200, headers: corsHeaders(),
            body: JSON.stringify({
              message: unconfirmed.length > 0
                ? `A few sections still need to be confirmed before I can build the Notebook (${unconfirmed.map(s => s.section_key).join(', ')}). Let's finish those first.`
                : "I couldn't find any captured sections for this Notebook yet — let's make sure all six arcs are captured first.",
              hasLogsToday: true
            })
          }
        };
      }

      const sections = allSections.map(s => ({
        section_key: s.section_key,
        arc_name: s.arc_name,
        raw_response: s.raw_response,
        gold_silver_bronze: s.gold_silver_bronze,
        emotion: s.emotion,
        intensity: s.intensity,
        reason: s.reason
      }));

      // NOTE: company_name has no confirmed column on `profiles` (checked
      // 2026-07-03 — profiles has display_name, user_name, email, is_test,
      // environment, created_at, tier, user_id; no company field). Defaults
      // to '' here, matching REF-north-star-notebook-html-template's own
      // slot table which lists company_name as sourced from "context /
      // profiles" — that REF's slot documentation is itself ahead of the
      // actual schema and should be corrected in a future pass; not fixed
      // here since it's a REF-document accuracy issue, not a code bug.
      const jobPayload = {
        notebookId,
        userId,
        sections,
        meta: {
          clientName: userName || 'Client',
          companyName: '',
          notebookYear: notebookRow.year
        }
      };

      const createRes = await fetch(`${SUPABASE_URL}/rest/v1/report_jobs`, {
        method: 'POST',
        headers: {
          'apikey': SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
          'Content-Type': 'application/json', 'Prefer': 'return=representation'
        },
        body: JSON.stringify({
          user_id: userId,
          box_id: 'north_star_notebook',
          room: 'prep',
          request_payload: { ...jobPayload, reportKind: 'north_star_notebook' }
        })
      });
      const createdNotebookJob = (await createRes.json())?.[0];

      if (createdNotebookJob && createdNotebookJob.id) {
        try {
          const invokeRes = await fetch(`${process.env.URL || 'https://sprightly-starburst-210796.netlify.app'}/generate-report-background`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jobId: createdNotebookJob.id })
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
              message: 'Your North Star Notebook is being built. This is a long one — it usually takes several minutes. Feel free to check back.',
              reportJobId: createdNotebookJob.id,
              hasLogsToday: true
            })
          }
        };
      }
      // If job creation failed for any reason, fall through to the normal
      // synchronous path below rather than losing the request entirely.
    }
  }

  return { systemPrompt, prepRoute };
}

module.exports = {
  detectPrepRoute,
  buildWeeklyPlanOutputBlock,
  buildQuarterlyOutputBlock,
  handlePrepRoom
};

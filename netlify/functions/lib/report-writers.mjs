// netlify/functions/lib/report-writers.mjs
// Extracted 2026-07-02 as part of the agreed chat.js restructuring plan
// (see project memory: project_chat_js_restructuring_plan.md).
//
// ONE shared file (plain ES module JavaScript -- .mjs, no TypeScript syntax),
// used by BOTH chat.js and generate-report-background.mts. This replaces the
// prior state where these 7 functions were duplicated by hand across both large
// files, which had a real, flagged maintenance cost: any change had to be made
// twice or the two files would silently drift apart.
//
// Two different module systems consume this one file:
//   - generate-report-background.mts (TypeScript, ES modules) uses a normal
//     static `import { ... } from "./lib/report-writers.mjs"`.
//   - chat.js (CommonJS, require()) cannot `require()` an ES module file --
//     Node does not support that. It instead uses a dynamic `import()` inside
//     its async handler, which IS supported from CommonJS code. This is a
//     standard, documented Node.js/Netlify pattern, not a workaround.
// Netlify's own stated long-term direction is "everything ES modules" --
// converting chat.js itself to .mjs later would let the dynamic-import step
// in chat.js be replaced with a normal static import, matching this file.
//
// Exports: getPrompt, extractWeeklyPlan, writeWeeklyPlan, extractQuarterly,
// writeQuarterlyReview, extractVTPlaybook, wrapVTPlaybookInTemplate

const SUPABASE_URL = 'https://omjsqianefykbebnrdmp.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

export async function getPrompt(skillId) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/system_prompts?protocol_id=eq.${skillId}&active=eq.true&select=system_prompt&limit=1`, {
    headers: { 'apikey': SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}` }
  });
  const data = await res.json();
  return data?.[0]?.system_prompt || null;
}

export function extractWeeklyPlan(text) {
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

export async function writeWeeklyPlan(reportData, userId, clientName) {
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

export function extractQuarterly(text) {
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

export function extractVTPlaybook(text) {
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

export async function writeQuarterlyReview(reviewData, userId, clientName) {
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
    const patchBody  = {};
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
        // user_name is NOT NULL with no default (confirmed live 2026-07-02 via schema check,
        // same class of gap fixed in writeWeeklyPlan earlier this session).
        patchBody.user_name = clientName || 'Client';
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

export async function wrapVTPlaybookInTemplate(contentHtml, title, meta) {
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

  const footerLine = '<p><em>' + clientName + ' | ' + firmName + ' | ' + dateStr + '</em></p>';
  return '<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="UTF-8">\n' + styleBlock +
    '\n</head>\n<body>\n' + footerLine + '\n<h1>' + displayTitle + '</h1>\n<hr>\n' +
    contentHtml + '\n<hr>\n' + footerLine + '\n</body>\n</html>';
}

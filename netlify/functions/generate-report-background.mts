// netlify/functions/generate-report-background.mts
// Phase 3 (Option 2) proof-of-concept — 2026-07-02
// Background Function: runs up to 15 minutes (Netlify limit), no 30s sync ceiling.
// Scoped to vt-6 ONLY for this first proof — see report_jobs table + chat.js hook.
//
// Flow: chat.js creates a report_jobs row (status='pending') and invokes this function
// with the job id. This function does the real Anthropic call (same system prompt logic
// as the synchronous path), extracts + wraps the playbook exactly like the existing
// wrapVTPlaybookInTemplate()/extractVTPlaybook() do today, and writes the finished HTML
// back into report_jobs (status='done'). The frontend polls report_jobs by id.
//
// Reuses the EXACT same getPrompt / wrapVTPlaybookInTemplate / extractVTPlaybook logic
// as chat.js, duplicated here because background functions are separate deploy units —
// NOT reimplemented from scratch. If chat.js's versions change, this file must be updated
// to match (flagged as a real maintenance cost of this approach in the report-back).

import type { Config } from "@netlify/functions";

const SUPABASE_URL = 'https://omjsqianefykbebnrdmp.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = 'claude-sonnet-4-6';

async function getPrompt(skillId: string) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/system_prompts?protocol_id=eq.${skillId}&active=eq.true&select=system_prompt&limit=1`, {
    headers: { 'apikey': SUPABASE_SERVICE_KEY as string, 'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}` }
  });
  const data = await res.json();
  return data?.[0]?.system_prompt || null;
}

function buildVTPlaybookOutputBlock(boxLabel: string) {
  // Identical to chat.js's buildVTPlaybookOutputBlock() — kept in sync manually.
  return '\n\n---\n\n## CUSTOM BUILD OUTPUT OVERRIDE — REQUIRED (VIRTUAL TEAM PLAYBOOK CONTENT)\n\n' +
    'You are running inside the custom portal (sprightly-starburst-210796.netlify.app). Ignore any instruction above ' +
    'that says to "deliver the playbook as a response in the chat thread so it renders" or that describes rendering ' +
    'a full styled HTML document yourself — in THIS environment, the system applies the master design standard\'s styling ' +
    'MECHANICALLY, after you respond. You do NOT generate <style>, <html>, <head>, or <body> tags, and you do NOT need ' +
    'to reproduce the design standard\'s CSS or header/footer lines. Your ONLY job is the CONTENT: the section headings, ' +
    'body text, tables, lists, and blockquotes for this playbook, using plain semantic HTML tags (<h2>, <h3>, <h4>, <p>, ' +
    '<table>, <ul>, <ol>, <blockquote>) with NO styling attributes and NO wrapper document.\n\n' +
    'Once the playbook content is fully written, do this: first output one short line confirming the playbook is ready ' +
    '(e.g. "Your ' + boxLabel + ' playbook is ready below."), then append this block after that line:\n\n' +
    '%%VT_PLAYBOOK%%\nTITLE: [use this box\'s exact title format]\n' +
    '[the playbook CONTENT ONLY — semantic HTML, no style/html/head/body tags, no header/footer line]\n%%END_VT_PLAYBOOK%%\n\n' +
    'RULES:\n- Do NOT paste or repeat the playbook content anywhere outside this block.\n' +
    '- The content inside the block must be complete and unabridged — do not summarize, truncate, or cut it short.\n' +
    '- If this block is missing or malformed, the playbook will not display for the client at all.';
}

// ── WEEKLY PLAN (cs-15, 2026-07-02) ────────────────────────────────────────
// Mirrors chat.js's extractWeeklyPlan()/writeWeeklyPlan() exactly, kept in sync manually
// (same real maintenance cost flagged at the top of this file for the VT functions).
function extractWeeklyPlan(text: string) {
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

async function writeWeeklyPlan(reportData: any, userId: string, clientName: string) {
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
      'apikey': SUPABASE_SERVICE_KEY as string,
      'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=representation'
    },
    body: JSON.stringify(payload)
  });
  if (!res.ok) throw new Error('weekly_planning_reports INSERT failed: ' + await res.text());
  return await res.json();
}

function extractVTPlaybook(text: string) {
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

async function wrapVTPlaybookInTemplate(contentHtml: string, title: string | null, meta: any) {
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

async function updateJob(jobId: string, fields: Record<string, any>) {
  await fetch(`${SUPABASE_URL}/rest/v1/report_jobs?id=eq.${jobId}`, {
    method: 'PATCH',
    headers: {
      'apikey': SUPABASE_SERVICE_KEY as string,
      'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=minimal'
    },
    body: JSON.stringify({ ...fields, updated_at: new Date().toISOString() })
  });
}

export default async (req: Request) => {
  const { jobId } = await req.json();
  if (!jobId) return; // background functions don't return responses to the client

  try {
    // Fetch the job row to get the stored request payload (system prompt + messages).
    const jobRes = await fetch(`${SUPABASE_URL}/rest/v1/report_jobs?id=eq.${jobId}&select=*&limit=1`, {
      headers: { 'apikey': SUPABASE_SERVICE_KEY as string, 'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}` }
    });
    const jobRows = await jobRes.json();
    const job = jobRows?.[0];
    if (!job) { console.error('generate-report-background: job not found', jobId); return; }

    // Idempotency guard against Netlify's automatic retry-on-failure (1min, then 2min later) —
    // if this job already moved past 'pending', another invocation is already handling it
    // (or already finished). Do not double-generate.
    if (job.status !== 'pending') {
      console.log('generate-report-background: job', jobId, 'already', job.status, '— skipping duplicate invocation');
      return;
    }

    await updateJob(jobId, { status: 'processing' });

    const { systemPrompt, messages, boxLabel, meta, reportKind } = job.request_payload;

    const t0 = Date.now();
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': ANTHROPIC_API_KEY as string, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: MODEL,
        // max_tokens raised 4096 -> 8192 (2026-07-02): confirmed live that a real Weekly
        // Plan build (cs-15) hit the 4096 cap mid-generation (output_tokens: 4096 exactly,
        // %%WEEKLY_PLAN%% JSON truncated before its closing marker, raw length 12,922 chars).
        // Weekly Plan's report is JSON-wrapped HTML (full_report field) which is naturally
        // larger than a VT playbook's plain HTML block -- 8192 gives real headroom above the
        // one measured real-world case without guessing at an arbitrary multiple.
        max_tokens: 8192,
        system: systemPrompt,
        messages
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      await updateJob(jobId, { status: 'error', error_message: 'Anthropic API error: ' + errText.slice(0, 500) });
      return;
    }

    const data = await response.json();
    const elapsedMs = Date.now() - t0;
    const message = data.content?.[0]?.text || '';
    const inputTokens = data.usage?.input_tokens ?? null;
    const outputTokens = data.usage?.output_tokens ?? null;
    console.log('generate-report-background: job', jobId, 'AI generation took', elapsedMs, 'ms, input_tokens', inputTokens, 'output_tokens', outputTokens);

    // ── Branch by report kind (2026-07-02) ──────────────────────────────────
    // reportKind is absent on VT jobs created before this field existed — default
    // to the original vt_playbook behavior for backward compatibility.
    if (reportKind === 'weekly_plan') {
      const weeklyPlanData = extractWeeklyPlan(message);
      if (!weeklyPlanData) {
        await updateJob(jobId, { status: 'error', error_message: 'No %%WEEKLY_PLAN%% block found or JSON parse failed. Raw length: ' + message.length, input_tokens: inputTokens, output_tokens: outputTokens, generation_ms: elapsedMs });
        return;
      }
      try {
        await writeWeeklyPlan(weeklyPlanData, job.user_id, meta?.clientName);
      } catch (writeErr) {
        await updateJob(jobId, { status: 'error', error_message: 'weekly_planning_reports write failed: ' + String(writeErr).slice(0, 400), input_tokens: inputTokens, output_tokens: outputTokens, generation_ms: elapsedMs });
        return;
      }
      await updateJob(jobId, {
        status: 'done',
        result_html: weeklyPlanData.full_report || null,
        result_title: 'Weekly Plan — Week ' + (weeklyPlanData.week_number ?? '?'),
        completed_at: new Date().toISOString(),
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        generation_ms: elapsedMs
      });
      return;
    }

    const extracted = extractVTPlaybook(message);
    if (!extracted) {
      await updateJob(jobId, { status: 'error', error_message: 'No %%VT_PLAYBOOK%% block found in model output. Raw length: ' + message.length, input_tokens: inputTokens, output_tokens: outputTokens, generation_ms: elapsedMs });
      return;
    }

    const wrappedHtml = await wrapVTPlaybookInTemplate(extracted.html, extracted.title, meta);

    await updateJob(jobId, {
      status: 'done',
      result_html: wrappedHtml,
      result_title: extracted.title,
      completed_at: new Date().toISOString(),
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      generation_ms: elapsedMs
    });

  } catch (err: any) {
    console.error('generate-report-background error:', err);
    await updateJob(jobId, { status: 'error', error_message: String(err).slice(0, 500) });
  }
};

export const config: Config = {
  background: true,
  path: "/generate-report-background"
};

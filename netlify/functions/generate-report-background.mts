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

    const { systemPrompt, messages, boxLabel, meta } = job.request_payload;

    const t0 = Date.now();
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': ANTHROPIC_API_KEY as string, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 4096,
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

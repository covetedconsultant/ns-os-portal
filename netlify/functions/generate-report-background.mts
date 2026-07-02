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
// getPrompt / extractWeeklyPlan / writeWeeklyPlan / extractQuarterly / writeQuarterlyReview /
// extractVTPlaybook / wrapVTPlaybookInTemplate now live in ./lib/report-writers.mjs, the ONE
// shared file also used by chat.js (chat.js loads it via dynamic import() since it's CommonJS
// and can't require() an ES module file; this file uses a normal static import).
// Extracted 2026-07-02 to kill the manual-sync problem flagged in this file's prior header
// comment -- see project memory: project_chat_js_restructuring_plan.md.

import type { Config } from "@netlify/functions";
import {
  getPrompt,
  extractWeeklyPlan,
  writeWeeklyPlan,
  extractQuarterly,
  writeQuarterlyReview,
  extractVTPlaybook,
  wrapVTPlaybookInTemplate
} from "./lib/report-writers.mjs";

const SUPABASE_URL = 'https://omjsqianefykbebnrdmp.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = 'claude-sonnet-4-6';

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

    // max_tokens is report-kind-aware (2026-07-02, revised): originally a flat 4096 for all
    // kinds, raised to 8192 after a real Weekly Plan build hit the 4096 cap mid-generation
    // (output_tokens: 4096 exactly, raw length 12,922 chars). That same flat 8192 was then
    // hit AGAIN by the first real Quarterly Review build (output_tokens: 8192 exactly, raw
    // length 26,131 chars, no closing %%END_QUARTERLY%% marker) -- cs-13/cs-14's client_html
    // report is measurably larger than Weekly Plan's, so a single flat cap across all three
    // kinds keeps getting outgrown by whichever kind is biggest. Sizing per kind instead of
    // guessing one number that has to cover the largest case for everyone.
    const maxTokensByKind: Record<string, number> = {
      quarterly_review: 16384,
      weekly_plan: 8192
    };
    const maxTokens = maxTokensByKind[reportKind] || 8192; // vt_playbook / undefined default

    const t0 = Date.now();
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': ANTHROPIC_API_KEY as string, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: maxTokens,
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

    if (reportKind === 'quarterly_review') {
      const quarterlyData = extractQuarterly(message);
      if (!quarterlyData) {
        await updateJob(jobId, { status: 'error', error_message: 'No %%QUARTERLY%% block found or JSON parse failed. Raw length: ' + message.length, input_tokens: inputTokens, output_tokens: outputTokens, generation_ms: elapsedMs });
        return;
      }
      try {
        await writeQuarterlyReview(quarterlyData, job.user_id, meta?.clientName);
      } catch (writeErr) {
        await updateJob(jobId, { status: 'error', error_message: 'quarterly_reviews write failed: ' + String(writeErr).slice(0, 400), input_tokens: inputTokens, output_tokens: outputTokens, generation_ms: elapsedMs });
        return;
      }
      const reviewTypeLabel = quarterlyData.type === 'look_forward' ? 'Look Forward' : 'Look Backward';
      await updateJob(jobId, {
        status: 'done',
        result_html: quarterlyData.client_html || null,
        result_title: reviewTypeLabel + ' — ' + (quarterlyData.quarter ?? ''),
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

    // ── Stage 1: Red → Yellow transition to playbook_sessions ─────────────────
    // When a VT playbook build completes successfully, mark that box as yellow
    // (playbook exists). A failed write here is logged but does NOT fail the job —
    // the user gets their playbook regardless. Green promotion is handled separately
    // by cs-15 (Weekly Plan, Stage 2).
    try {
      const psBoxId = job.box_id; // e.g. 'vt-4a'
      const psBoxNumber = 'box_' + (psBoxId.match(/\d+/)?.[0] ?? ''); // 'box_4'
      const psBoxName = (boxLabel || '').replace(/^Box \d+ /, ''); // 'Converse Leader'
      const psUserName = meta?.clientName || 'Client';
      const psDate = new Date().toISOString().slice(0, 10);

      // Check if a row already exists for this user + box
      const psCheckRes = await fetch(
        `${SUPABASE_URL}/rest/v1/playbook_sessions?user_id=eq.${job.user_id}&box_number=eq.${encodeURIComponent(psBoxNumber)}&select=id,status&limit=1`,
        { headers: { 'apikey': SUPABASE_SERVICE_KEY as string, 'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}` } }
      );
      const psRows = await psCheckRes.json();
      const psExisting = psRows?.[0];

      if (psExisting) {
        // Row exists — only update if not already green (never downgrade)
        if (psExisting.status !== 'green') {
          await fetch(`${SUPABASE_URL}/rest/v1/playbook_sessions?id=eq.${psExisting.id}`, {
            method: 'PATCH',
            headers: {
              'apikey': SUPABASE_SERVICE_KEY as string,
              'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
              'Content-Type': 'application/json',
              'Prefer': 'return=minimal'
            },
            body: JSON.stringify({ status: 'yellow', session_date: psDate, updated_at: new Date().toISOString() })
          });
          console.log('generate-report-background: playbook_sessions updated to yellow for', job.user_id, psBoxNumber);
        } else {
          console.log('generate-report-background: playbook_sessions already green for', job.user_id, psBoxNumber, '— not downgrading');
        }
      } else {
        // No row — insert new (first playbook build for this box)
        await fetch(`${SUPABASE_URL}/rest/v1/playbook_sessions`, {
          method: 'POST',
          headers: {
            'apikey': SUPABASE_SERVICE_KEY as string,
            'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
            'Content-Type': 'application/json',
            'Prefer': 'return=minimal'
          },
          body: JSON.stringify({
            user_id: job.user_id,
            user_name: psUserName,
            box_number: psBoxNumber,
            box_name: psBoxName,
            status: 'yellow',
            session_date: psDate,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
          })
        });
        console.log('generate-report-background: playbook_sessions inserted yellow for', job.user_id, psBoxNumber);
      }
    } catch (psErr) {
      console.error('generate-report-background: playbook_sessions write failed (non-fatal):', psErr);
    }

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

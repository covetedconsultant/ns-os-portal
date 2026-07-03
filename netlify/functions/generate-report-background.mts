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
//
// NORTH STAR NOTEBOOK (cs-17) branch added 2026-07-03 — see below. This is the ONLY
// structural change to this file: the existing single-shared-Anthropic-call-then-branch
// flow for weekly_plan / quarterly_review / vt_playbook is preserved EXACTLY as it was
// (relocation discipline, not a rewrite — see ref-chat-js-architecture Section 1). The
// Notebook branch is inserted as an early, self-contained return BEFORE that shared call,
// since the Notebook does not use the shared single-call pattern at all — it makes its own
// many sequential calls internally and never touches the existing flow below it.

import type { Config } from "@netlify/functions";
import {
  getPrompt,
  extractWeeklyPlan,
  writeWeeklyPlan,
  extractQuarterly,
  writeQuarterlyReview,
  extractVTPlaybook,
  wrapVTPlaybookInTemplate,
  extractNotebookSection,
  writeNotebookSection,
  writeNotebookSynthesis,
  renderNotebookHtml,
  writeNotebookComplete
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

// Single Anthropic call helper used ONLY by the new north_star_notebook branch
// below (looped many times). The existing single-call flow further down in
// this file is left exactly as it was — untouched, not routed through this
// helper — per the "preserve behavior, relocate don't rewrite" discipline.
async function callAnthropicForNotebook(systemPrompt: string, messages: any[], maxTokens: number) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': ANTHROPIC_API_KEY as string, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: maxTokens,
      system: systemPrompt,
      messages
    })
  });
  if (!res.ok) throw new Error('Anthropic API error: ' + (await res.text()).slice(0, 500));
  return res.json();
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

    // ─────────────────────────────────────────────────────────────────────────
    // NORTH STAR NOTEBOOK (cs-17 synthesis stage) — added 2026-07-03
    // ─────────────────────────────────────────────────────────────────────────
    // Inserted here, BEFORE the shared single-Anthropic-call flow below, because
    // the Notebook does not use that shared pattern at all — this branch makes
    // its own ~20-27 sequential Anthropic calls internally and returns on its
    // own, never falling through to the code beneath it. Everything from the
    // "max_tokens is report-kind-aware" comment onward, to the end of this
    // function, is UNCHANGED from the live file prior to this addition.
    //
    // ONE report_jobs entry per Notebook (job-scoping decision confirmed
    // 2026-07-03, resolving the open item in LOG-cs-17 / REF-async-report-
    // generation-standard — matches the single-job-per-report pattern used by
    // weekly_plan/quarterly_review/vt_playbook below). Fail-fast, no partial
    // completion: if ANY call or write fails, the job is marked 'error'
    // immediately naming which step failed, and no further calls are
    // attempted — consistent with REF-north-star-notebook-html-template's own
    // "never render partially complete" rule. This governs the report_jobs
    // done/error signal shown to the CLIENT only. Underneath, each section's
    // scribed_output/analysis_output/measurable_goal is written to
    // north_star_notebook_sections immediately after that section's call
    // succeeds — so if the job dies partway through, everything generated up
    // to that point is already persisted and does not need to be regenerated
    // by a human inspecting the DB later, even though the client-facing retry
    // will redo the AI calls from the top.
    if (reportKind === 'north_star_notebook') {
      const t0 = Date.now();
      const maxTokensSection = 2048; // per-section calls are short: 2-4 sentence scribe pass + short analysis
      const maxTokensPage = 4096;    // Vision/Closing Pattern/Growth-Evolution pages are longer, full-page narrative content

      const { notebookId, sections, meta: notebookMeta } = job.request_payload as {
        notebookId: string;
        sections: Array<{
          section_key: string;
          arc_name: string;
          raw_response: string;
          gold_silver_bronze: string;
          emotion: string;
          intensity: string;
          reason: string;
        }>;
        meta: { clientName?: string; companyName?: string; notebookYear?: number | string };
      };

      let totalInputTokens = 0;
      let totalOutputTokens = 0;
      const sectionResultsByKey: Record<string, any> = {};

      // ── Step 1: one combined scribe+analysis call per confirmed section ─────
      for (const section of sections) {
        const sectionPrompt =
          'You are generating the North Star Notebook synthesis content for ONE section, ' +
          'per REF-north-star-notebook-synthesis-templates Section 1 (the two-pass Scribe + ' +
          'Chief of Staff Analysis pattern, combined here into one call per section).\n\n' +
          'Section: ' + section.section_key + ' (Arc: ' + section.arc_name + ')\n' +
          'Gold/Silver/Bronze: ' + section.gold_silver_bronze + '\n' +
          'Emotion: ' + section.emotion + ' (Intensity: ' + section.intensity + ')\n' +
          'Reason: ' + section.reason + '\n' +
          'Raw captured response: ' + section.raw_response + '\n\n' +
          'Produce BOTH passes for this section:\n' +
          'Pass 1 (Scribe) — first person, 2-4 sentences, preserve every specific detail, no coaching or goal.\n' +
          'Pass 2 (Chief of Staff Analysis) — open with the section\'s core principle if one applies, honor what ' +
          'they declared, name the tension or opportunity from their specific details, propose ONE measurable ' +
          'goal stated as a PROPOSAL awaiting confirmation (never as already locked).\n\n' +
          'Output ONLY the following marker block, nothing else outside it:\n\n' +
          '%%NOTEBOOK_SECTION%%{"scribed_output":"[Pass 1 text, escaped for JSON]",' +
          '"analysis_output":"[Pass 2 text, escaped for JSON]","measurable_goal":"[proposed goal or null]"}%%END_NOTEBOOK_SECTION%%';

        let data;
        try {
          data = await callAnthropicForNotebook(sectionPrompt, [{ role: 'user', content: 'Generate this section now.' }], maxTokensSection);
        } catch (err) {
          await updateJob(jobId, { status: 'error', error_message: 'Section ' + section.section_key + ' Anthropic call failed: ' + String(err).slice(0, 400), input_tokens: totalInputTokens, output_tokens: totalOutputTokens, generation_ms: Date.now() - t0 });
          return;
        }
        totalInputTokens += data.usage?.input_tokens ?? 0;
        totalOutputTokens += data.usage?.output_tokens ?? 0;
        const message = data.content?.[0]?.text || '';

        const sectionData = extractNotebookSection(message);
        if (!sectionData) {
          await updateJob(jobId, { status: 'error', error_message: 'Section ' + section.section_key + ' failed to parse %%NOTEBOOK_SECTION%% block. Raw length: ' + message.length, input_tokens: totalInputTokens, output_tokens: totalOutputTokens, generation_ms: Date.now() - t0 });
          return;
        }

        try {
          await writeNotebookSection(sectionData, notebookId, section.section_key);
        } catch (writeErr) {
          await updateJob(jobId, { status: 'error', error_message: 'Section ' + section.section_key + ' write failed: ' + String(writeErr).slice(0, 400), input_tokens: totalInputTokens, output_tokens: totalOutputTokens, generation_ms: Date.now() - t0 });
          return;
        }

        sectionResultsByKey[section.section_key] = {
          arc_name: section.arc_name,
          section_key: section.section_key,
          gold_silver_bronze: section.gold_silver_bronze,
          emotion: section.emotion,
          intensity: section.intensity,
          reason: section.reason,
          scribed_output: sectionData.scribed_output,
          analysis_output: sectionData.analysis_output,
          measurable_goal: sectionData.measurable_goal ?? null
        };
      }

      // ── Step 2: Vision page (1 call) ─────────────────────────────────────────
      const visionPrompt =
        'You are generating the Vision page for a North Star Notebook, per ' +
        'REF-north-star-notebook-synthesis-templates Section 2. Inputs: the Section 4B case study, ' +
        'Section 6A defining moment, all five Freedoms (3A-3E), and the Section 2 revenue number, ' +
        'drawn from the confirmed sections below. Follow the five-part structure exactly: ' +
        '(1) Picture this, (2) Everyone knows what to do, (3) Why it works, (4) The math is manageable, ' +
        '(5) The result.\n\n' + JSON.stringify(Object.values(sectionResultsByKey)) +
        '\n\nOutput ONLY: %%NOTEBOOK_SECTION%%{"scribed_output":"[Vision page text, escaped for JSON]",' +
        '"analysis_output":null,"measurable_goal":null}%%END_NOTEBOOK_SECTION%%';

      let visionData;
      try {
        const data = await callAnthropicForNotebook(visionPrompt, [{ role: 'user', content: 'Generate the Vision page now.' }], maxTokensPage);
        totalInputTokens += data.usage?.input_tokens ?? 0;
        totalOutputTokens += data.usage?.output_tokens ?? 0;
        const message = data.content?.[0]?.text || '';
        visionData = extractNotebookSection(message);
        if (!visionData) throw new Error('Failed to parse %%NOTEBOOK_SECTION%% block. Raw length: ' + message.length);
      } catch (err) {
        await updateJob(jobId, { status: 'error', error_message: 'Vision page failed: ' + String(err).slice(0, 400), input_tokens: totalInputTokens, output_tokens: totalOutputTokens, generation_ms: Date.now() - t0 });
        return;
      }

      // ── Step 3: Closing Pattern page (1 call) ────────────────────────────────
      const closingPrompt =
        'You are generating the Closing Pattern page for a North Star Notebook, per ' +
        'REF-north-star-notebook-synthesis-templates Section 3. Scan the confirmed measurable_goal ' +
        'fields below for repeated verbs, domains, or tensions — a structured scan, not a prose re-read. ' +
        'The named limiting belief (Section 7, if present among these sections) must explicitly inform ' +
        'the central pattern — never optional.\n\n' + JSON.stringify(Object.values(sectionResultsByKey)) +
        '\n\nOutput ONLY: %%NOTEBOOK_SECTION%%{"scribed_output":"[Closing Pattern page text, escaped for JSON]",' +
        '"analysis_output":null,"measurable_goal":null}%%END_NOTEBOOK_SECTION%%';

      let closingData;
      try {
        const data = await callAnthropicForNotebook(closingPrompt, [{ role: 'user', content: 'Generate the Closing Pattern page now.' }], maxTokensPage);
        totalInputTokens += data.usage?.input_tokens ?? 0;
        totalOutputTokens += data.usage?.output_tokens ?? 0;
        const message = data.content?.[0]?.text || '';
        closingData = extractNotebookSection(message);
        if (!closingData) throw new Error('Failed to parse %%NOTEBOOK_SECTION%% block. Raw length: ' + message.length);
      } catch (err) {
        await updateJob(jobId, { status: 'error', error_message: 'Closing Pattern page failed: ' + String(err).slice(0, 400), input_tokens: totalInputTokens, output_tokens: totalOutputTokens, generation_ms: Date.now() - t0 });
        return;
      }

      // ── Step 4: Growth/Evolution projections — up to 5 calls, one per Freedom (3A-3E) ──
      // Per REF-north-star-notebook-synthesis-templates Section 4: classify each Freedom's
      // confirmed Year-1 goal as Growth Step Function or Evolution Ladder (client's actual
      // goal always overrides the per-Freedom default lean), then project Year 1/3/5.
      const freedomKeys = ['3A', '3B', '3C', '3D', '3E'];
      const projectionPieces: string[] = [];
      for (const freedomKey of freedomKeys) {
        const relevantSections = Object.values(sectionResultsByKey).filter((s: any) => s.section_key.startsWith(freedomKey));
        if (relevantSections.length === 0) continue; // Freedom not present in this client's captured arcs — skip, do not error

        const projectionPrompt =
          'You are generating the 1/3/5-year Growth/Evolution projection for Freedom ' + freedomKey +
          ' of a North Star Notebook, per REF-north-star-notebook-synthesis-templates Section 4. ' +
          'First classify the confirmed goal as a Growth Step Function (countable) or Evolution Ladder ' +
          '(transformational) — the client\'s actual stated goal always overrides the per-Freedom default ' +
          'lean. State which type and why, briefly, then write 2-3 sentences per horizon (Year 1, Year 3, ' +
          'Year 5), each ending with a measurable goal fitting that horizon.\n\n' +
          JSON.stringify(relevantSections) +
          '\n\nOutput ONLY: %%NOTEBOOK_SECTION%%{"scribed_output":"[Projection text for Freedom ' + freedomKey + ', escaped for JSON]",' +
          '"analysis_output":null,"measurable_goal":null}%%END_NOTEBOOK_SECTION%%';

        try {
          const data = await callAnthropicForNotebook(projectionPrompt, [{ role: 'user', content: 'Generate the ' + freedomKey + ' projection now.' }], maxTokensPage);
          totalInputTokens += data.usage?.input_tokens ?? 0;
          totalOutputTokens += data.usage?.output_tokens ?? 0;
          const message = data.content?.[0]?.text || '';
          const projData = extractNotebookSection(message);
          if (!projData) throw new Error('Failed to parse %%NOTEBOOK_SECTION%% block. Raw length: ' + message.length);
          projectionPieces.push(projData.scribed_output);
        } catch (err) {
          await updateJob(jobId, { status: 'error', error_message: 'Growth/Evolution projection for Freedom ' + freedomKey + ' failed: ' + String(err).slice(0, 400), input_tokens: totalInputTokens, output_tokens: totalOutputTokens, generation_ms: Date.now() - t0 });
          return;
        }
      }
      const projectionsHtml = projectionPieces.join('\n');

      // ── Step 5: persist synthesis, render, mark complete ─────────────────────
      try {
        await writeNotebookSynthesis({
          vision_page: visionData.scribed_output,
          closing_pattern_page: closingData.scribed_output,
          projections_html: projectionsHtml
        }, notebookId);
      } catch (writeErr) {
        await updateJob(jobId, { status: 'error', error_message: 'Notebook synthesis write failed: ' + String(writeErr).slice(0, 400), input_tokens: totalInputTokens, output_tokens: totalOutputTokens, generation_ms: Date.now() - t0 });
        return;
      }

      // Group sections by arc_name, preserving first-seen order, for the
      // template's {{#each arcs}} > {{#each sections}} nesting.
      const arcsInOrder: string[] = [];
      const arcMap: Record<string, any[]> = {};
      for (const section of Object.values(sectionResultsByKey)) {
        const s = section as any;
        if (!arcMap[s.arc_name]) { arcMap[s.arc_name] = []; arcsInOrder.push(s.arc_name); }
        arcMap[s.arc_name].push(s);
      }
      const arcs = arcsInOrder.map(arc_name => ({ arc_name, sections: arcMap[arc_name] }));

      let renderedHtml;
      try {
        renderedHtml = await renderNotebookHtml({
          user_name: notebookMeta?.clientName || 'Client',
          company_name: notebookMeta?.companyName || '',
          notebook_year: notebookMeta?.notebookYear || new Date().getFullYear(),
          vision_html: visionData.scribed_output,
          closing_pattern_html: closingData.scribed_output,
          projections_html: projectionsHtml,
          arcs
        });
      } catch (renderErr) {
        await updateJob(jobId, { status: 'error', error_message: 'Notebook render failed: ' + String(renderErr).slice(0, 400), input_tokens: totalInputTokens, output_tokens: totalOutputTokens, generation_ms: Date.now() - t0 });
        return;
      }

      try {
        await writeNotebookComplete(notebookId, renderedHtml);
      } catch (writeErr) {
        await updateJob(jobId, { status: 'error', error_message: 'Notebook completion write failed: ' + String(writeErr).slice(0, 400), input_tokens: totalInputTokens, output_tokens: totalOutputTokens, generation_ms: Date.now() - t0 });
        return;
      }

      await updateJob(jobId, {
        status: 'done',
        result_html: renderedHtml,
        result_title: 'North Star Notebook — ' + (notebookMeta?.notebookYear || new Date().getFullYear()),
        completed_at: new Date().toISOString(),
        input_tokens: totalInputTokens,
        output_tokens: totalOutputTokens,
        generation_ms: Date.now() - t0
      });
      return;
    }
    // ─────────────────────────────────────────────────────────────────────────
    // END NORTH STAR NOTEBOOK BRANCH. Everything below this point is the
    // ORIGINAL, UNCHANGED live logic for weekly_plan / quarterly_review /
    // vt_playbook, preserved exactly as it was before this addition.
    // ─────────────────────────────────────────────────────────────────────────

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

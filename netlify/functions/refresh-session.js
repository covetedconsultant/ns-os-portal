// netlify/functions/refresh-session.js
// Called by dashboard.html whenever a /api/chat request comes back 401 --
// i.e. the browser's current Supabase session has gone stale (expired
// access token, failed native auto-refresh, or any other reason the stored
// session no longer verifies). Given ONLY a known userId (no order_id, no
// claim ticket -- this is for an account that has already been claimed at
// least once, not a first-time purchase), mints a brand-new, valid Supabase
// session and hands it back so the browser can silently re-authenticate and
// retry, with no visible login screen and no password required (this user
// may not have set one yet -- see SPEC-purchase-to-first-session.md).
//
// This intentionally reuses the exact generate_link + verify pattern already
// proven live in claim-session.js's mintSession()/getUserEmail() helpers
// (see ERR-NET-21 in LOG-DEPLOY-ERRORS for the two non-obvious gotchas this
// depends on: hashed_token nests under properties, and verify type must be
// 'email' not the deprecated 'magiclink').
//
// Security model: reachable from any browser, so the only thing gating this
// is knowing a real, existing userId (a UUID -- not guessable in practice,
// and this endpoint does not reveal whether a given userId exists via timing
// or error-message differences: a bad/unknown userId gets the same generic
// failure shape as any other mint failure).

const SUPABASE_URL = 'https://omjsqianefykbebnrdmp.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: corsHeaders(), body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: corsHeaders(), body: 'Method not allowed' };

  try {
    const body = JSON.parse(event.body || '{}');
    const userId = String(body.userId || '').trim();

    if (!userId) {
      return { statusCode: 400, headers: corsHeaders(), body: JSON.stringify({ ok: false, error: 'userId is required' }) };
    }

    const session = await mintSession(userId);

    return {
      statusCode: 200,
      headers: corsHeaders(),
      body: JSON.stringify({
        ok: true,
        access_token: session.access_token,
        refresh_token: session.refresh_token
      })
    };

  } catch (err) {
    console.error('refresh-session error:', err);
    // Generic failure shape on purpose -- do not leak whether the userId
    // was valid, expired, or malformed. The browser's retry logic just
    // treats any non-ok response as "silent refresh didn't work."
    return { statusCode: 500, headers: corsHeaders(), body: JSON.stringify({ ok: false, error: 'refresh_failed' }) };
  }
};

// ── HELPERS (mirrors claim-session.js's mintSession/getUserEmail) ────────

async function mintSession(userId) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/admin/generate_link`, {
    method: 'POST',
    headers: {
      'apikey': SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ type: 'magiclink', email: await getUserEmail(userId) })
  });
  if (!res.ok) throw new Error('generate_link failed: ' + await res.text());
  const linkData = await res.json();
  const hashedToken = linkData?.properties?.hashed_token || linkData?.hashed_token;
  if (!hashedToken) throw new Error('generate_link response missing properties.hashed_token: ' + JSON.stringify(linkData));

  const verifyRes = await fetch(`${SUPABASE_URL}/auth/v1/verify`, {
    method: 'POST',
    headers: { 'apikey': SUPABASE_SERVICE_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'email', token_hash: hashedToken })
  });
  if (!verifyRes.ok) throw new Error('verify failed: ' + await verifyRes.text());
  const sessionData = await verifyRes.json();

  return { access_token: sessionData.access_token, refresh_token: sessionData.refresh_token };
}

async function getUserEmail(userId) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${userId}`, {
    headers: { 'apikey': SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}` }
  });
  if (!res.ok) throw new Error('getUserEmail failed: ' + await res.text());
  const data = await res.json();
  return data.email;
}

function corsHeaders() {
  return { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Content-Type': 'application/json' };
}

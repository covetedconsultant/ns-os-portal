// netlify/functions/claim-session.js
// Called by the buyer's own browser, from ns-os-welcome, on page load.
// Job: given the email + order_id present in the URL (SamCart's ##email##
// and ##orderid## macros), look up a matching, unexpired, unused login claim
// written by create-client.js, consume it, and return a real Supabase
// session (access_token + refresh_token) the page can use to log the buyer
// in immediately -- no password, no email round-trip. See
// SPEC-purchase-to-first-session.md / DESIGN-create-client-endpoint.md.
//
// Security model: this endpoint is reachable from any browser, so there is
// no shared secret here. Protection comes from the claim itself: a random,
// unguessable token is never exposed -- the caller must instead supply BOTH
// the correct email AND the correct order_id (decided July 1, 2026, stronger
// than email alone), the claim must not be expired, and it can only be
// consumed once.

const SUPABASE_URL = 'https://omjsqianefykbebnrdmp.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: corsHeaders(), body: '' };
  if (event.httpMethod !== 'GET') return { statusCode: 405, headers: corsHeaders(), body: 'Method not allowed' };

  try {
    const params = event.queryStringParameters || {};
    const email = (params.email || '').trim().toLowerCase();
    const orderId = String(params.orderid || params.order_id || '').trim();

    if (!email || !orderId) {
      return { statusCode: 400, headers: corsHeaders(), body: JSON.stringify({ ready: false, error: 'email and orderid are required' }) };
    }

    // ── Look up a matching, unexpired, unclaimed ticket ────────────────────
    const claim = await findClaim(email, orderId);

    if (!claim) {
      // Not ready yet -- create-client.js may still be running (webhook lag),
      // or the claim was already consumed, or email/orderid don't match.
      // The page treats this as "keep waiting" and polls again shortly.
      return { statusCode: 200, headers: corsHeaders(), body: JSON.stringify({ ready: false }) };
    }

    // ── Consume the ticket (single-use) BEFORE minting a session ───────────
    const consumed = await consumeClaim(claim.id);
    if (!consumed) {
      // Lost a race (e.g. double-poll) -- someone else already consumed it.
      return { statusCode: 200, headers: corsHeaders(), body: JSON.stringify({ ready: false }) };
    }

    // ── Mint a real Supabase session for this user ──────────────────────────
    const session = await mintSession(claim.user_id);

    return {
      statusCode: 200,
      headers: corsHeaders(),
      body: JSON.stringify({
        ready: true,
        access_token: session.access_token,
        refresh_token: session.refresh_token,
        user_id: claim.user_id
      })
    };

  } catch (err) {
    console.error('claim-session error:', err);
    return { statusCode: 500, headers: corsHeaders(), body: JSON.stringify({ ready: false, error: err.message }) };
  }
};

// ── HELPERS ──────────────────────────────────────────────────────────────

async function findClaim(email, orderId) {
  const nowIso = new Date().toISOString();
  const url = `${SUPABASE_URL}/rest/v1/login_claims`
    + `?email=eq.${encodeURIComponent(email)}`
    + `&order_id=eq.${encodeURIComponent(orderId)}`
    + `&claimed_at=is.null`
    + `&expires_at=gt.${encodeURIComponent(nowIso)}`
    + `&select=id,user_id&order=created_at.desc&limit=1`;
  const res = await fetch(url, {
    headers: { 'apikey': SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}` }
  });
  if (!res.ok) return null;
  const rows = await res.json();
  return Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
}

async function consumeClaim(claimId) {
  // Only succeeds if claimed_at is still null at the moment of the PATCH --
  // the claimed_at=is.null filter here makes this atomic-enough to prevent
  // a double-claim race from handing out two sessions for one ticket.
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/login_claims?id=eq.${claimId}&claimed_at=is.null`,
    {
      method: 'PATCH',
      headers: {
        'apikey': SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=representation'
      },
      body: JSON.stringify({ claimed_at: new Date().toISOString() })
    }
  );
  if (!res.ok) return false;
  const rows = await res.json();
  return Array.isArray(rows) && rows.length > 0;
}

async function mintSession(userId) {
  // Supabase Admin API pattern (confirmed against Supabase docs, July 2026):
  // admin.generateLink({type:'magiclink'}) returns properties.hashed_token
  // WITHOUT sending any email. Verifying that hashed_token server-side via
  // /auth/v1/verify with type 'email' (NOT 'magiclink' -- that verify type
  // is deprecated) exchanges it for a real access_token/refresh_token pair.
  // The buyer never sees this token or any email -- it's consumed entirely
  // server-side, inside this function.
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
  return { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Content-Type': 'application/json' };
}

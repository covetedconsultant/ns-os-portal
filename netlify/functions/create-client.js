// netlify/functions/create-client.js
// Called by Zapier, server-to-server, the instant a SamCart "New Order" fires.
// Job: create (or find) the Supabase Auth user + profiles row for this buyer,
// then write a short-lived, single-use login claim ticket for the browser to
// redeem via claim-session.js. See SPEC-purchase-to-first-session.md and
// DESIGN-create-client-endpoint.md for the full design and rationale.
//
// Auth: locked to Zapier via a shared secret header (X-Internal-Key), checked
// against config.create_client_shared_secret. This is NOT the Supabase
// service role key -- that never leaves this function's server environment.
//
// ERR-NET-18 (LOG-DEPLOY-ERRORS): newly-created auth.users rows can have NULL
// in several token columns, which crashes login with a misleading "invalid
// password" error. This function runs the COALESCE fix immediately after
// creating any new user, before returning.

const SUPABASE_URL = 'https://omjsqianefykbebnrdmp.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: corsHeaders(), body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: corsHeaders(), body: 'Method not allowed' };

  try {
    // ── AUTH: shared secret, Zapier-only ──────────────────────────────────
    const providedKey = event.headers['x-internal-key'] || event.headers['X-Internal-Key'];
    const expectedKey = await getConfigValue('create_client_shared_secret');
    if (!expectedKey) {
      return { statusCode: 500, headers: corsHeaders(), body: JSON.stringify({ error: 'Shared secret not configured' }) };
    }
    if (!providedKey || providedKey !== expectedKey) {
      return { statusCode: 401, headers: corsHeaders(), body: JSON.stringify({ error: 'Unauthorized' }) };
    }

    const { email, first_name, last_name, order_id } = JSON.parse(event.body);
    if (!email || !order_id) {
      return { statusCode: 400, headers: corsHeaders(), body: JSON.stringify({ error: 'email and order_id are required' }) };
    }
    const normalizedEmail = email.trim().toLowerCase();

    // ── STEP 1: find or create the Supabase Auth user (idempotent) ────────
    let userId = await findAuthUserByEmail(normalizedEmail);
    let isNewUser = false;

    if (!userId) {
      userId = await createAuthUser(normalizedEmail);
      isNewUser = true;
      // ERR-NET-18 fix: newly-created auth.users rows can have NULL token
      // columns that crash login with a misleading error. Fix immediately.
      await fixNullTokenColumns(normalizedEmail);
    }

    // ── STEP 2: create the profiles row if it doesn't exist yet ───────────
    await ensureProfileRow(userId, normalizedEmail, first_name);

    // ── STEP 3: write a fresh login claim ticket ───────────────────────────
    const claimToken = randomToken();
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString(); // 30 min

    await createLoginClaim({
      email: normalizedEmail,
      order_id: String(order_id),
      claim_token: claimToken,
      user_id: userId,
      expires_at: expiresAt
    });

    return {
      statusCode: 200,
      headers: corsHeaders(),
      body: JSON.stringify({ success: true, is_new_user: isNewUser, user_id: userId })
    };

  } catch (err) {
    console.error('create-client error:', err);
    return { statusCode: 500, headers: corsHeaders(), body: JSON.stringify({ error: err.message }) };
  }
};

// ── HELPERS ──────────────────────────────────────────────────────────────

async function getConfigValue(key) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/config?key=eq.${encodeURIComponent(key)}&select=value&limit=1`, {
    headers: { 'apikey': SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}` }
  });
  const data = await res.json();
  return data?.[0]?.value || null;
}

async function findAuthUserByEmail(email) {
  // Supabase Admin API: list users filtered by email is not directly supported
  // in the REST GoTrue admin endpoint, so we query auth.users directly via
  // the service role (service role bypasses RLS and can read auth schema
  // through the admin endpoint below).
  const res = await fetch(`${SUPABASE_URL}/auth/v1/admin/users?email=${encodeURIComponent(email)}`, {
    headers: { 'apikey': SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}` }
  });
  if (!res.ok) return null;
  const data = await res.json();
  const users = data?.users || data;
  if (Array.isArray(users) && users.length > 0) {
    const match = users.find(u => (u.email || '').toLowerCase() === email);
    return match ? match.id : null;
  }
  return null;
}

async function createAuthUser(email) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
    method: 'POST',
    headers: {
      'apikey': SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      email,
      email_confirm: true,
      password: randomToken() // unusable random password; buyer sets a real one later via Track 2
    })
  });
  if (!res.ok) throw new Error('createAuthUser failed: ' + await res.text());
  const data = await res.json();
  return data.id;
}

async function fixNullTokenColumns(email) {
  // ERR-NET-18: newly-created auth.users rows can have NULL in several token
  // columns, which crashes login with a misleading "invalid password" error.
  // Serverless functions can't run raw SQL against Supabase directly (only
  // REST/Auth API), so this calls a one-time-created Postgres RPC function
  // (public.fix_null_auth_tokens, SECURITY DEFINER) via the standard REST
  // RPC endpoint. Never touches encrypted_password.
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/fix_null_auth_tokens`, {
    method: 'POST',
    headers: {
      'apikey': SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ target_email: email })
  });
  if (!res.ok) {
    // Do not fail account creation over this -- log loudly so it's caught in
    // Netlify function logs, since a silent failure here would only surface
    // later as a confusing login error (ERR-NET-18 itself).
    console.error('fix_null_auth_tokens RPC failed for', email, ':', await res.text());
  }
}

async function ensureProfileRow(userId, email, firstName) {
  const checkRes = await fetch(`${SUPABASE_URL}/rest/v1/profiles?id=eq.${userId}&select=id&limit=1`, {
    headers: { 'apikey': SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}` }
  });
  const existing = await checkRes.json();
  if (Array.isArray(existing) && existing.length > 0) return;

  const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/profiles`, {
    method: 'POST',
    headers: {
      'apikey': SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=minimal'
    },
    body: JSON.stringify({ id: userId, email, display_name: firstName || '', created_at: new Date().toISOString() })
  });
  if (!insertRes.ok) throw new Error('ensureProfileRow insert failed: ' + await insertRes.text());
}

async function createLoginClaim({ email, order_id, claim_token, user_id, expires_at }) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/login_claims`, {
    method: 'POST',
    headers: {
      'apikey': SUPABASE_SERVICE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=minimal'
    },
    body: JSON.stringify({ email, order_id, claim_token, user_id, expires_at })
  });
  if (!res.ok) throw new Error('createLoginClaim insert failed: ' + await res.text());
}

function randomToken() {
  // 32 bytes of randomness, base64url-ish via hex to avoid needing extra deps
  const bytes = require('crypto').randomBytes(32);
  return bytes.toString('hex');
}

function corsHeaders() {
  return { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, X-Internal-Key', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Content-Type': 'application/json' };
}

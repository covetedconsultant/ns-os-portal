// app.js — Login page logic
// After login: checks annual_operating_picture row.
// No row → new user → redirect to dashboard.html?new=true (auto-routes to setup + fires CS-11)
// Row exists → returning user → redirect to dashboard.html

const SUPABASE_URL = 'https://omjsqianefykbebnrdmp.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9tanNxaWFuZWZ5a2JlYm5yZG1wIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM1OTk3MjIsImV4cCI6MjA4OTE3NTcyMn0.BhFsvgeCakxDeP0UQM38ryPtlppnapl2RgBqkq5HkEs';

const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Email → UUID map. Supabase Auth handles the password check now;
// this map only resolves which profile UUID a given login belongs to.
// NEVER filter downstream queries by name/email — UUID only.
const USERS = {
  'coveted.consultant@gmail.com': {
    userId: '39d59f4c-3c98-4469-b65c-000ee97cf913'
  },
  'moveoutofmichigan@gmail.com': {
    userId: '149ec2e7-27f1-48fc-9a7c-abacd9be2fc1'
  },
  'coveted.consultant+test007@gmail.com': {
    userId: 'fd019cd2-ba6d-43a9-9b9e-ef2de4fd3582'
  },
  'coveted.consultant+test008@gmail.com': {
    userId: 'cd031b8d-61a8-4890-8246-28c0afe05525'
  },
  'coveted.consultant+test009@gmail.com': {
    userId: '7ee775c4-b9eb-48ab-a1e9-83e61fc487d4'
  }
};

async function hasOperatingPicture(userId, accessToken) {
  // Filter ONLY by user_id (UUID) — never by name or email
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/annual_operating_picture?user_id=eq.${userId}&select=id&limit=1`,
    { headers: { 'apikey': SUPABASE_ANON_KEY, 'Authorization': `Bearer ${accessToken || SUPABASE_ANON_KEY}` } }
  );
  const data = await res.json();
  return Array.isArray(data) && data.length > 0;
}

// ── LOGIN ──────────────────────────────────────────────────────────
const form = document.getElementById('login-form');
if (form) {
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = document.getElementById('email').value.trim().toLowerCase();
    const password = document.getElementById('password').value;
    const btn = document.getElementById('login-btn');
    const errEl = document.getElementById('error-msg');

    btn.disabled = true;
    btn.textContent = 'Signing in…';
    errEl.style.display = 'none';

    const { data, error } = await supabaseClient.auth.signInWithPassword({ email, password });

    if (error || !data?.session) {
      errEl.textContent = 'Invalid email or password.';
      errEl.style.display = 'block';
      btn.disabled = false;
      btn.textContent = 'Sign In';
      return;
    }

    const knownUser = USERS[email];
    const userId = knownUser ? knownUser.userId : data.session.user.id;

    // Store identity in localStorage
    localStorage.setItem('ns_email', email);
    localStorage.setItem('ns_user_id', userId);

    // Check for existing operating picture — determines new vs. returning user
    try {
      const hasOP = await hasOperatingPicture(userId, data.session.access_token);
      if (!hasOP) {
        // New user — no operating picture yet → route to setup view with auto-start
        window.location.href = 'dashboard.html?new=true';
      } else {
        // Returning user — operating picture exists → land on the North Star Brief
        // (dashboard.html?view=chat&autobrief=true), not the static dashboard home.
        // (2026-07-06) The brief is now the post-onboarding landing experience; the
        // dashboard becomes one of three doors, not the default.
        window.location.href = 'dashboard.html?view=chat&autobrief=true';
      }
    } catch (err) {
      // On network error, fall back to dashboard home (safe default)
      console.error('AOP check failed:', err);
      window.location.href = 'dashboard.html';
    }
  });
}

// ── FORGOT PASSWORD — view toggle ─────────────────────────────────
const loginView = document.getElementById('login-view');
const resetView = document.getElementById('reset-view');
const showResetBtn = document.getElementById('show-reset-btn');
const showLoginBtn = document.getElementById('show-login-btn');

if (showResetBtn) {
  showResetBtn.addEventListener('click', () => {
    loginView.style.display = 'none';
    resetView.style.display = 'block';
  });
}
if (showLoginBtn) {
  showLoginBtn.addEventListener('click', () => {
    resetView.style.display = 'none';
    loginView.style.display = 'block';
  });
}

// ── FORGOT PASSWORD — send reset email ────────────────────────────
const resetForm = document.getElementById('reset-form');
if (resetForm) {
  resetForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = document.getElementById('reset-email').value.trim().toLowerCase();
    const btn = document.getElementById('reset-btn');
    const errEl = document.getElementById('reset-error-msg');
    const successEl = document.getElementById('reset-success-msg');

    btn.disabled = true;
    btn.textContent = 'Sending…';
    errEl.style.display = 'none';
    successEl.style.display = 'none';

    const redirectTo = window.location.origin + '/reset-password.html';
    const { error } = await supabaseClient.auth.resetPasswordForEmail(email, { redirectTo });

    btn.disabled = false;
    btn.textContent = 'Send Reset Link';

    if (error) {
      errEl.textContent = 'Something went wrong. Please try again.';
      errEl.style.display = 'block';
      console.error('Reset request failed:', error);
      return;
    }

    // Always show success, even if the email doesn't exist — don't reveal
    // which emails are registered.
    successEl.textContent = 'If an account exists for that email, a reset link is on its way.';
    successEl.style.display = 'block';
    resetForm.reset();
  });
}

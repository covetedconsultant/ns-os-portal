// app.js — Login page logic
// After login: checks annual_operating_picture row.
// No row → new user → redirect to dashboard.html?new=true (auto-routes to setup + fires CS-11)
// Row exists → returning user → redirect to dashboard.html

const SUPABASE_URL = 'https://omjsqianefykbebnrdmp.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9tanNxaWFuZWZ5a2JlYm5yZG1wIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM1OTk3MjIsImV4cCI6MjA4OTE3NTcyMn0.BhFsvgeCakxDeP0UQM38ryPtlppnapl2RgBqkq5HkEs';

const USERS = {
  'coveted.consultant@gmail.com': {
    password: 'alzay123',
    userId: '39d59f4c-3c98-4469-b65c-000ee97cf913'
  },
  'moveoutofmichigan@gmail.com': {
    password: 'diana123',
    userId: '149ec2e7-27f1-48fc-9a7c-abacd9be2fc1'
  },
  'coveted.consultant+test007@gmail.com': {
    password: 'kaytest007',
    userId: 'fd019cd2-ba6d-43a9-9b9e-ef2de4fd3582'
  },
  'coveted.consultant+test008@gmail.com': {
    password: 'kaytest008',
    userId: 'cd031b8d-61a8-4890-8246-28c0afe05525'
  },
  'coveted.consultant+test009@gmail.com': {
    password: 'albtest009',
    userId: '7ee775c4-b9eb-48ab-a1e9-83e61fc487d4'
  }
};

async function hasOperatingPicture(userId) {
  // Filter ONLY by user_id (UUID) — never by name or email
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/annual_operating_picture?user_id=eq.${userId}&select=id&limit=1`,
    { headers: { 'apikey': SUPABASE_ANON_KEY, 'Authorization': `Bearer ${SUPABASE_ANON_KEY}` } }
  );
  const data = await res.json();
  return Array.isArray(data) && data.length > 0;
}

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

    const user = USERS[email];
    if (!user || user.password !== password) {
      errEl.textContent = 'Invalid email or password.';
      errEl.style.display = 'block';
      btn.disabled = false;
      btn.textContent = 'Sign In';
      return;
    }

    // Store identity in localStorage
    localStorage.setItem('ns_email', email);
    localStorage.setItem('ns_user_id', user.userId);

    // Check for existing operating picture — determines new vs. returning user
    try {
      const hasOP = await hasOperatingPicture(user.userId);
      if (!hasOP) {
        // New user — no operating picture yet → route to setup view with auto-start
        window.location.href = 'dashboard.html?new=true';
      } else {
        // Returning user — operating picture exists → go to dashboard home
        window.location.href = 'dashboard.html';
      }
    } catch (err) {
      // On network error, fall back to dashboard home (safe default)
      console.error('AOP check failed:', err);
      window.location.href = 'dashboard.html';
    }
  });
}

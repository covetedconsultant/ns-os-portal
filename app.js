// app.js — Login page logic
// Only runs on index.html

const SUPABASE_URL = 'https://omjsqianefykbebnrdmp.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9tanNxaWFuZWZ5a2JlYm5yZG1wIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM1OTk3MjIsImV4cCI6MjA4OTE3NTcyMn0.BhFsvgeCakxDeP0UQM38ryPtlppnapl2RgBqkq5HkEs';

const form = document.getElementById('login-form');
if (form) {
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = document.getElementById('email').value.trim();
    const password = document.getElementById('password').value;
    const btn = document.getElementById('login-btn');
    const errEl = document.getElementById('error-msg');

    btn.disabled = true;
    btn.textContent = 'Signing in…';
    errEl.style.display = 'none';

    try {
      const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
        method: 'POST',
        headers: {
          'apikey': SUPABASE_ANON_KEY,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ email, password })
      });

      const data = await res.json();

      if (!res.ok || !data.access_token) {
        throw new Error(data.error_description || data.msg || 'Invalid email or password');
      }

      localStorage.setItem('ns_token', data.access_token);
      localStorage.setItem('ns_refresh_token', data.refresh_token);
      window.location.href = 'dashboard.html';

    } catch (err) {
      errEl.textContent = err.message;
      errEl.style.display = 'block';
      btn.disabled = false;
      btn.textContent = 'Sign In';
    }
  });
}

// app.js — Login page logic
// Simple credential map — no real auth, just identity resolution for testing

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
  }
};

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
    window.location.href = 'dashboard.html';
  });
}

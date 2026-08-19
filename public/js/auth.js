/* ============================================================
   Login / Register
   Talks to /api/auth/* (server/routes/auth.js), backed by real
   Supabase Auth + a public.users profile table.
   ============================================================ */

function showMessage(el, text, color) {
  el.textContent = text;
  el.style.color = color;
  el.hidden = false;
}

const loginForm = document.getElementById('login-form');

if (loginForm) {
  const loginMessage = document.getElementById('login-message');

  loginForm.addEventListener('submit', async (event) => {
    event.preventDefault();

    const email = document.getElementById('email').value.trim();
    const password = document.getElementById('password').value;

    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });

      const data = await response.json();

      if (!response.ok) {
        showMessage(loginMessage, data.error || 'Login failed.', '#d33');
        return;
      }

      sessionStorage.setItem('access_token', data.session.access_token);
      sessionStorage.setItem('user', JSON.stringify(data.user));

      showMessage(loginMessage, 'Login successful!', '#22863a');

      setTimeout(() => {
        window.location.href = data.user.role === 'organiser' ? 'board.html' : 'StudentView.html';
      }, 700);
    } catch (error) {
      console.error('Login error:', error);
      showMessage(loginMessage, 'Unable to connect to the server.', '#d33');
    }
  });
}

const registerForm = document.getElementById('register-form');

if (registerForm) {
  const registerMessage = document.getElementById('register-message');

  registerForm.addEventListener('submit', async (event) => {
    event.preventDefault();

    const name = document.getElementById('name').value.trim();
    const email = document.getElementById('email').value.trim();
    const password = document.getElementById('password').value;
    const confirmPassword = document.getElementById('confirm-password').value;
    const role = document.getElementById('role').value;

    if (password !== confirmPassword) {
      showMessage(registerMessage, 'Passwords do not match.', '#d33');
      return;
    }

    try {
      const response = await fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, email, password, role }),
      });

      const data = await response.json();

      if (!response.ok) {
        showMessage(registerMessage, data.error || 'Registration failed.', '#d33');
        return;
      }

      showMessage(registerMessage, 'Registration successful! Redirecting to login...', '#22863a');

      setTimeout(() => {
        window.location.href = 'login.html';
      }, 1200);
    } catch (error) {
      console.error('Registration error:', error);
      showMessage(registerMessage, 'Unable to connect to the server.', '#d33');
    }
  });
}

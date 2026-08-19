const express = require('express');
const supabase = require('../supabaseClient');

const router = express.Router();

const VALID_ROLES = ['student', 'tutor', 'organiser'];

// POST /api/auth/register
router.post('/register', async (req, res) => {
  try {
    const { email, password, name, role } = req.body;

    if (!email || !password || !name || !role) {
      return res.status(400).json({ error: 'Email, password, name and role are required' });
    }

    if (!VALID_ROLES.includes(role.toLowerCase())) {
      return res.status(400).json({ error: 'Invalid role' });
    }

    const { data, error } = await supabase.auth.signUp({ email, password });
    if (error) return res.status(400).json({ error: error.message });
    if (!data.user) return res.status(400).json({ error: 'User was not created' });

    const { error: userError } = await supabase
      .from('users')
      .insert({ id: data.user.id, email, name, role: role.toLowerCase() });

    if (userError) {
      console.error('Database error:', userError);
      return res.status(500).json({
        error: 'User was created in authentication, but could not be added to the database',
      });
    }

    res.status(201).json({
      message: 'Registration successful',
      user: { id: data.user.id, email, name, role: role.toLowerCase() },
    });
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/auth/login
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) return res.status(401).json({ error: error.message });
    if (!data.user) return res.status(401).json({ error: 'Login failed' });

    const { data: profile, error: profileError } = await supabase
      .from('users')
      .select('name, role')
      .eq('id', data.user.id)
      .single();

    if (profileError) {
      console.error('Profile lookup error:', profileError);
      return res.status(500).json({ error: 'Logged in, but could not load your profile' });
    }

    res.status(200).json({
      message: 'Login successful',
      user: { id: data.user.id, email: data.user.email, name: profile.name, role: profile.role },
      session: data.session,
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;

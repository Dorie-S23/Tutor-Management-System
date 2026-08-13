require('dotenv').config();
const express = require('express');
const path = require('path');
const supabase = require('./supabaseClient');
const coursesRouter = require('./routes/courses');

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'html', 'board.html'));
});

app.use('/api/courses', coursesRouter);

app.get('/api/health/supabase', async (req, res) => {
  const { error } = await supabase.auth.getSession();
  if (error) {
    return res.status(500).json({ connected: false, error: error.message });
  }
  res.json({ connected: true });
});

app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});

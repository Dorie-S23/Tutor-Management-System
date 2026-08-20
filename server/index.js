require('dotenv').config();
const express = require('express');
const path = require('path');
const supabase = require('./supabaseClient');
const timetableRoutes = require('./timetableRoutes');

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use('/html', express.static(path.join(__dirname, '..', 'html')));
app.use('/js', express.static(path.join(__dirname, '..', 'js')));
app.use('/css', express.static(path.join(__dirname, '..', 'css')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'html', 'board.html'));
});

app.use('/api', timetableRoutes);

app.get('/api/health/supabase', async (req, res) => {
  const { error } = await supabase.auth.getSession();
  if (error) {
    return res.status(500).json({ connected: false, error: error.message });
  }
  res.json({ connected: true });
});

app.get('/api/tutors', async (req, res) => {
  const { data, error } = await supabase.from('tutors').select('*').order('name');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.post('/api/tutors', async (req, res) => {
  const { student_number, email, name, hourly_rate, academic_level } = req.body;
  const { data, error } = await supabase
    .from('tutors')
    .insert({ student_number, email, name, hourly_rate, academic_level })
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
});

app.put('/api/tutors/:id', async (req, res) => {
  const { student_number, email, name, hourly_rate, academic_level } = req.body;
  const { data, error } = await supabase
    .from('tutors')
    .update({ student_number, email, name, hourly_rate, academic_level })
    .eq('id', req.params.id)
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.delete('/api/tutors/:id', async (req, res) => {
  const { error } = await supabase.from('tutors').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.status(204).end();
});

app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});

const express = require('express');
const supabase = require('../supabaseClient');

const router = express.Router();

// GET /api/tutors — list all tutors
router.get('/', async (req, res) => {
  const { data, error } = await supabase
    .from('tutors')
    .select('*')
    .order('name');

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// GET /api/tutors/:id — a single tutor
router.get('/:id', async (req, res) => {
  const { data, error } = await supabase
    .from('tutors')
    .select('*')
    .eq('id', req.params.id)
    .single();

  if (error) {
    if (error.code === 'PGRST116') return res.status(404).json({ error: 'Tutor not found' });
    return res.status(500).json({ error: error.message });
  }
  res.json(data);
});

// POST /api/tutors — add a new tutor
router.post('/', async (req, res) => {
  const { student_number, email, name, hourly_rate, academic_level } = req.body;

  const { data, error } = await supabase
    .from('tutors')
    .insert({ student_number, email, name, hourly_rate, academic_level })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
});

// PUT /api/tutors/:id — edit an existing tutor
router.put('/:id', async (req, res) => {
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

// DELETE /api/tutors/:id — remove a tutor
router.delete('/:id', async (req, res) => {
  const { error } = await supabase.from('tutors').delete().eq('id', req.params.id);

  if (error) return res.status(500).json({ error: error.message });
  res.status(204).end();
});

module.exports = router;

const express = require('express');
const supabase = require('../supabaseClient');

const router = express.Router();

// GET /api/hour-entries?userId=...
router.get('/', async (req, res) => {
  const { userId } = req.query;
  if (!userId) return res.status(400).json({ error: 'userId is required' });

  const { data, error } = await supabase
    .from('hour_entries')
    .select('*')
    .eq('user_id', userId)
    .order('date');

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// POST /api/hour-entries
router.post('/', async (req, res) => {
  const { userId, date, hours, startTime, endTime, taskType, subject, notes } = req.body;
  if (!userId) return res.status(400).json({ error: 'userId is required' });

  const { data, error } = await supabase
    .from('hour_entries')
    .insert({
      user_id: userId,
      date,
      hours,
      start_time: startTime || null,
      end_time: endTime || null,
      task_type: taskType || 'Tutoring',
      subject: subject || '',
      notes: notes || '',
    })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
});

// PUT /api/hour-entries/:id
router.put('/:id', async (req, res) => {
  const { date, hours, startTime, endTime, taskType, subject, notes } = req.body;

  const { data, error } = await supabase
    .from('hour_entries')
    .update({
      date,
      hours,
      start_time: startTime || null,
      end_time: endTime || null,
      task_type: taskType || 'Tutoring',
      subject: subject || '',
      notes: notes || '',
      updated_at: new Date().toISOString(),
    })
    .eq('id', req.params.id)
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// DELETE /api/hour-entries/:id
router.delete('/:id', async (req, res) => {
  const { error } = await supabase.from('hour_entries').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.status(204).end();
});

module.exports = router;

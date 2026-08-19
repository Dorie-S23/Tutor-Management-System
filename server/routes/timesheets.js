const express = require('express');
const supabase = require('../supabaseClient');

const router = express.Router();

// GET /api/timesheets?userId=...&status=...&weekStart=...
// All filters optional and combinable - e.g. ?status=pending with no userId
// is how the (temporary) reviewer panel lists every student's pending weeks.
router.get('/', async (req, res) => {
  const { userId, status, weekStart } = req.query;

  let query = supabase.from('timesheets').select('*, users(name, email)');
  if (userId) query = query.eq('user_id', userId);
  if (status) query = query.eq('status', status);
  if (weekStart) query = query.eq('week_start', weekStart);

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// POST /api/timesheets - submit (or resubmit) a week
router.post('/', async (req, res) => {
  const { userId, weekStart } = req.body;
  if (!userId || !weekStart) {
    return res.status(400).json({ error: 'userId and weekStart are required' });
  }

  const { data, error } = await supabase
    .from('timesheets')
    .upsert(
      {
        user_id: userId,
        week_start: weekStart,
        status: 'pending',
        submitted_at: new Date().toISOString(),
        reviewed_at: null,
        reviewer_note: null,
      },
      { onConflict: 'user_id,week_start' }
    )
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
});

// PATCH /api/timesheets/:userId/:weekStart - approve/reject
router.patch('/:userId/:weekStart', async (req, res) => {
  const { status, note } = req.body;

  const { data, error } = await supabase
    .from('timesheets')
    .update({
      status,
      reviewed_at: new Date().toISOString(),
      reviewer_note: note || null,
    })
    .eq('user_id', req.params.userId)
    .eq('week_start', req.params.weekStart)
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

module.exports = router;

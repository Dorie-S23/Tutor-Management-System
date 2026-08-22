const express = require('express');
const supabase = require('../supabaseClient');

const router = express.Router();

// GET /api/courses?userId=... - id is included for the volunteer button to
// reference, but never rendered; userId (optional) flags which courses the
// caller has already volunteered for.
router.get('/', async (req, res) => {
  const { userId } = req.query;

  const { data: courses, error } = await supabase
    .from('courses')
    .select('id, course_code, course_name, department')
    .order('course_code');

  if (error) return res.status(500).json({ error: error.message });

  if (!userId) {
    return res.json(courses.map((c) => ({ ...c, volunteered: false })));
  }

  const { data: volunteered, error: volunteeredError } = await supabase
    .from('course_volunteers')
    .select('course_id')
    .eq('user_id', userId);

  if (volunteeredError) return res.status(500).json({ error: volunteeredError.message });

  const volunteeredIds = new Set(volunteered.map((v) => v.course_id));
  res.json(courses.map((c) => ({ ...c, volunteered: volunteeredIds.has(c.id) })));
});

module.exports = router;

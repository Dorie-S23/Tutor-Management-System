const express = require('express');
const supabase = require('../supabaseClient');

const router = express.Router();

// GET /api/courses
router.get('/', async (req, res) => {
  const { data, error } = await supabase
    .from('courses')
    .select('course_code, course_name, department')
    .order('course_code');

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

module.exports = router;

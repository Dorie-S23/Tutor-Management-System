const express = require('express');
const supabase = require('../supabaseClient');

const router = express.Router();

// GET /api/courses — list all courses
router.get('/', async (req, res) => {
  const { data, error } = await supabase
    .from('courses')
    .select('*')
    .order('course_code', { ascending: true });

  if (error) {
    return res.status(500).json({ error: error.message });
  }
  res.json(data);
});

// POST /api/courses — add a new course
router.post('/', async (req, res) => {
  const { course_code, course_name, min_mark, department } = req.body ?? {};

  if (typeof course_code !== 'string' || !course_code.trim()) {
    return res.status(400).json({ error: 'course_code is required' });
  }
  if (typeof course_name !== 'string' || !course_name.trim()) {
    return res.status(400).json({ error: 'course_name is required' });
  }
  if (typeof department !== 'string' || !department.trim()) {
    return res.status(400).json({ error: 'department is required' });
  }
  const minMarkNum = Number(min_mark);
  if (!Number.isInteger(minMarkNum) || minMarkNum < 0 || minMarkNum > 100) {
    return res.status(400).json({ error: 'min_mark must be an integer between 0 and 100' });
  }

  const { data, error } = await supabase
    .from('courses')
    .insert({
      course_code: course_code.trim(),
      course_name: course_name.trim(),
      min_mark: minMarkNum,
      department: department.trim(),
    })
    .select()
    .single();

  if (error) {
    if (error.code === '23505') {
      return res.status(409).json({ error: `Course code "${course_code}" already exists` });
    }
    return res.status(500).json({ error: error.message });
  }

  res.status(201).json(data);
});

module.exports = router;

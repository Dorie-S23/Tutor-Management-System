const express = require('express');
const supabase = require('../supabaseClient');

const router = express.Router();

// shared validation for POST (create) and PUT (update)
function parseCoursePayload(body) {
  const { course_code, course_name, min_mark, department, hours_per_week } = body ?? {};

  if (typeof course_code !== 'string' || !course_code.trim()) {
    return { error: 'course_code is required' };
  }
  if (typeof course_name !== 'string' || !course_name.trim()) {
    return { error: 'course_name is required' };
  }
  if (typeof department !== 'string' || !department.trim()) {
    return { error: 'department is required' };
  }
  const minMarkNum = Number(min_mark);
  if (!Number.isInteger(minMarkNum) || minMarkNum < 0 || minMarkNum > 100) {
    return { error: 'min_mark must be an integer between 0 and 100' };
  }

  if (hours_per_week === undefined || hours_per_week === null || hours_per_week === '') {
    return { error: 'hours_per_week is required' };
  }
  const hoursPerWeekNum = Number(hours_per_week);
  if (!Number.isInteger(hoursPerWeekNum) || hoursPerWeekNum < 0 || hoursPerWeekNum > 168) {
    return { error: 'hours_per_week must be an integer between 0 and 168' };
  }

  return {
    values: {
      course_code: course_code.trim(),
      course_name: course_name.trim(),
      min_mark: minMarkNum,
      department: department.trim(),
      hours_per_week: hoursPerWeekNum,
    },
  };
}

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
  const { values, error: validationError } = parseCoursePayload(req.body);
  if (validationError) {
    return res.status(400).json({ error: validationError });
  }

  const { data, error } = await supabase
    .from('courses')
    .insert(values)
    .select()
    .single();

  if (error) {
    if (error.code === '23505') {
      return res.status(409).json({ error: `Course code "${values.course_code}" already exists` });
    }
    return res.status(500).json({ error: error.message });
  }

  res.status(201).json(data);
});

// PUT /api/courses/:id — edit an existing course
router.put('/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: 'Invalid course id' });
  }

  const { values, error: validationError } = parseCoursePayload(req.body);
  if (validationError) {
    return res.status(400).json({ error: validationError });
  }

  const { data, error } = await supabase
    .from('courses')
    .update(values)
    .eq('id', id)
    .select()
    .single();

  if (error) {
    if (error.code === '23505') {
      return res.status(409).json({ error: `Course code "${values.course_code}" already exists` });
    }
    if (error.code === 'PGRST116') {
      return res.status(404).json({ error: 'Course not found' });
    }
    return res.status(500).json({ error: error.message });
  }

  res.json(data);
});

module.exports = router;

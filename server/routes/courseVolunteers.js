const express = require('express');
const supabase = require('../supabaseClient');

const router = express.Router();

// GET /api/course-volunteers?userId=... - a student's own applications, with course info attached
router.get('/', async (req, res) => {
  const { userId } = req.query;
  if (!userId) {
    return res.status(400).json({ error: 'userId is required' });
  }

  const { data, error } = await supabase
    .from('course_volunteers')
    .select('*, courses(course_code, course_name, department)')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// POST /api/course-volunteers - volunteer for a course, self-reporting a mark.
// Below the course's min_mark is rejected outright (nothing recorded); at or
// above it goes in as 'pending' for an organiser to review later.
router.post('/', async (req, res) => {
  const { userId, courseId, mark } = req.body ?? {};

  if (!userId || !courseId) {
    return res.status(400).json({ error: 'userId and courseId are required' });
  }

  const markNum = Number(mark);
  if (!Number.isInteger(markNum) || markNum < 0 || markNum > 100) {
    return res.status(400).json({ error: 'mark must be an integer between 0 and 100' });
  }

  const { data: course, error: courseError } = await supabase
    .from('courses')
    .select('course_code, min_mark')
    .eq('id', courseId)
    .single();

  if (courseError || !course) {
    return res.status(404).json({ error: 'Course not found' });
  }

  if (Number.isInteger(course.min_mark) && markNum < course.min_mark) {
    return res.status(403).json({
      error: `You need at least ${course.min_mark} for ${course.course_code} to volunteer — you entered ${markNum}.`,
    });
  }

  const { data, error } = await supabase
    .from('course_volunteers')
    .insert({ user_id: userId, course_id: courseId, mark: markNum, status: 'pending' })
    .select()
    .single();

  if (error) {
    if (error.code === '23505') {
      return res.status(409).json({ error: `You've already volunteered for ${course.course_code}.` });
    }
    return res.status(500).json({ error: error.message });
  }

  res.status(201).json(data);
});

// DELETE /api/course-volunteers?userId=...&courseId=... - withdraw
router.delete('/', async (req, res) => {
  const { userId, courseId } = req.query;
  if (!userId || !courseId) {
    return res.status(400).json({ error: 'userId and courseId are required' });
  }

  const { error } = await supabase
    .from('course_volunteers')
    .delete()
    .eq('user_id', userId)
    .eq('course_id', courseId);

  if (error) return res.status(500).json({ error: error.message });
  res.status(204).end();
});

module.exports = router;

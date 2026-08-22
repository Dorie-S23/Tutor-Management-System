const express = require('express');
const supabase = require('../supabaseClient');

const router = express.Router();

// POST /api/course-volunteers - claim a course
router.post('/', async (req, res) => {
  const { userId, courseId } = req.body;
  if (!userId || !courseId) {
    return res.status(400).json({ error: 'userId and courseId are required' });
  }

  const { data, error } = await supabase
    .from('course_volunteers')
    .insert({ user_id: userId, course_id: courseId })
    .select()
    .single();

  if (error) {
    if (error.code === '23505') {
      return res.status(409).json({ error: 'Already volunteering for this course' });
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

const express = require('express');
const supabase = require('../supabaseClient');

const router = express.Router();

// shared validation for POST (create) and PUT (update)
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)(:[0-5]\d)?$/;

function parseCoursePayload(body) {
  const {
    course_code,
    course_name,
    min_mark,
    department,
    hours_per_week,
    tutors_needed,
    day_of_tut,
    tutor_start_time,
    tutor_end_time,
  } = body ?? {};

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

  if (tutors_needed === undefined || tutors_needed === null || tutors_needed=== '' ){
    return {error: 'number of tutors needed is required'};
  }

  const tutorsNeeded = Number(tutors_needed);
  if (!Number.isInteger(tutorsNeeded) || tutorsNeeded < 0 || tutorsNeeded > 20){
    return {error: "number of tutors needed must be an integer between 0 and 20"};
  }

  let dayOfTut = null;
  if (day_of_tut !== undefined && day_of_tut !== null && day_of_tut !== '') {
    if (typeof day_of_tut !== 'string' || !day_of_tut.trim()) {
      return { error: 'Day_of_tut must be a non-empty string' };
    }
    dayOfTut = day_of_tut.trim();
  }

  let startTime = null;
  if (tutor_start_time !== undefined && tutor_start_time !== null && tutor_start_time !== '') {
    if (typeof tutor_start_time !== 'string' || !TIME_RE.test(tutor_start_time)) {
      return { error: 'tutor_start_time must be a valid time (HH:MM)' };
    }
    startTime = tutor_start_time;
  }

  let endTime = null;
  if (tutor_end_time !== undefined && tutor_end_time !== null && tutor_end_time !== '') {
    if (typeof tutor_end_time !== 'string' || !TIME_RE.test(tutor_end_time)) {
      return { error: 'tutor_end_time must be a valid time (HH:MM)' };
    }
    endTime = tutor_end_time;
  }

  if (startTime && endTime && startTime >= endTime) {
    return { error: 'tutor_start_time must be before tutor_end_time' };
  }

  return {
    values: {
      course_code: course_code.trim(),
      course_name: course_name.trim(),
      min_mark: minMarkNum,
      department: department.trim(),
      hours_per_week: hoursPerWeekNum,
      tutors_needed: tutorsNeeded,
      Day_of_tut: dayOfTut,
      tutor_start_time: startTime,
      tutor_end_time: endTime,
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

// PATCH /api/courses/:id/tutors-assigned — bump the assigned-tutor counter up or down by 1
router.patch('/:id/tutors-assigned', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: 'Invalid course id' });
  }

  const { delta } = req.body ?? {};
  if (delta !== 1 && delta !== -1) {
    return res.status(400).json({ error: 'delta must be 1 or -1' });
  }

  const { data: course, error: fetchError } = await supabase
    .from('courses')
    .select('no_of_tutors_assigned, tutors_needed')
    .eq('id', id)
    .single();

  if (fetchError) {
    if (fetchError.code === 'PGRST116') {
      return res.status(404).json({ error: 'Course not found' });
    }
    return res.status(500).json({ error: fetchError.message });
  }

  const next = (course.no_of_tutors_assigned ?? 0) + delta;

  if (next < 0) {
    return res.status(409).json({ error: 'No tutors are currently assigned to this course' });
  }
  if (next > course.tutors_needed) {
    return res.status(409).json({ error: 'This course already has all the tutors it needs' });
  }

  const { data, error } = await supabase
    .from('courses')
    .update({ no_of_tutors_assigned: next })
    .eq('id', id)
    .select()
    .single();

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  res.json(data);
});

module.exports = router;

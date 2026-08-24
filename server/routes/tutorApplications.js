const express = require('express');
const supabase = require('../supabaseClient');

const router = express.Router();

// academic_level -> numeric year, so it can be compared against a course's course_level
const LEVEL_RANK = {
  second_year: 2,
  third_year: 3,
  honours: 4,
  masters: 5,
  phd: 6,
};

// GET /api/tutor-applications?tutorId=... — a tutor's own applications, with course info attached
// GET /api/tutor-applications?courseId=... — everyone who has applied to tutor a course, with tutor info attached
router.get('/', async (req, res) => {
  const { tutorId, courseId } = req.query;
  if (!tutorId && !courseId) {
    return res.status(400).json({ error: 'tutorId or courseId is required' });
  }

  let query = supabase
    .from('tutor_subject_preference')
    .select('*, courses(course_code, course_name), tutors(name, email, academic_level)');

  if (tutorId) query = query.eq('tutor_id', tutorId);
  if (courseId) query = query.eq('course_id', courseId);

  const { data, error } = await query;

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// POST /api/tutor-applications — apply to tutor a course
router.post('/', async (req, res) => {
  const { tutorId, courseId, mark, availability, academicLevel } = req.body ?? {};

  if (!tutorId || !courseId) {
    return res.status(400).json({ error: 'tutorId and courseId are required' });
  }

  const markNum = Number(mark);
  if (!Number.isInteger(markNum) || markNum < 0 || markNum > 100) {
    return res.status(400).json({ error: 'mark must be an integer between 0 and 100' });
  }

  if (typeof availability !== 'boolean') {
    return res.status(400).json({ error: 'availability is required' });
  }

  // Self-reported by the tutor — not set by an organiser
  if (!Object.prototype.hasOwnProperty.call(LEVEL_RANK, academicLevel)) {
    return res.status(400).json({ error: 'Please select your year of study' });
  }

  const { data: tutor, error: tutorError } = await supabase
    .from('tutors')
    .select('name')
    .eq('id', tutorId)
    .single();

  if (tutorError || !tutor) {
    return res.status(404).json({ error: 'Tutor not found' });
  }

  const { data: course, error: courseError } = await supabase
    .from('courses')
    .select('course_code, course_name, course_level')
    .eq('id', courseId)
    .single();

  if (courseError || !course) {
    return res.status(404).json({ error: 'Course not found' });
  }

  // A tutor must be at least one year ahead of the course they want to tutor.
  // If the course's level is unknown, we can't verify eligibility — block rather than assume.
  if (course.course_level == null) {
    return res.status(403).json({
      error: `${course.course_code} doesn't have a year level set yet — ask an organiser to set it before applying.`,
    });
  }
  const tutorYear = LEVEL_RANK[academicLevel];
  if (tutorYear <= course.course_level) {
    return res.status(403).json({
      error: `You need to be at least one year ahead of ${course.course_code} (level ${course.course_level}) to tutor it.`,
    });
  }

  // Persist the tutor's self-reported year of study on their record
  const { error: levelUpdateError } = await supabase
    .from('tutors')
    .update({ academic_level: academicLevel })
    .eq('id', tutorId);

  if (levelUpdateError) return res.status(500).json({ error: levelUpdateError.message });

  const { data: existing, error: existingError } = await supabase
    .from('tutor_subject_preference')
    .select('id')
    .eq('tutor_id', tutorId)
    .eq('course_id', courseId)
    .maybeSingle();

  if (existingError) return res.status(500).json({ error: existingError.message });
  if (existing) {
    return res.status(409).json({ error: `You've already applied to tutor ${course.course_code}.` });
  }

  const { data, error } = await supabase
    .from('tutor_subject_preference')
    .insert({
      tutor_id: tutorId,
      course_id: courseId,
      status: 'pending',
      Tutor_name: tutor.name,
      tutor_mark: markNum,
      Availability: availability,
    })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
});

const VALID_STATUSES = ['pending', 'approved', 'rejected'];

// PATCH /api/tutor-applications/:id — organiser approves/rejects/resets an application.
// Keeps the course's no_of_tutors_assigned counter in sync with the "approved" applications.
router.patch('/:id', async (req, res) => {
  const { status } = req.body ?? {};
  if (!VALID_STATUSES.includes(status)) {
    return res.status(400).json({ error: 'status must be pending, approved or rejected' });
  }

  const { data: application, error: applicationError } = await supabase
    .from('tutor_subject_preference')
    .select('id, status, course_id')
    .eq('id', req.params.id)
    .single();

  if (applicationError || !application) {
    return res.status(404).json({ error: 'Application not found' });
  }

  const wasApproved = application.status === 'approved';
  const willBeApproved = status === 'approved';

  if (wasApproved !== willBeApproved) {
    const { data: course, error: courseError } = await supabase
      .from('courses')
      .select('no_of_tutors_assigned, tutors_needed')
      .eq('id', application.course_id)
      .single();

    if (courseError || !course) {
      return res.status(404).json({ error: 'Course not found' });
    }

    const next = (course.no_of_tutors_assigned ?? 0) + (willBeApproved ? 1 : -1);

    if (willBeApproved && next > course.tutors_needed) {
      return res.status(409).json({ error: 'This course already has all the tutors it needs' });
    }

    const { error: bumpError } = await supabase
      .from('courses')
      .update({ no_of_tutors_assigned: Math.max(next, 0) })
      .eq('id', application.course_id);

    if (bumpError) return res.status(500).json({ error: bumpError.message });
  }

  const { data, error } = await supabase
    .from('tutor_subject_preference')
    .update({ status })
    .eq('id', req.params.id)
    .select('*, courses(course_code, course_name), tutors(name, email, academic_level)')
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

module.exports = router;

// One-shot: generate example academic transcript PDFs, mirroring
// Sample_Transcript_Arti_Nouh.pdf (same wording, layout, invented credit
// scheme, SAMPLE branding). Each student's years follow the Wits curricula;
// the Year 1 elective slot is a random pick from the verified Level I pool
// (stable per student via a seeded RNG); application marks are pinned to the
// real applications so transcripts and applications can never disagree.
//
// The STUDENTS literal holds the three reviewed examples; the BATCH below
// extends it to every tutor and volunteer in the system, built from the
// live roster — levels from tutors.academic_level, application marks as
// anchors, test accounts and duplicate personas excluded.
//
//   node generate-transcript.js            # every configured student
//   node generate-transcript.js oupa       # just one, by key
const fs = require("fs");
const path = require("path");

// A >= 75, B 70-74, C 60-69, D 50-59, F < 50 — the sample's grade scale.
const gradeFor = (mark) =>
  mark >= 75
    ? "A"
    : mark >= 70
      ? "B"
      : mark >= 60
        ? "C"
        : mark >= 50
          ? "D"
          : "F";

const BSC = "Bachelor of Science (Full-Time) | Qualification ID: 5027";
const HONS_CS =
  "Bachelor of Science with Honours in Computer Science (Full-Time) | Qualification ID: 5028";
const MSC_CS =
  "Master of Science in the field of Computer Science (Full-Time) | Qualification ID: 5029";
const HONS_CAM =
  "Bachelor of Science with Honours in the field of Computational and Applied Mathematics (Full-Time) | Qualification ID: 5030";

// The free Level I slot in first year. The CAM course-finder names the
// choice fields (physics, chemistry, computer science, biology, astrophysics,
// geology, philosophy, economics, finance, accounting); these codes are the
// ones verifiable from Wits' own pages (course finder, Science UG booklet,
// fees book). Credits are invented like the rest, full-year courses 36 and
// semester courses 18, following the sample's Psychology I = 36.
const LEVEL_I_ELECTIVES = [
  { code: "PHYS1000A", name: "Physics I (Major)", credit: 36 },
  { code: "CHEM1012A", name: "Chemistry I", credit: 36 },
  { code: "BIOL1000A", name: "Introductory Life Sciences I", credit: 18 },
  { code: "PSYC1009A", name: "Psychology I", credit: 36 },
  { code: "PHIL1002A", name: "Introduction to Ethics I", credit: 18 },
  { code: "ECON1014A", name: "Economics IB - Macroeconomics", credit: 18 },
];

// Deterministic per-student RNG (xmur3 hash -> mulberry32) so a student's
// random elective and its mark are stable across regenerations.
function xmur3(str) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return function () {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return (h ^= h >>> 16) >>> 0;
  };
}
function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function rngFor(str) {
  return mulberry32(xmur3(str)());
}

// [code, course, final mark | null = in progress, NQF credit | null = none]
// Credits reuse the sample's invented values where it showed the course
// (COMS I 9, APPM I 12, MATH I 15/21, PSYC I 36, COMS II 12, MATH II 8/16,
// APPM II 12 matching APPM I) and stay in that spirit elsewhere.
const STUDENTS = {
  oupa: {
    name: "Mr. Oupa Sir",
    id: "2841690",
    issued: "11 October 2026",
    markBand: [56, 74], // middling student, like the sample's marks
    anchor:
      "COMS1018A mark 98 = his approved application mark (min_mark 74) — consistent",
    years: [
      {
        year: "2024",
        study: 1,
        programme: BSC,
        outcome: "Permitted to proceed",
        rows: [
          ["APPM1026A", "Mathematical Methods and Modelling I", 66, 12],
          ["APPM1028A", "Mechanics I", 60, 12],
          ["APPM1030A", "Scientific Computing I", 73, 12],
          ["COMS1015A", "Basic Computer Organisation I", 71, 9],
          ["COMS1016A", "Discrete Computational Structures I", 68, 9],
          [
            "COMS1017A",
            "Introduction to Data Structures and Algorithms I",
            74,
            9,
          ],
          ["COMS1018A", "Introduction to Algorithms and Programming I", 98, 9],
          ["MATH1034A", "Algebra I", 62, 15],
          ["MATH1036A", "Calculus I", 58, 21],
        ],
      },
      {
        year: "2025",
        study: 2,
        programme: BSC,
        outcome: "Permitted to proceed",
        rows: [
          ["APPM2021A", "Mathematical Methods and Modelling II", 64, 12],
          ["APPM2023A", "Mechanics II", 58, 12],
          ["APPM2025A", "Scientific Computing II", 70, 12],
          ["COMS2002A", "Database Fundamentals II", 66, 12],
          ["COMS2013A", "Mobile Computing II", 72, 12],
          ["COMS2014A", "Computer Networks II", 69, 12],
          ["COMS2015A", "Analysis of Algorithms II", 75, 12],
          ["MATH2001A", "Basic Analysis II", 55, 8],
          ["MATH2007A", "Multivariable Calculus II", 61, 8],
          ["MATH2015A", "Abstract Mathematics II", 57, 16],
          ["MATH2016A", "Advanced Analysis II", 54, 16],
          ["MATH2019A", "Linear Algebra II", 63, 8],
          ["STAT2012A", "Introduction to Mathematical Statistics II", 59, 16],
        ],
      },
      {
        year: "2026",
        study: 3,
        programme: BSC,
        outcome: "***",
        // Full double COMS major, the typical load for a BSc CS student: the
        // Computer Science III half (Analysis of Advanced Algorithms, Formal
        // Languages and Automata, Operating Systems and System Programming,
        // Software Design) plus the Computational Applications III half
        // (Graphics, Machine Learning, Parallel Computing, Software Design
        // Project). All in progress, so marks/credits are ***.
        rows: [
          ["COMS3003A", "Formal Languages and Automata III", null, null],
          ["COMS3005A", "Analysis of Advanced Algorithms III", null, null],
          ["COMS3006A", "Computer Graphics and Visualisation III", null, null],
          ["COMS3007A", "Machine Learning III", null, null],
          ["COMS3008A", "Parallel Computing III", null, null],
          ["COMS3009A", "Software Design III", null, null],
          [
            "COMS3010A",
            "Operating Systems and System Programming III",
            null,
            null,
          ],
          ["COMS3011A", "Software Design Project III", null, null],
        ],
      },
    ],
  },

  // Masters student on the CS path: BSc (2021-23) -> BScHons CS (2024, the
  // real compulsory pair plus seven electives) -> MSc coursework year (2025,
  // real COMS7xxx set, electives chosen to respect the no-overlap rule:
  // none of them is the COMS7 equivalent of a COMS4 module she took) ->
  // research-report year in progress (2026). Marks skew high so the real
  // entry gates hold: 70% aggregate into CS honours, 65% into the MSc.
  khensahosi: {
    name: "Ms. Khensahosi Kuduza",
    id: "2518347",
    issued: "11 October 2026",
    markBand: [70, 86], // strong student, clears the honours/masters gates
    anchor:
      "COMS3011A mark 85 = her approved application mark (min_mark 80) — consistent",
    years: [
      {
        year: "2021",
        study: 1,
        programme: BSC,
        outcome: "Permitted to proceed",
        rows: [
          ["APPM1026A", "Mathematical Methods and Modelling I", 78, 12],
          ["APPM1028A", "Mechanics I", 74, 12],
          ["APPM1030A", "Scientific Computing I", 82, 12],
          ["COMS1015A", "Basic Computer Organisation I", 79, 9],
          ["COMS1016A", "Discrete Computational Structures I", 81, 9],
          [
            "COMS1017A",
            "Introduction to Data Structures and Algorithms I",
            77,
            9,
          ],
          ["COMS1018A", "Introduction to Algorithms and Programming I", 84, 9],
          ["MATH1034A", "Algebra I", 72, 15],
          ["MATH1036A", "Calculus I", 70, 21],
        ],
      },
      {
        year: "2022",
        study: 2,
        programme: BSC,
        outcome: "Permitted to proceed",
        rows: [
          ["APPM2021A", "Mathematical Methods and Modelling II", 76, 12],
          ["APPM2023A", "Mechanics II", 73, 12],
          ["APPM2025A", "Scientific Computing II", 80, 12],
          ["COMS2002A", "Database Fundamentals II", 82, 12],
          ["COMS2013A", "Mobile Computing II", 78, 12],
          ["COMS2014A", "Computer Networks II", 79, 12],
          ["COMS2015A", "Analysis of Algorithms II", 85, 12],
          ["MATH2001A", "Basic Analysis II", 68, 8],
          ["MATH2007A", "Multivariable Calculus II", 71, 8],
          ["MATH2015A", "Abstract Mathematics II", 70, 16],
          ["MATH2016A", "Advanced Analysis II", 66, 16],
          ["MATH2019A", "Linear Algebra II", 74, 8],
          ["STAT2012A", "Introduction to Mathematical Statistics II", 69, 16],
        ],
      },
      {
        year: "2023",
        study: 3,
        programme: BSC,
        outcome: "Permitted to proceed",
        rows: [
          ["COMS3003A", "Formal Languages and Automata III", 78, 12],
          ["COMS3005A", "Analysis of Advanced Algorithms III", 83, 12],
          ["COMS3006A", "Computer Graphics and Visualisation III", 80, 12],
          ["COMS3007A", "Machine Learning III", 88, 12],
          ["COMS3008A", "Parallel Computing III", 82, 12],
          ["COMS3009A", "Software Design III", 79, 12],
          ["COMS3010A", "Operating Systems and System Programming III", 81, 12],
          ["COMS3011A", "Software Design Project III", 85, 12],
        ],
      },
      {
        year: "2024",
        study: 4,
        programme: HONS_CS,
        nqf: 8,
        outcome: "Permitted to proceed",
        // Compulsory COMS4059A/4057A plus seven electives. COMS4032A
        // (Applications of Algorithms) is deliberately absent: its COMS7
        // equivalent COMS7041A is compulsory in her masters coursework
        // year, and Wits bars registering for a COMS7 module whose COMS4
        // equivalent was already taken.
        rows: [
          ["COMS4033A", "Artificial Intelligence", 84, 12],
          ["COMS4036A", "Computer Vision", 79, 12],
          ["COMS4045A", "Robotics", 77, 12],
          ["COMS4048A", "Data Analysis and Exploration", 81, 12],
          ["COMS4054A", "Natural Language Processing", 83, 12],
          ["COMS4055A", "Mathematical Foundations of Data Science", 75, 12],
          ["COMS4057A", "Introduction to Research Methods", 76, 12],
          ["COMS4059A", "Research Project: Computer Science", 82, 24],
          ["COMS4061A", "Reinforcement Learning", 78, 12],
        ],
      },
      {
        year: "2025",
        study: 5,
        programme: MSC_CS,
        nqf: 9,
        outcome: "Permitted to proceed",
        // MSc coursework year: compulsory COMS7072A + COMS7041A plus five
        // electives, none overlapping her COMS4 picks.
        rows: [
          ["COMS7041A", "Applications of Algorithms", 81, 15],
          ["COMS7055A", "Data Policy and Ethics", 76, 15],
          ["COMS7057A", "Large Scale Optimisation and Data Science", 79, 15],
          [
            "COMS7059A",
            "Large Scale Computing Systems and Scientific Programming",
            80,
            15,
          ],
          ["COMS7062A", "Special Topics in Data Science", 82, 15],
          ["COMS7063A", "Statistical Foundations of Data Science", 78, 15],
          [
            "COMS7072A",
            "Research Methods and Capstone Project in Computer Science",
            84,
            15,
          ],
        ],
      },
      {
        year: "2026",
        study: 6,
        programme: MSC_CS,
        nqf: 9,
        outcome: "***",
        rows: [["COMS7009A", "Research Report: Computer Science", null, null]],
      },
    ],
  },

  // Applied Maths (CAM) major now in the honours year — the full CAM
  // ladder: BSc CAM (2023-25, with the full Computer Science I the CAM
  // course-finder recommends plus one random Level I elective) -> BScHons
  // CAM in progress (2026). The Year 2 mark for Scientific Computing II is
  // pinned to her pending tutoring application, which clears its min_mark;
  // the honours year carries the six compulsory APPM4xxx courses, the
  // research project, research methods, and both electives.
  risuna: {
    name: "Ms. Risuna Mphakati",
    id: "2741908", // invented — her account email carries no student number
    issued: "11 October 2026",
    markBand: [70, 84], // solid student, clears the 60% CAM honours gate
    anchor:
      "APPM2025A mark 77 = her pending application mark (min_mark 75) — the record supports approving it",
    years: [
      {
        year: "2023",
        study: 1,
        programme: BSC,
        outcome: "Permitted to proceed",
        rows: [
          ["APPM1026A", "Mathematical Methods and Modelling I", 74, 12],
          ["APPM1028A", "Mechanics I", 72, 12],
          ["APPM1030A", "Scientific Computing I", 79, 12],
          ["COMS1015A", "Basic Computer Organisation I", 71, 9],
          ["COMS1016A", "Discrete Computational Structures I", 75, 9],
          [
            "COMS1017A",
            "Introduction to Data Structures and Algorithms I",
            70,
            9,
          ],
          ["COMS1018A", "Introduction to Algorithms and Programming I", 76, 9],
          ["MATH1034A", "Algebra I", 72, 15],
          ["MATH1036A", "Calculus I", 78, 21],
        ],
      },
      {
        year: "2024",
        study: 2,
        programme: BSC,
        outcome: "Permitted to proceed",
        rows: [
          ["APPM2021A", "Mathematical Methods and Modelling II", 73, 12],
          ["APPM2023A", "Mechanics II", 75, 12],
          ["APPM2025A", "Scientific Computing II", 77, 12],
          ["COMS2002A", "Database Fundamentals II", 72, 12],
          ["MATH2001A", "Basic Analysis II", 69, 8],
          ["MATH2007A", "Multivariable Calculus II", 74, 8],
          ["MATH2015A", "Abstract Mathematics II", 71, 16],
          ["MATH2016A", "Advanced Analysis II", 68, 16],
          ["MATH2019A", "Linear Algebra II", 78, 8],
          ["STAT2012A", "Introduction to Mathematical Statistics II", 70, 16],
        ],
      },
      {
        year: "2025",
        study: 3,
        programme: BSC,
        outcome: "Permitted to proceed",
        rows: [
          ["APPM3038A", "Mathematical Methods and Modelling III", 76, 12],
          ["APPM3039A", "Mechanics III", 81, 12],
          ["APPM3040A", "Scientific Computing III", 84, 12],
          ["COMS3007A", "Machine Learning III", 74, 12],
        ],
      },
      {
        year: "2026",
        study: 4,
        programme: HONS_CAM,
        nqf: 8,
        outcome: "***",
        rows: [
          ["APPM4054A", "Mathematical Modelling", null, null],
          ["APPM4055A", "Partial Differential Equations", null, null],
          [
            "APPM4056A",
            "Symmetry Methods for Differential Equations",
            null,
            null,
          ],
          ["APPM4057A", "Computational Differential Equations", null, null],
          ["APPM4059A", "Continuum Mechanics", null, null],
          ["APPM4061A", "Studies in Applied Mathematics", null, null],
          ["APPM4064A", "Optimal Control Theory", null, null],
          ["APPM4065A", "Global Optimization", null, null],
          ["APPM4076A", "Research Project", null, null],
          ["COMS4057A", "Introduction to Research Methods", null, null],
        ],
      },
    ],
  },
};

// ---------- batch: a transcript for every tutor and volunteer ----------
//
// Levels come from tutors.academic_level where the row exists; a missing or
// null row defaults to third_year, except that an application for a Level
// III course (which needs a completed mark on the transcript) forces
// honours. Majors: an APPM application means the CAM curriculum, otherwise
// CS. Application marks — approved, pending or rejected, they are the
// marks the student claimed — anchor the matching course rows. Test
// courses (coms1033/coms3033/coms4033) and test accounts are excluded.

const PROCEED = "Permitted to proceed";

// [code, course, NQF credit] per module, verified against the Wits course
// finder; credits reuse the sample's invented scheme.
const COMS1 = [
  ["COMS1015A", "Basic Computer Organisation I", 9],
  ["COMS1016A", "Discrete Computational Structures I", 9],
  ["COMS1017A", "Introduction to Data Structures and Algorithms I", 9],
  ["COMS1018A", "Introduction to Algorithms and Programming I", 9],
];
const MATH1 = [
  ["MATH1034A", "Algebra I", 15],
  ["MATH1036A", "Calculus I", 21],
];
const CAM1 = [
  ["APPM1026A", "Mathematical Methods and Modelling I", 12],
  ["APPM1028A", "Mechanics I", 12],
  ["APPM1030A", "Scientific Computing I", 12],
];
const COMS2 = [
  ["COMS2002A", "Database Fundamentals II", 12],
  ["COMS2013A", "Mobile Computing II", 12],
  ["COMS2014A", "Computer Networks II", 12],
  ["COMS2015A", "Analysis of Algorithms II", 12],
];
const MATH2 = [
  ["MATH2001A", "Basic Analysis II", 8],
  ["MATH2007A", "Multivariable Calculus II", 8],
  ["MATH2015A", "Abstract Mathematics II", 16],
  ["MATH2016A", "Advanced Analysis II", 16],
  ["MATH2019A", "Linear Algebra II", 8],
  ["STAT2012A", "Introduction to Mathematical Statistics II", 16],
];
const CAM2 = [
  ["APPM2021A", "Mathematical Methods and Modelling II", 12],
  ["APPM2023A", "Mechanics II", 12],
  ["APPM2025A", "Scientific Computing II", 12],
];
// The single Level II / Level III major-course slot the CAM course-finder
// gives alongside the CAM core.
const CAM2_SLOT = [["COMS2002A", "Database Fundamentals II", 12]];
const CAM3_SLOT = [["COMS3007A", "Machine Learning III", 12]];
const COMS3 = [
  ["COMS3003A", "Formal Languages and Automata III", 12],
  ["COMS3005A", "Analysis of Advanced Algorithms III", 12],
  ["COMS3006A", "Computer Graphics and Visualisation III", 12],
  ["COMS3007A", "Machine Learning III", 12],
  ["COMS3008A", "Parallel Computing III", 12],
  ["COMS3009A", "Software Design III", 12],
  ["COMS3010A", "Operating Systems and System Programming III", 12],
  ["COMS3011A", "Software Design Project III", 12],
];
const CAM3 = [
  ["APPM3038A", "Mathematical Methods and Modelling III", 12],
  ["APPM3039A", "Mechanics III", 12],
  ["APPM3040A", "Scientific Computing III", 12],
];

// BScHons CS: the compulsory pair plus seven electives. COMS4032A is left
// out of the pool because its COMS7 equivalent COMS7041A is compulsory in
// the MSc coursework year, and Wits bars the overlap.
const HONS_CS_CORE = [
  ["COMS4057A", "Introduction to Research Methods", 12],
  ["COMS4059A", "Research Project: Computer Science", 24],
];
const HONS_CS_ELECTIVES = [
  ["COMS4030A", "Adaptive Computation and Machine Learning", 12],
  ["COMS4033A", "Artificial Intelligence", 12],
  ["COMS4036A", "Computer Vision", 12],
  [
    "COMS4040A",
    "High Performance Computing and Scientific Data Management",
    12,
  ],
  ["COMS4043A", "Multi-agent Systems", 12],
  ["COMS4045A", "Robotics", 12],
  ["COMS4047A", "Special Topics in Computer Science", 12],
  ["COMS4048A", "Data Analysis and Exploration", 12],
  ["COMS4050A", "Discrete Optimization", 12],
  ["COMS4054A", "Natural Language Processing", 12],
  ["COMS4055A", "Mathematical Foundations of Data Science", 12],
  ["COMS4060A", "Introduction to Data Visualisation and Exploration", 12],
  ["COMS4061A", "Reinforcement Learning", 12],
  ["APPM4058A", "Digital Image Processing", 12],
  ["COMS4064A", "Cybersecurity IV", 12],
  ["COMS4065A", "Cryptography IV", 12],
  ["COMS4068A", "Data Privacy and Ethics IV", 12],
  ["COMS4069A", "Computational Intelligence IV", 12],
  ["COMS4070A", "Computational Neuroscience IV", 12],
];

// MSc CS by coursework and research report: compulsory pair plus five
// electives, at 15 credits each following the reviewed example's scheme.
const MSC_CS_CORE = [
  ["COMS7041A", "Applications of Algorithms", 15],
  [
    "COMS7072A",
    "Research Methods and Capstone Project in Computer Science",
    15,
  ],
];
const MSC_CS_ELECTIVES = [
  ["COMS7044A", "Artificial Intelligence", 15],
  [
    "COMS7045A",
    "High-Performance Computing and Scientific Data Management",
    15,
  ],
  ["COMS7046A", "Distributed Databases and Transaction Processing", 15],
  ["COMS7047A", "Adaptive Computation and Machine Learning", 15],
  ["COMS7048A", "Multi-agent Systems", 15],
  ["COMS7049A", "Robotics", 15],
  ["COMS7050A", "Computer Vision", 15],
  ["COMS7053A", "Special Topics in Computer Science", 15],
  ["COMS7055A", "Data Policy and Ethics", 15],
  ["COMS7056A", "Data Visualisation and Exploration", 15],
  ["COMS7057A", "Large Scale Optimisation and Data Science", 15],
  ["COMS7058A", "Mathematical Foundations of Data Science", 15],
  ["COMS7059A", "Large Scale Computing Systems and Scientific Programming", 15],
  ["COMS7062A", "Special Topics in Data Science", 15],
  ["COMS7063A", "Statistical Foundations of Data Science", 15],
  ["COMS7065A", "Computational Intelligence", 15],
  ["COMS7066A", "Natural Language and Technology", 15],
  ["COMS7069A", "Advanced Topics in Robotics", 15],
  ["COMS7071A", "Reinforcement Learning", 15],
  ["COMS7077A", "Cybersecurity", 15],
  ["COMS7078A", "Cryptography", 15],
  ["COMS7081A", "Computational Neuroscience", 15],
];

// The COMS7 module matching each COMS4 honours module by topic — Wits
// bars registering for the COMS7 module when its COMS4 equivalent was
// already taken, so the MSc elective pool is filtered per student.
const COMS4_TO_COMS7 = {
  COMS4030A: "COMS7047A",
  COMS4033A: "COMS7044A",
  COMS4036A: "COMS7050A",
  COMS4040A: "COMS7045A",
  COMS4043A: "COMS7048A",
  COMS4045A: "COMS7049A",
  COMS4047A: "COMS7053A",
  COMS4054A: "COMS7066A",
  COMS4055A: "COMS7058A",
  COMS4060A: "COMS7056A",
  COMS4061A: "COMS7071A",
  COMS4064A: "COMS7077A",
  COMS4065A: "COMS7078A",
  COMS4069A: "COMS7065A",
  COMS4070A: "COMS7081A",
};

// BScHons CAM: every module is fixed — six compulsory, the research
// project, research methods, and both electives — 132 points to graduate.
const HONS_CAM_ROWS = [
  ["APPM4054A", "Mathematical Modelling", 12],
  ["APPM4055A", "Partial Differential Equations", 12],
  ["APPM4056A", "Symmetry Methods for Differential Equations", 12],
  ["APPM4057A", "Computational Differential Equations", 12],
  ["APPM4059A", "Continuum Mechanics", 12],
  ["APPM4061A", "Studies in Applied Mathematics", 12],
  ["APPM4064A", "Optimal Control Theory", 12],
  ["APPM4065A", "Global Optimization", 12],
  ["APPM4076A", "Research Project", 24],
  ["COMS4057A", "Introduction to Research Methods", 12],
];

// Dissertation-only degrees register a research row, not modules — the
// course code column is left blank rather than inventing a code.
const MSC_CAM =
  "Master of Science in the field of Computational and Applied Mathematics (Full-Time) | Qualification ID: 5031";
const PHD_CS =
  "Doctor of Philosophy in the field of Computer Science (Full-Time) | Qualification ID: 5032";

// Mark bands per level, wide enough for variety but keeping each level's
// entry gates credible: CS honours needs a 70% undergraduate aggregate,
// CAM honours 60%, the MSc 65% in honours.
const BANDS = {
  third_year: [56, 82],
  honours: [68, 85],
  masters: [70, 86],
  phd: [72, 88],
};

function pickN(rng, pool, n) {
  const copy = [...pool];
  const picks = [];
  while (picks.length < n && copy.length > 0) {
    picks.push(copy.splice(Math.floor(rng() * copy.length), 1)[0]);
  }
  return picks;
}

function buildBatchStudent(cfg) {
  const rng = rngFor(`${cfg.id}:marks`);
  const band = BANDS[cfg.level];
  const draw = () => band[0] + Math.round(rng() * (band[1] - band[0]));
  const byCode = (a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
  const yearOf = (year, study, programme, rows, inProgress, nqf) => ({
    year: String(year),
    study,
    programme,
    ...(nqf ? { nqf } : {}),
    outcome: inProgress ? "***" : PROCEED,
    rows: [...rows]
      .sort(byCode)
      .map(([c, n, cr]) => [c, n, inProgress ? null : draw(), cr]),
  });

  const y1 = (year) =>
    yearOf(year, 1, BSC, [...COMS1, ...MATH1, ...CAM1], false);
  const y2cs = (year) =>
    yearOf(year, 2, BSC, [...COMS2, ...MATH2, ...CAM2], false);
  const y2cam = (year) =>
    yearOf(year, 2, BSC, [...CAM2, ...MATH2, ...CAM2_SLOT], false);
  const y3cs = (year, done) => yearOf(year, 3, BSC, COMS3, !done);
  const y3cam = (year, done) =>
    yearOf(year, 3, BSC, [...CAM3, ...CAM3_SLOT], !done);
  const honsCs = (year, study, inProgress, picks) =>
    yearOf(year, study, HONS_CS, [...HONS_CS_CORE, ...picks], inProgress, 8);
  const mscCs = (year, study, inProgress, honsPicks) => {
    const blocked = new Set(
      honsPicks.map((e) => COMS4_TO_COMS7[e[0]]).filter(Boolean),
    );
    const pool = MSC_CS_ELECTIVES.filter((e) => !blocked.has(e[0]));
    return yearOf(
      year,
      study,
      MSC_CS,
      [...MSC_CS_CORE, ...pickN(rng, pool, 5)],
      inProgress,
      9,
    );
  };

  const y3done = cfg.level !== "third_year";
  let years;
  if (cfg.major === "cam") {
    if (cfg.level === "masters") {
      years = [
        y1(2022),
        y2cam(2023),
        y3cam(2024, true),
        yearOf(2025, 4, HONS_CAM, HONS_CAM_ROWS, false, 8),
        yearOf(
          2026,
          5,
          MSC_CAM,
          [
            [
              "",
              "Master's Dissertation: Computational and Applied Mathematics",
              null,
            ],
          ],
          true,
          9,
        ),
      ];
    } else {
      const start = cfg.level === "honours" ? 2023 : 2024;
      years = [y1(start), y2cam(start + 1), y3cam(start + 2, y3done)];
      if (cfg.level === "honours") {
        years.push(yearOf(2026, 4, HONS_CAM, HONS_CAM_ROWS, true, 8));
      }
    }
  } else if (cfg.level === "phd") {
    const honsPicks = pickN(rng, HONS_CS_ELECTIVES, 7);
    years = [
      y1(2020),
      y2cs(2021),
      y3cs(2022, true),
      honsCs(2023, 4, false, honsPicks),
      mscCs(2024, 5, false, honsPicks),
      yearOf(
        2025,
        6,
        MSC_CS,
        [["COMS7009A", "Research Report: Computer Science", 75]],
        false,
        9,
      ),
      yearOf(
        2026,
        7,
        PHD_CS,
        [["", "Doctoral Dissertation: Computer Science", null]],
        true,
        10,
      ),
    ];
  } else if (cfg.level === "masters") {
    // Two live shapes for a masters student today: mid-research-report
    // (coursework done) or mid-coursework. Seeded so the pick is stable.
    const researchShape = rngFor(`${cfg.id}:shape`)() < 0.5;
    const honsPicks = pickN(rng, HONS_CS_ELECTIVES, 7);
    years = researchShape
      ? [
          y1(2021),
          y2cs(2022),
          y3cs(2023, true),
          honsCs(2024, 4, false, honsPicks),
          mscCs(2025, 5, false, honsPicks),
          yearOf(
            2026,
            6,
            MSC_CS,
            [["COMS7009A", "Research Report: Computer Science", null]],
            true,
            9,
          ),
        ]
      : [
          y1(2022),
          y2cs(2023),
          y3cs(2024, true),
          honsCs(2025, 4, false, honsPicks),
          mscCs(2026, 5, true, honsPicks),
        ];
  } else {
    const start = cfg.level === "honours" ? 2023 : 2024;
    years = [y1(start), y2cs(start + 1), y3cs(start + 2, y3done)];
    if (cfg.level === "honours") {
      years.push(honsCs(2026, 4, true, pickN(rng, HONS_CS_ELECTIVES, 7)));
    }
  }

  // Anchor the courses they applied to tutor/volunteer for, with the mark
  // on the application — whatever its status.
  const anchorParts = [];
  for (const [dbCode, mark] of Object.entries(cfg.anchors ?? {})) {
    const code = /A$/i.test(dbCode)
      ? dbCode.toUpperCase()
      : `${dbCode.toUpperCase()}A`;
    const row = years.flatMap((y) => y.rows).find((r) => r[0] === code);
    if (!row) {
      throw new Error(
        `${cfg.name}: anchor ${code} is not in the ${cfg.major} curriculum`,
      );
    }
    row[2] = mark;
    anchorParts.push(`${code} ${mark}`);
  }

  return {
    name: cfg.name,
    id: String(cfg.id),
    issued: "11 October 2026",
    markBand: band,
    anchor: anchorParts.length
      ? `${anchorParts.join(", ")} — real application marks, so transcript and applications agree`
      : "no applications on record — marks drawn from the level's band",
    years,
  };
}

// The live roster (checked against the database 11 October 2026). Ids are
// the student number from the account email where one exists, otherwise
// invented; comments flag every defaulted level.
const BATCH = [
  // Tutors — levels from tutors.academic_level unless commented.
  {
    key: "alice",
    name: "Alice Wonder",
    id: "2461088",
    level: "honours",
    major: "cs",
  },
  {
    key: "arti",
    name: "arti",
    id: "2530476",
    level: "third_year",
    major: "cs",
    anchors: { COMS1018A: 75 },
  }, // rejected — still his claimed mark
  {
    key: "burheni",
    name: "Burheni",
    id: "2497513",
    level: "masters",
    major: "cam",
    anchors: { APPM2023: 68 },
  },
  {
    key: "daniel",
    name: "Daniel",
    id: "2527401",
    level: "third_year",
    major: "cs",
  },
  {
    key: "dorsa",
    name: "Dorsa Shahrokh",
    id: "2556983",
    level: "third_year",
    major: "cs",
  },
  {
    key: "husain",
    name: "Husain Battey",
    id: "2595252",
    level: "third_year",
    major: "cs",
  }, // no tutors row — defaults to third_year
  {
    key: "janedoe",
    name: "Jane Doe",
    id: "2473902",
    level: "masters",
    major: "cs",
  },
  {
    key: "jude",
    name: "Jude",
    id: "2586417",
    level: "third_year",
    major: "cs",
  },
  {
    key: "logan",
    name: "Logan",
    id: "2509354",
    level: "third_year",
    major: "cs",
  },
  {
    key: "lungani",
    name: "Lungani Shezi",
    id: "2672899",
    level: "third_year",
    major: "cam",
    anchors: { APPM2025: 99 },
  },
  {
    key: "mandlatut",
    name: "Mandla-Tut Msibi",
    id: "2458126",
    level: "phd",
    major: "cs",
    anchors: { COMS1018A: 80, COMS3011A: 80, APPM2025: 80 },
  },
  {
    key: "matthew",
    name: "Matthew",
    id: "2522769",
    level: "honours",
    major: "cs",
  },
  {
    key: "matthewp",
    name: "Matthew Purkiss",
    id: "2697424",
    level: "third_year",
    major: "cs",
  },
  {
    key: "mkateko",
    name: "Mkateko Chauke",
    id: "2631850",
    level: "third_year",
    major: "cam",
    anchors: { APPM2025: 78, APPM2021A: 87 },
  }, // the casandram0520 account; her other two accounts are duplicates with no applications
  { key: "ouma", name: "Ouma", id: "2576043", level: "honours", major: "cs" },
  {
    key: "prince",
    name: "Prince",
    id: "2486975",
    level: "honours",
    major: "cs",
  },
  {
    key: "rassie",
    name: "Rassie",
    id: "467477",
    level: "third_year",
    major: "cs",
  }, // no tutors row — defaults to third_year
  {
    key: "shazana",
    name: "Shazana Badloo",
    id: "2665974",
    level: "third_year",
    major: "cs",
  },
  {
    key: "tggonz",
    name: "TGgonz",
    id: "2549208",
    level: "third_year",
    major: "cs",
  }, // academic_level null in the DB — defaults to third_year
  {
    key: "tracy",
    name: "Tracy Smith",
    id: "2501186",
    level: "honours",
    major: "cs",
    anchors: { COMS3011A: 79 },
  },
  {
    key: "tagonad",
    name: "Tagona Danha",
    id: "2808494",
    level: "honours",
    major: "cam",
    anchors: { APPM2023: 89 },
  },

  // Volunteers — role volunteer, or student accounts with volunteer
  // applications. No tutors rows exist, so third_year is the default;
  // a Level III application forces honours (a completed third year).
  {
    key: "calvin",
    name: "Calvin",
    id: "2593724",
    level: "third_year",
    major: "cs",
  },
  {
    key: "casandra",
    name: "Casandra Chauke",
    id: "2620479",
    level: "third_year",
    major: "cs",
  },
  {
    key: "owethu",
    name: "Owethu Dlamini",
    id: "23546720",
    level: "third_year",
    major: "cs",
    anchors: { COMS1018A: 80 },
  },
  {
    key: "rowan",
    name: "Rowan",
    id: "2578310",
    level: "third_year",
    major: "cs",
  }, // only a test-course application
  {
    key: "mina",
    name: "mina",
    id: "2649375",
    level: "third_year",
    major: "cam",
    anchors: { APPM2021: 78, COMS1016A: 67 },
  },
  {
    key: "mandlastu",
    name: "Mandla",
    id: "2638842",
    level: "third_year",
    major: "cs",
    anchors: { COMS2002A: 76, COMS1016A: 76, APPM2025: 82 },
  },
  {
    key: "mutsawashe",
    name: "Mutsawashe Njowa",
    id: "2651487",
    level: "third_year",
    major: "cam",
    anchors: { APPM2023: 87, APPM2025: 75 },
  },
  {
    key: "peter",
    name: "Peter",
    id: "2560831",
    level: "third_year",
    major: "cam",
    anchors: { APPM2021: 89 },
  },
  {
    key: "quan",
    name: "quan",
    id: "2610573",
    level: "honours",
    major: "cs",
    anchors: { COMS1016A: 86, COMS3011A: 93 },
  }, // COMS3011A application implies a completed third year
  {
    key: "max",
    name: "Max",
    id: "2587064",
    level: "third_year",
    major: "cam",
    anchors: { APPM2023: 87 },
  },
  {
    key: "hakunene",
    name: "Hakunene",
    id: "2604169",
    level: "third_year",
    major: "cam",
    anchors: { APPM2023: 78 },
  },
];

for (const cfg of BATCH) {
  STUDENTS[cfg.key] = buildBatchStudent(cfg);
}

// Each student's Year 1 has one free elective slot: a random course from
// the Level I pool, its mark drawn from the student's own band, inserted in
// code order alongside the compulsory rows. Seeded by student ID so the
// pick is unique per student and stable across regenerations.
for (const student of Object.values(STUDENTS)) {
  const rng = rngFor(student.id);
  const pick = LEVEL_I_ELECTIVES[Math.floor(rng() * LEVEL_I_ELECTIVES.length)];
  const [lo, hi] = student.markBand;
  const mark = lo + Math.round(rng() * (hi - lo));
  const y1 = student.years.find((yr) => yr.study === 1);
  y1.rows.push([pick.code, pick.name, mark, pick.credit]);
  y1.rows.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

// ---------- tiny PDF painter (base-14 Helvetica, no dependencies) ----------

// Standard AFM widths per mille for ASCII 32-126; Oblique shares regular.
const W_REG = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278,
  278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584,
  584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556,
  833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278,
  278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222,
  500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500,
  500, 334, 260, 334, 584,
];
const W_BOLD = [
  278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278,
  278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584,
  584, 611, 975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611,
  833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333,
  278, 333, 584, 556, 333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278,
  556, 278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556,
  500, 389, 280, 389, 584,
];
function textWidth(str, size, bold) {
  const table = bold ? W_BOLD : W_REG;
  let w = 0;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i) - 32;
    w += c >= 0 && c < table.length ? table[c] : 556;
  }
  return (w / 1000) * size;
}

const GRAY = [0.42, 0.42, 0.42];
const DARK = [0.13, 0.13, 0.13];
const RIGHT = 539; // right text edge (A4 595pt, 56pt margins)

function esc(s) {
  return s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

class Painter {
  constructor() {
    this.ops = [];
  }
  txt(s, x, y, { f = "F1", size = 9, color = DARK, align = "left" } = {}) {
    const tx = align === "right" ? x - textWidth(s, size, f === "F2") : x;
    this.ops.push(
      `BT /${f} ${size} Tf ${color.join(" ")} rg 1 0 0 1 ${tx.toFixed(2)} ${y.toFixed(2)} Tm (${esc(s)}) Tj ET`,
    );
  }
  line(x1, y1, x2, y2, { color = [0.85, 0.85, 0.85], w = 0.6 } = {}) {
    this.ops.push(`${color.join(" ")} RG ${w} w ${x1} ${y1} m ${x2} ${y2} l S`);
  }
  stream() {
    return this.ops.join("\n");
  }
}

function wrap(text, size, maxWidth) {
  const words = text.split(" ");
  const lines = [];
  let line = "";
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (textWidth(candidate, size, false) <= maxWidth) {
      line = candidate;
    } else {
      if (line) lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function pageHeader(p, student) {
  p.txt("Academic Transcript", 56, 792, { f: "F2", size: 20 });
  p.txt("Student Records", 56, 776, { f: "F1", size: 10.5, color: GRAY });
  p.txt("Issued", RIGHT, 792, {
    f: "F2",
    size: 7.5,
    color: GRAY,
    align: "right",
  });
  p.txt(student.issued, RIGHT, 780, { f: "F1", size: 9.5, align: "right" });
  p.line(56, 764, RIGHT, 764, { color: [0.6, 0.6, 0.6], w: 0.8 });
  const fields = [
    ["Student name", student.name],
    ["Student ID", student.id],
    ["Date", student.issued],
  ];
  fields.forEach(([label, value], i) => {
    const x = 56 + i * 180;
    p.txt(label, x, 744, { f: "F2", size: 7.5, color: GRAY });
    p.txt(value, x, 728, { f: "F1", size: 11.5 });
  });
  p.txt(
    "This sample transcript shows the registration record of the student named above.",
    56,
    706,
    { f: "F3", size: 8.5, color: GRAY },
  );
  p.line(56, 694, RIGHT, 694);
}

// One registration-year block. Returns the y of the OUTCOME baseline.
function yearBlock(p, year, y) {
  p.txt(year.year, 56, y, { f: "F2", size: 13 });
  p.txt(`Year of Study ${year.study}`, RIGHT, y + 1, {
    f: "F1",
    size: 10,
    color: GRAY,
    align: "right",
  });
  p.txt(year.programme, 56, y - 14, { f: "F3", size: 8.5, color: GRAY });

  // Two-line column heads, the way the sample wraps them.
  const h1 = y - 34;
  const h2 = h1 - 9;
  const head = { f: "F2", size: 7.5, color: [0.35, 0.35, 0.35] };
  p.txt("Code", 56, h1, head);
  p.txt("Course", 132, h1, head);
  p.txt("Final", 415, h1, { ...head, align: "right" });
  p.txt("mark", 415, h2, { ...head, align: "right" });
  p.txt("Grade", 458, h1, { ...head, align: "right" });
  p.txt("Result", 460, h1, head);
  p.txt("NQF", 508, h1, { ...head, align: "right" });
  p.txt("level", 508, h2, { ...head, align: "right" });
  p.txt("NQF", RIGHT, h1, { ...head, align: "right" });
  p.txt("credit", RIGHT, h2, { ...head, align: "right" });
  p.line(56, h2 - 6, RIGHT, h2 - 6, { color: [0.6, 0.6, 0.6], w: 0.8 });

  let ry = h2 - 21;
  year.rows.forEach((row, i) => {
    const [code, course, mark, credit] = row;
    p.txt(code, 56, ry, { size: 9 });
    p.txt(course, 132, ry, { size: 9 });
    if (mark == null) {
      p.txt("***", 415, ry, { size: 9, align: "right" });
      p.txt("***", 458, ry, { size: 9, align: "right" });
      p.txt("***", 460, ry, { size: 9 });
    } else {
      p.txt(String(mark), 415, ry, { size: 9, align: "right" });
      p.txt(gradeFor(mark), 458, ry, { size: 9, align: "right" });
      p.txt(mark >= 50 ? "PASS" : "FAIL", 460, ry, { size: 9 });
      if (mark >= 50 && credit != null) {
        p.txt(String(credit), RIGHT, ry, { size: 9, align: "right" });
      }
    }
    p.txt(String(year.nqf ?? year.study + 4), 508, ry, {
      size: 9,
      align: "right",
    });
    if (i < year.rows.length - 1) {
      p.line(56, ry - 8, RIGHT, ry - 8);
    }
    ry -= 15.5;
  });

  const outcomeY = ry - 10;
  p.txt(`OUTCOME: ${year.outcome}`, 56, outcomeY, { f: "F2", size: 9.5 });
  return outcomeY;
}

function pageFooter(p, n, total) {
  p.line(56, 64, RIGHT, 64);
  p.txt("SAMPLE  |  Sample transcript  |  Fictional data", 56, 50, {
    f: "F2",
    size: 8,
    color: GRAY,
  });
  p.txt(`Page ${n} of ${total}`, RIGHT, 50, {
    f: "F1",
    size: 8,
    color: GRAY,
    align: "right",
  });
}

function buildPdf(streams) {
  const chunks = [];
  const offsets = [];
  let len = 0;
  const push = (s) => {
    chunks.push(Buffer.from(s, "latin1"));
    len += Buffer.byteLength(s, "latin1");
  };
  push("%PDF-1.4\n");
  const S = streams.length;
  const fontId = { F1: 3 + 2 * S, F2: 4 + 2 * S, F3: 5 + 2 * S };
  const kids = streams.map((_, i) => `${3 + 2 * i} 0 R`).join(" ");
  const addObj = (id, body) => {
    offsets[id] = len;
    push(`${id} 0 obj\n${body}\nendobj\n`);
  };
  addObj(1, "<< /Type /Catalog /Pages 2 0 R >>");
  addObj(2, `<< /Type /Pages /Kids [${kids}] /Count ${S} >>`);
  streams.forEach((s, i) => {
    addObj(
      3 + 2 * i,
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 ${fontId.F1} 0 R /F2 ${fontId.F2} 0 R /F3 ${fontId.F3} 0 R >> >> /Contents ${4 + 2 * i} 0 R >>`,
    );
    addObj(
      4 + 2 * i,
      `<< /Length ${Buffer.byteLength(s, "latin1")} >>\nstream\n${s}\nendstream`,
    );
  });
  addObj(
    fontId.F1,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
  );
  addObj(
    fontId.F2,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>",
  );
  addObj(
    fontId.F3,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Oblique /Encoding /WinAnsiEncoding >>",
  );
  const xrefStart = len;
  const total = 2 + 2 * S + 3;
  let xref = `xref\n0 ${total + 1}\n0000000000 65535 f \n`;
  for (let id = 1; id <= total; id++) {
    xref += `${String(offsets[id]).padStart(10, "0")} 00000 n \n`;
  }
  xref += `trailer\n<< /Size ${total + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  push(xref);
  return Buffer.concat(chunks);
}

// ---------- assemble pages for one student ----------

// Rough height of a year block, from its title baseline to below the OUTCOME
// line — enough for the greedy paginator to pack pages without overflow.
const blockHeight = (year) => 80 + year.rows.length * 15.5;

function assemble(student) {
  const pages = [];
  let p = new Painter();
  pageHeader(p, student);
  pages.push(p);
  let y = 668; // content top on page 1, below the header

  for (const year of student.years) {
    if (y - blockHeight(year) < 92) {
      p = new Painter();
      pages.push(p);
      y = 772;
    }
    y = yearBlock(p, year, y) - 34;
  }

  // Credit summary + notes; start a fresh page if the tail won't fit.
  const completed = student.years.filter((yr) =>
    yr.rows.some(([, , mark]) => mark != null),
  );
  const summaryHeight = 200 + completed.length * 16;
  if (y - summaryHeight < 92) {
    p = new Painter();
    pages.push(p);
    y = 772;
  }

  const creditsPerYear = completed.map((yr) => ({
    year: yr.year,
    credits: yr.rows.reduce(
      (sum, [, , mark, credit]) => sum + (mark >= 50 && credit ? credit : 0),
      0,
    ),
  }));
  const totalCredits = creditsPerYear.reduce((s, y2) => s + y2.credits, 0);

  let sy = y;
  p.txt("Credit summary", 56, sy, { f: "F2", size: 11 });
  sy -= 18;
  p.txt("Year", 56, sy, { f: "F2", size: 7.5, color: [0.35, 0.35, 0.35] });
  p.txt("Credits earned", RIGHT, sy, {
    f: "F2",
    size: 7.5,
    color: [0.35, 0.35, 0.35],
    align: "right",
  });
  p.line(56, sy - 6, RIGHT, sy - 6, { color: [0.6, 0.6, 0.6], w: 0.8 });
  sy -= 21;
  creditsPerYear.forEach((row, i) => {
    p.txt(row.year, 56, sy, { size: 9 });
    p.txt(String(row.credits), RIGHT, sy, { size: 9, align: "right" });
    if (i < creditsPerYear.length - 1) {
      p.line(56, sy - 8, RIGHT, sy - 8);
    }
    sy -= 15.5;
  });
  p.line(56, sy - 4, RIGHT, sy - 4, { color: [0.6, 0.6, 0.6], w: 0.8 });
  sy -= 21;
  p.txt("Total to date", 56, sy, { f: "F2", size: 9 });
  p.txt(String(totalCredits), RIGHT, sy, { f: "F2", size: 9, align: "right" });

  sy -= 34;
  p.txt("Notes", 56, sy, { f: "F2", size: 11 });
  sy -= 18;
  const notes = [
    "This is a sample transcript with fictional data. It is not an official document and does not describe a real student or institution.",
    "Course codes, marks, and credits are invented for demonstration purposes.",
  ];
  for (const note of notes) {
    for (const line of wrap(note, 8.5, RIGHT - 56)) {
      p.txt(line, 56, sy, { f: "F3", size: 8.5, color: GRAY });
      sy -= 12;
    }
    sy -= 4;
  }

  pages.forEach((pg, i) => pageFooter(pg, i + 1, pages.length));
  return {
    streams: pages.map((pg) => pg.stream()),
    creditsPerYear,
    totalCredits,
  };
}

// ---------- write + verify ----------

const outDir = path.join(__dirname, "generated-transcripts");
fs.mkdirSync(outDir, { recursive: true });

const requested = process.argv.slice(2);
const keys = requested.length > 0 ? requested : Object.keys(STUDENTS);
let failures = 0;

for (const key of keys) {
  const student = STUDENTS[key];
  if (!student) {
    console.log(
      `unknown student key: ${key} (known: ${Object.keys(STUDENTS).join(", ")})`,
    );
    failures++;
    continue;
  }
  const { streams, creditsPerYear, totalCredits } = assemble(student);
  const outPath = path.join(
    outDir,
    `${student.name.replace(/^((?:Mr\.|Ms\.|Mrs\.|Dr\.)\s+)?/, "").replace(/\s+/g, "_")}.pdf`,
  );
  const pdf = buildPdf(streams);
  fs.writeFileSync(outPath, pdf);

  // Text-level verification: re-extract every Tj string from the written
  // file and check the rows, grades and credit arithmetic came out right.
  const runs = [
    ...pdf.toString("latin1").matchAll(/\((?:\\.|[^()\\])*\)\s*Tj/g),
  ].map((m) =>
    m[0].slice(1, m[0].lastIndexOf(")")).replace(/\\([()\\])/g, "$1"),
  );
  const check = (ok, label) => {
    if (!ok) {
      failures++;
      console.log(`FAIL [${key}]: ${label}`);
    }
  };
  for (const yr of student.years) {
    for (const [code, , mark] of yr.rows) {
      if (code) check(runs.includes(code), `${code} present`);
      if (mark != null) {
        check(runs.includes(String(mark)), `${code} mark ${mark} present`);
        check(runs.includes(gradeFor(mark)), `${code} grade present`);
        if (mark >= 50) check(runs.includes("PASS"), `${code} PASS present`);
      }
    }
  }
  check(runs.includes(student.name), "student name present");
  check(runs.includes(student.id), "student ID present");
  check(runs.includes(String(totalCredits)), "total credits present");
  streams.forEach((_, i) => {
    check(
      runs.includes(`Page ${i + 1} of ${streams.length}`),
      `page number ${i + 1} present`,
    );
  });

  console.log(
    `wrote ${outPath} (${pdf.length} bytes, ${streams.length} pages)`,
  );
  for (const row of creditsPerYear) {
    console.log(`  ${row.year}: ${row.credits} credits`);
  }
  console.log(`  Total to date: ${totalCredits}`);
  console.log(`  ${student.anchor}`);
}

console.log(failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECKS FAILED`);
process.exit(failures === 0 ? 0 : 1);

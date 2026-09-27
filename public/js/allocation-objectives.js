// Multi-objective balancing for tutor allocation.
//
// Applicants for a course are pulled apart by objectives that fight each
// other: the strongest tutor on paper is often the one already carrying the
// most hours, and the tutor with the most spare hours is often not the
// strongest. This module normalises each objective to 0-1, blends them with
// a named preset of weights into a single 0-100 score, and flags where the
// preset's ordering pulls against a merit-first ordering (Pareto domination
// and rank-vs-merit tension).
//
// It is deliberately dependency-free and UMD-wrapped so the exact same code
// runs in two places: required by server/routes/tutorApplications.js
// (Node/CommonJS) and loaded as a plain <script> on the organiser board
// (browser global `AllocationObjectives`).
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.AllocationObjectives = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  // The five objectives every applicant is measured on, in canonical
  // order. `label`/`hint` drive the board's objective bars.
  var OBJECTIVES = {
    merit: {
      label: "Merit",
      hint: "mark in the course",
    },
    availability: {
      label: "Availability",
      hint: "free at the tutorial time",
    },
    clashFree: {
      label: "Timetable fit",
      hint: "no clash with other commitments",
    },
    seniority: {
      label: "Seniority",
      hint: "academic level",
    },
    headroom: {
      label: "Spare hours",
      hint: "remaining weekly-hour capacity",
    },
  };

  var OBJECTIVE_NAMES = Object.keys(OBJECTIVES);

  // The highest academic_level rank the system knows (LEVEL_RANK's "phd"),
  // used to normalise seniority to 0-1.
  var MAX_ACADEMIC_RANK = 6;

  // Named weightings for blending the objectives. The `merit` preset's
  // weights are the legacy applicant-ranking point scale (mark 100,
  // availability 20, clash-free 20, level 12, spare hours 10) expressed on
  // normalised 0-1 objectives, so its ordering matches the old ranking
  // exactly — only the reported score is rescaled to 0-100.
  var PRESETS = {
    merit: {
      label: "Merit",
      description:
        "Merit first: strongest applicants on paper lead, as before.",
      weights: {
        merit: 100,
        availability: 20,
        clashFree: 20,
        seniority: 12,
        headroom: 10,
      },
    },
    balanced: {
      label: "Balanced",
      description:
        "Balanced: every objective weighs equally, so no single one dominates.",
      weights: {
        merit: 20,
        availability: 20,
        clashFree: 20,
        seniority: 20,
        headroom: 20,
      },
    },
    fairness: {
      label: "Fair hours",
      description:
        "Fair hours: favours tutors with the most spare weekly capacity, so work spreads evenly instead of stacking on the strongest.",
      weights: {
        merit: 20,
        availability: 20,
        clashFree: 20,
        seniority: 20,
        headroom: 80,
      },
    },
  };

  var PRESET_NAMES = Object.keys(PRESETS);

  function clamp01(value) {
    if (!isFinite(value)) return 0;
    return Math.min(Math.max(value, 0), 1);
  }

  function round2(value) {
    return Number(Number(value).toFixed(2));
  }

  // Normalises one applicant's ranking summary (the same fields the
  // applicant-ranking route already computes: mark, available,
  // timetableClash, academicRank, weeklyHourCap, currentAssignedHours) into
  // a 0-1 score per objective. Out-of-range inputs clamp, mirroring how the
  // old formula treated availability/clash as all-or-nothing bonuses.
  function objectiveScores(summary) {
    var mark = clamp01((Number(summary.mark) || 0) / 100);
    var academicRank = Number(summary.academicRank) || 0;
    var cap =
      summary.weeklyHourCap == null ? null : Number(summary.weeklyHourCap);
    var currentAssignedHours = Number(summary.currentAssignedHours) || 0;

    // No cap set means no known limit, so treat the tutor as fully spare —
    // exactly what the legacy score's full-points branch did.
    var headroom;
    if (cap == null) {
      headroom = 1;
    } else if (cap <= 0) {
      headroom = 0;
    } else {
      headroom = clamp01((cap - currentAssignedHours) / cap);
    }

    return {
      merit: mark,
      availability: summary.available === true ? 1 : 0,
      clashFree: summary.timetableClash ? 0 : 1,
      seniority: clamp01(academicRank / MAX_ACADEMIC_RANK),
      headroom: headroom,
    };
  }

  function presetWeights(presetName) {
    if (!Object.prototype.hasOwnProperty.call(PRESETS, presetName)) {
      throw new Error(
        'Unknown allocation preset "' +
          presetName +
          '". Valid presets: ' +
          PRESET_NAMES.join(", ") +
          ".",
      );
    }
    return PRESETS[presetName].weights;
  }

  // Blends normalised objectives into a 0-100 score. Weights are relative,
  // so a preset's weights only need to express proportions.
  function weightedScore(objectives, weights) {
    var total = 0;
    var max = 0;

    OBJECTIVE_NAMES.forEach(function (name) {
      var weight = Number(weights[name]) || 0;
      total += weight * clamp01(Number(objectives[name]) || 0);
      max += weight;
    });

    if (max <= 0) return 0;
    return round2((total / max) * 100);
  }

  // The route's historical comparator: score first, then mark, then
  // availability, clash-freedom and academic level. Shared by every preset
  // so tie-breaking behaviour is unchanged.
  function makeComparator(scoreOf) {
    return function (a, b) {
      var scoreA = scoreOf(a);
      var scoreB = scoreOf(b);

      if (scoreA !== scoreB) return scoreB - scoreA;
      if (a.facts.mark !== b.facts.mark) return b.facts.mark - a.facts.mark;
      if (a.facts.available !== b.facts.available)
        return a.facts.available ? -1 : 1;
      if (a.facts.timetableClash !== b.facts.timetableClash)
        return a.facts.timetableClash ? 1 : -1;
      if (a.facts.academicRank !== b.facts.academicRank)
        return b.facts.academicRank - a.facts.academicRank;
      return 0;
    };
  }

  // Is `entry` dominated by any other entry? Domination is weight-independent:
  // someone else is at least as good on every objective and strictly better
  // on at least one. Exact ties never dominate each other.
  function isDominated(entry, entries) {
    return entries.some(function (other) {
      if (other === entry) return false;

      var strictlyBetter = false;

      for (var i = 0; i < OBJECTIVE_NAMES.length; i++) {
        var name = OBJECTIVE_NAMES[i];
        if (other.objectives[name] < entry.objectives[name]) return false;
        if (other.objectives[name] > entry.objectives[name])
          strictlyBetter = true;
      }

      return strictlyBetter;
    });
  }

  // Ranks applicants under a named preset. `summaries` is an array of
  // ranking summaries (see objectiveScores); the result is one entry per
  // summary, best-first, carrying the normalised objectives, the 0-100
  // blended score, both ranks (under the preset and under merit-first),
  // the Pareto-dominated flag, and — when the preset pulls against merit —
  // a note explaining the tension.
  function balance(summaries, presetName) {
    var weights = presetWeights(presetName);

    var entries = (summaries || []).map(function (summary, index) {
      var objectives = objectiveScores(summary);
      return {
        index: index,
        objectives: objectives,
        score: weightedScore(objectives, weights),
        meritScore: weightedScore(objectives, PRESETS.merit.weights),
        facts: {
          mark: Number(summary.mark) || 0,
          available: summary.available === true,
          timetableClash: summary.timetableClash === true,
          academicRank: Number(summary.academicRank) || 0,
        },
      };
    });

    var presetOrder = entries.slice().sort(function (a, b) {
      return makeComparator(function (entry) {
        return entry.score;
      })(a, b);
    });

    var meritOrder = entries.slice().sort(function (a, b) {
      return makeComparator(function (entry) {
        return entry.meritScore;
      })(a, b);
    });

    presetOrder.forEach(function (entry, position) {
      entry.rank = position + 1;
    });
    meritOrder.forEach(function (entry, position) {
      entry.meritRank = position + 1;
    });

    presetOrder.forEach(function (entry) {
      entry.dominated = isDominated(entry, entries);
      entry.note =
        entry.rank === entry.meritRank
          ? null
          : "Merit-first would rank them #" +
            entry.meritRank +
            "; this balance ranks them #" +
            entry.rank +
            ".";
    });

    return presetOrder.map(function (entry) {
      return {
        index: entry.index,
        objectives: {
          merit: round2(entry.objectives.merit),
          availability: round2(entry.objectives.availability),
          clashFree: round2(entry.objectives.clashFree),
          seniority: round2(entry.objectives.seniority),
          headroom: round2(entry.objectives.headroom),
        },
        score: entry.score,
        rank: entry.rank,
        meritRank: entry.meritRank,
        dominated: entry.dominated,
        note: entry.note,
      };
    });
  }

  return {
    OBJECTIVES: OBJECTIVES,
    PRESETS: PRESETS,
    PRESET_NAMES: PRESET_NAMES,
    objectiveScores: objectiveScores,
    presetWeights: presetWeights,
    weightedScore: weightedScore,
    balance: balance,
  };
});

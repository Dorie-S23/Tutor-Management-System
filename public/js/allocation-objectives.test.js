// Unit tests for allocation-objectives.js — the shared multi-objective
// balancing module used by both the applicant-ranking API route and the
// organiser board's preset picker. Loaded here through its CommonJS branch;
// the browser (UMD) branch gets its own test at the bottom.
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");
const { pathToFileURL } = require("url");

const A = require("./allocation-objectives");

// The historical applicant-ranking formula from tutorApplications.js,
// reimplemented here so the merit preset can be proven to order applicants
// exactly like the ranking it replaced.
function legacyScore(s) {
  let score = s.mark || 0;
  if (s.available === true) score += 20;
  if (!s.timetableClash) score += 20;
  score += (s.academicRank || 0) * 2;
  const cap = s.weeklyHourCap;
  if (cap == null) score += 10;
  else if (cap > 0) {
    const remaining = Math.max(Number(cap) - (s.currentAssignedHours || 0), 0);
    score += Math.min(Math.max(remaining / Number(cap), 0), 1) * 10;
  }
  return score;
}

function legacyOrder(summaries) {
  return summaries
    .map((s, index) => ({ index, s }))
    .sort((a, b) => {
      const scoreA = legacyScore(a.s);
      const scoreB = legacyScore(b.s);
      if (scoreA !== scoreB) return scoreB - scoreA;
      if ((a.s.mark || 0) !== (b.s.mark || 0))
        return (b.s.mark || 0) - (a.s.mark || 0);
      if (a.s.available !== b.s.available) return a.s.available ? -1 : 1;
      if (a.s.timetableClash !== b.s.timetableClash)
        return a.s.timetableClash ? 1 : -1;
      if ((a.s.academicRank || 0) !== (b.s.academicRank || 0))
        return (b.s.academicRank || 0) - (a.s.academicRank || 0);
      return 0;
    })
    .map((entry) => entry.index);
}

// A spread of applicants exercising every objective and the interesting
// edge cases (no cap, cap 0, over cap, clashes, unavailable, level ties).
const POOL = [
  {
    mark: 90,
    available: true,
    timetableClash: false,
    academicRank: 3,
    weeklyHourCap: 10,
    currentAssignedHours: 8,
  },
  {
    mark: 75,
    available: true,
    timetableClash: false,
    academicRank: 2,
    weeklyHourCap: 10,
    currentAssignedHours: 0,
  },
  {
    mark: 70,
    available: false,
    timetableClash: true,
    academicRank: 2,
    weeklyHourCap: null,
    currentAssignedHours: 0,
  },
  {
    mark: 75,
    available: true,
    timetableClash: false,
    academicRank: 2,
    weeklyHourCap: 0,
    currentAssignedHours: 0,
  },
  {
    mark: 75,
    available: true,
    timetableClash: false,
    academicRank: 2,
    weeklyHourCap: 8,
    currentAssignedHours: 12,
  },
  {
    mark: 88,
    available: true,
    timetableClash: false,
    academicRank: 5,
    weeklyHourCap: 20,
    currentAssignedHours: 4,
  },
  {
    mark: 75,
    available: true,
    timetableClash: false,
    academicRank: 2,
    weeklyHourCap: 10,
    currentAssignedHours: 3,
  },
  {
    mark: 75,
    available: true,
    timetableClash: false,
    academicRank: 2,
    weeklyHourCap: 10,
    currentAssignedHours: 3,
  },
];

describe("objectiveScores", () => {
  test("normalises each objective from the ranking summary fields", () => {
    expect(
      A.objectiveScores({
        mark: 90,
        available: true,
        timetableClash: false,
        academicRank: 3,
        weeklyHourCap: 10,
        currentAssignedHours: 8,
      }),
    ).toEqual({
      merit: 0.9,
      availability: 1,
      clashFree: 1,
      seniority: 0.5,
      headroom: 0.2,
    });
  });

  test("clamps out-of-range marks and academic ranks", () => {
    const over = A.objectiveScores({
      mark: 150,
      available: true,
      timetableClash: false,
      academicRank: 9,
      weeklyHourCap: 10,
      currentAssignedHours: 0,
    });
    expect(over.merit).toBe(1);
    expect(over.seniority).toBe(1);

    const under = A.objectiveScores({
      mark: -5,
      available: false,
      timetableClash: true,
      academicRank: 0,
      weeklyHourCap: 10,
      currentAssignedHours: 0,
    });
    expect(under.merit).toBe(0);
    expect(under.seniority).toBe(0);
    expect(under.availability).toBe(0);
    expect(under.clashFree).toBe(0);
  });

  test("treats a missing cap as fully spare, a zero cap as none", () => {
    const noCap = A.objectiveScores({
      mark: 50,
      available: true,
      timetableClash: false,
      academicRank: 2,
      weeklyHourCap: null,
      currentAssignedHours: 0,
    });
    expect(noCap.headroom).toBe(1);

    const zeroCap = A.objectiveScores({
      mark: 50,
      available: true,
      timetableClash: false,
      academicRank: 2,
      weeklyHourCap: 0,
      currentAssignedHours: 0,
    });
    expect(zeroCap.headroom).toBe(0);
  });

  test("clamps headroom to 0 when already over the cap", () => {
    const over = A.objectiveScores({
      mark: 50,
      available: true,
      timetableClash: false,
      academicRank: 2,
      weeklyHourCap: 8,
      currentAssignedHours: 12,
    });
    expect(over.headroom).toBe(0);
  });
});

describe("weightedScore", () => {
  const objectives = {
    merit: 1,
    availability: 1,
    clashFree: 1,
    seniority: 1,
    headroom: 1,
  };

  test("scores a perfect applicant 100 and an empty one 0", () => {
    expect(A.weightedScore(objectives, A.PRESETS.merit.weights)).toBe(100);
    expect(
      A.weightedScore(
        { merit: 0, availability: 0, clashFree: 0, seniority: 0, headroom: 0 },
        A.PRESETS.merit.weights,
      ),
    ).toBe(0);
  });

  test("weights are relative, so scaling them changes nothing", () => {
    const half = {};
    Object.entries(A.PRESETS.merit.weights).forEach(([k, v]) => {
      half[k] = v / 2;
    });
    expect(A.weightedScore(objectives, half)).toBe(100);
  });
});

describe("balance", () => {
  test("merit preset orders applicants exactly like the legacy ranking formula", () => {
    const result = A.balance(POOL, "merit");
    const order = result.map((entry) => entry.index);
    expect(order).toEqual(legacyOrder(POOL));
  });

  test("merit preset also reproduces the legacy order for a pool of ties and edges", () => {
    // Identical applicants plus one differing only in academic level:
    // the legacy tie-breakers (mark, availability, clash, level) must hold.
    const ties = [
      {
        mark: 70,
        available: true,
        timetableClash: false,
        academicRank: 2,
        weeklyHourCap: 10,
        currentAssignedHours: 5,
      },
      {
        mark: 70,
        available: true,
        timetableClash: false,
        academicRank: 4,
        weeklyHourCap: 10,
        currentAssignedHours: 5,
      },
      {
        mark: 70,
        available: true,
        timetableClash: false,
        academicRank: 2,
        weeklyHourCap: 10,
        currentAssignedHours: 5,
      },
    ];
    const order = A.balance(ties, "merit").map((entry) => entry.index);
    expect(order).toEqual(legacyOrder(ties));
  });

  test("fairness preset lifts the fresher applicant over the stronger-but-loaded one", () => {
    const strongButLoaded = {
      mark: 90,
      available: true,
      timetableClash: false,
      academicRank: 3,
      weeklyHourCap: 10,
      currentAssignedHours: 8,
    };
    const fresh = {
      mark: 75,
      available: true,
      timetableClash: false,
      academicRank: 2,
      weeklyHourCap: 10,
      currentAssignedHours: 0,
    };

    const meritOrder = A.balance([strongButLoaded, fresh], "merit").map(
      (entry) => entry.index,
    );
    expect(meritOrder).toEqual([0, 1]);

    const fairness = A.balance([strongButLoaded, fresh], "fairness");
    expect(fairness.map((entry) => entry.index)).toEqual([1, 0]);

    // the tension is spelled out on both sides
    expect(fairness[0].note).toBe(
      "Merit-first would rank them #2; this balance ranks them #1.",
    );
    expect(fairness[1].note).toBe(
      "Merit-first would rank them #1; this balance ranks them #2.",
    );
  });

  test("balanced preset weighs every objective equally", () => {
    const meritHeavy = {
      mark: 100,
      available: true,
      timetableClash: false,
      academicRank: 6,
      weeklyHourCap: 10,
      currentAssignedHours: 10,
    };
    const even = {
      mark: 60,
      available: true,
      timetableClash: false,
      academicRank: 3,
      weeklyHourCap: 10,
      currentAssignedHours: 0,
    };

    // merit-heavy wins under merit (mark dominates), loses under balanced
    // (their only weak objective, headroom, counts as much as their mark).
    expect(A.balance([meritHeavy, even], "merit")[0].index).toBe(0);
    expect(A.balance([meritHeavy, even], "balanced")[0].index).toBe(1);
  });

  test("notes are null when the preset agrees with merit-first", () => {
    const result = A.balance(POOL, "merit");
    result.forEach((entry) => {
      expect(entry.note).toBeNull();
      expect(entry.rank).toBe(entry.meritRank);
    });
  });

  test("flags Pareto-dominated applicants, independent of any weighting", () => {
    const better = {
      mark: 80,
      available: true,
      timetableClash: false,
      academicRank: 4,
      weeklyHourCap: 10,
      currentAssignedHours: 0,
    };
    const worse = {
      mark: 70,
      available: false,
      timetableClash: true,
      academicRank: 2,
      weeklyHourCap: 10,
      currentAssignedHours: 9,
    };

    ["merit", "balanced", "fairness"].forEach((preset) => {
      const result = A.balance([better, worse], preset);
      expect(result.find((e) => e.index === 0).dominated).toBe(false);
      expect(result.find((e) => e.index === 1).dominated).toBe(true);
    });
  });

  test("identical applicants never dominate each other", () => {
    const twin = {
      mark: 75,
      available: true,
      timetableClash: false,
      academicRank: 2,
      weeklyHourCap: 10,
      currentAssignedHours: 0,
    };
    const result = A.balance([twin, { ...twin }], "balanced");
    expect(result[0].dominated).toBe(false);
    expect(result[1].dominated).toBe(false);
  });

  test("ranks are positions under the preset's ordering", () => {
    const result = A.balance(POOL, "fairness");
    expect(result.map((entry) => entry.rank)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  test("throws on an unknown preset", () => {
    expect(() => A.balance([], "nope")).toThrow(/Unknown allocation preset/);
    expect(() => A.presetWeights("nope")).toThrow(/Valid presets/);
  });

  test("objective values are rounded to 2 decimal places", () => {
    const result = A.balance(
      [
        {
          mark: 75,
          available: true,
          timetableClash: false,
          academicRank: 2,
          weeklyHourCap: 10,
          currentAssignedHours: 0,
        },
      ],
      "merit",
    );
    expect(result[0].objectives.seniority).toBe(0.33);
  });
});

describe("allocation-objectives.js in a browser (UMD branch)", () => {
  test("loads as window.AllocationObjectives from a plain <script> tag", () => {
    const source = fs.readFileSync(
      path.join(__dirname, "allocation-objectives.js"),
      "utf8",
    );

    const dom = new JSDOM("<!doctype html><html><body></body></html>", {
      runScripts: "dangerously",
    });
    const script = dom.window.document.createElement("script");
    script.textContent = `${source}\n//# sourceURL=${pathToFileURL(path.join(__dirname, "allocation-objectives.js")).href}`;
    dom.window.document.body.appendChild(script);

    expect(typeof dom.window.AllocationObjectives).toBe("object");
    expect(dom.window.AllocationObjectives.PRESET_NAMES).toEqual([
      "merit",
      "balanced",
      "fairness",
    ]);

    const result = dom.window.AllocationObjectives.balance(
      [
        {
          mark: 90,
          available: true,
          timetableClash: false,
          academicRank: 3,
          weeklyHourCap: 10,
          currentAssignedHours: 8,
        },
        {
          mark: 75,
          available: true,
          timetableClash: false,
          academicRank: 2,
          weeklyHourCap: 10,
          currentAssignedHours: 0,
        },
      ],
      "fairness",
    );
    expect(result[0].index).toBe(1);
  });
});

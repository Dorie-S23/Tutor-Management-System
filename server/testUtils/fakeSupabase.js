// A minimal stand-in for the @supabase/supabase-js query builder, backed by
// plain in-memory arrays instead of Postgres. Only supports what this repo's
// routes actually call (select/insert/update/delete, eq, neq, in, order,
// limit, single, maybeSingle) — enough to unit-test route logic without a
// real database. order() really sorts (ascending unless {ascending: false}
// is passed) and limit() really truncates, so a route's ordering/capping
// logic is genuinely exercised, not just assumed from fixture order. Note:
// it does NOT perform real relational joins — a `select`
// with an embedded table (e.g. "*, courses(hours_per_week)") just returns
// whatever plain fields the row itself has, so tests that need a joined
// shape back should seed the nested object directly on the row (e.g.
// { tutor_id: 1, courses: { hours_per_week: 3 } }).
//
// Usage:
//   const tables = { courses: [...seed rows...] };
//   const supabase = fakeSupabase(tables);
//   jest.mock("../supabaseClient", () => supabase);
//
// A table can also declare unique constraints, to simulate Postgres's 23505
// duplicate-key error for routes that branch on it (e.g. "you've already
// volunteered for this course"):
//   const supabase = fakeSupabase(tables, {
//     course_volunteers: [["user_id", "course_id"]],
//   });
//
// A third argument — hooks — lets a test interleave a competing writer into
// a route's sequence, to exercise optimistic-concurrency races:
// onBeforeResolve(tableName, operation) runs just before every query
// resolves ("operation" is "update", "delete" or "select"), so it can
// mutate the seed rows the route is about to write, after the route has
// already read them:
//   const supabase = fakeSupabase(tables, {}, {
//     onBeforeResolve: (table, operation) => {
//       if (table === "courses" && operation === "update") {
//         // e.g. another organiser's approval landed first:
//         tables.courses[0].no_of_tutors_assigned = 7;
//       }
//     },
//   });
// The hook must only mutate the seed arrays — issuing queries from inside it
// would recurse back into the hook.

function fakeSupabase(tables, uniqueConstraints = {}, hooks = {}) {
  return {
    from(tableName) {
      const rows = tables[tableName];
      if (!rows) {
        throw new Error(`fakeSupabase: no seed data for table "${tableName}"`);
      }
      const constraints = uniqueConstraints[tableName] || [];

      const filters = [];
      let pendingWrite = null;
      let insertConflict = null;
      let pendingOrder = null;
      let pendingLimit = null;

      const matches = (row) =>
        filters.every(([type, col, val]) => {
          if (type === "in") return val.includes(row[col]);
          if (type === "neq") return row[col] !== val;
          if (type === "gte") return row[col] >= val;
          if (type === "lte") return row[col] <= val;
          return row[col] === val;
        });

      // Matches Postgres's default unique-index behaviour: a row where any
      // constrained column is null never conflicts with anything, including
      // another null (NULL <> NULL) — e.g. several organiser-posted overflow
      // sessions for the same course, all still unclaimed (user_id null),
      // aren't duplicates of each other under a (user_id, course_id)
      // constraint. `excludeRow` lets an update check against every row
      // except the one being updated, so setting a row to its own existing
      // values doesn't spuriously conflict with itself.
      function hasConflict(candidate, excludeRow) {
        return constraints.some(
          (cols) =>
            cols.every((c) => candidate[c] != null) &&
            rows.some(
              (existing) =>
                existing !== excludeRow &&
                cols.every((c) => existing[c] === candidate[c]),
            ),
        );
      }

      const CONFLICT_ERROR = {
        code: "23505",
        message: "duplicate key value violates unique constraint",
      };

      function resolve(wantsSingle, allowNullSingle) {
        if (hooks.onBeforeResolve) {
          hooks.onBeforeResolve(tableName, pendingWrite?.type ?? "select");
        }

        if (insertConflict) {
          return { data: null, error: insertConflict };
        }

        let matched = rows.filter(matches);

        if (pendingWrite?.type === "update") {
          for (const row of matched) {
            const candidate = { ...row, ...pendingWrite.fields };
            if (hasConflict(candidate, row)) {
              return { data: null, error: CONFLICT_ERROR };
            }
          }
          matched.forEach((row) => Object.assign(row, pendingWrite.fields));
        } else if (pendingWrite?.type === "delete") {
          matched.slice().forEach((row) => {
            const index = rows.indexOf(row);
            if (index !== -1) rows.splice(index, 1);
          });
        }

        if (pendingOrder) {
          const { column, ascending } = pendingOrder;
          matched = matched.slice().sort((a, b) => {
            if (a[column] === b[column]) return 0;
            if (a[column] == null) return ascending ? -1 : 1;
            if (b[column] == null) return ascending ? 1 : -1;
            return ascending
              ? a[column] > b[column]
                ? 1
                : -1
              : a[column] > b[column]
                ? -1
                : 1;
          });
        }

        if (pendingLimit != null) {
          matched = matched.slice(0, pendingLimit);
        }

        if (wantsSingle) {
          if (matched.length === 0) {
            // PGRST116 is PostgREST's real code for ".single() matched zero
            // rows" — routes that branch on it (e.g. update().select().single()
            // to detect "no such id") need it present to hit their 404 path.
            return allowNullSingle
              ? { data: null, error: null }
              : {
                  data: null,
                  error: { code: "PGRST116", message: "Row not found" },
                };
          }
          return { data: { ...matched[0] }, error: null };
        }

        return {
          data: matched.map((row) => ({ ...row })),
          error: null,
          count: matched.length,
        };
      }

      const builder = {
        select: () => builder,
        // Accepts either a single row object or (for a bulk insert, e.g.
        // logging several allocation_overrides at once) an array of them.
        insert: (rowOrRows) => {
          const incoming = Array.isArray(rowOrRows) ? rowOrRows : [rowOrRows];

          if (incoming.some((row) => hasConflict(row, null))) {
            insertConflict = CONFLICT_ERROR;
            filters.length = 0;
            pendingWrite = null;
            return builder;
          }

          // Based on the current max id rather than rows.length, so a
          // delete-then-insert (e.g. replacing busy times) can't hand out an
          // id that collides with a row that's still there.
          let nextId = rows.reduce(
            (max, r) => (typeof r.id === "number" && r.id > max ? r.id : max),
            0,
          );
          const insertedRows = incoming.map((row) => {
            nextId += 1;
            const inserted = { id: nextId, ...row };
            rows.push(inserted);
            return inserted;
          });
          filters.length = 0;
          filters.push([
            "in",
            "id",
            insertedRows.map((inserted) => inserted.id),
          ]);
          pendingWrite = null;
          return builder;
        },
        update: (fields) => {
          pendingWrite = { type: "update", fields };
          return builder;
        },
        delete: () => {
          pendingWrite = { type: "delete" };
          return builder;
        },
        eq: (column, value) => {
          filters.push(["eq", column, value]);
          return builder;
        },
        neq: (column, value) => {
          filters.push(["neq", column, value]);
          return builder;
        },
        gte: (column, value) => {
          filters.push(["gte", column, value]);
          return builder;
        },
        lte: (column, value) => {
          filters.push(["lte", column, value]);
          return builder;
        },
        in: (column, values) => {
          filters.push(["in", column, values]);
          return builder;
        },
        // Matches Supabase's own default (ascending unless told otherwise).
        order: (column, opts = {}) => {
          pendingOrder = { column, ascending: opts.ascending !== false };
          return builder;
        },
        limit: (n) => {
          pendingLimit = n;
          return builder;
        },
        single: () => resolve(true, false),
        maybeSingle: () => resolve(true, true),
        // Lets `await supabase.from(...).select(...)` work even when no
        // terminal single()/maybeSingle() call is made, matching the real
        // PostgrestFilterBuilder being thenable.
        then: (onFulfilled, onRejected) =>
          Promise.resolve(resolve(false)).then(onFulfilled, onRejected),
      };

      return builder;
    },
  };
}

module.exports = { fakeSupabase };

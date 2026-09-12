// A minimal stand-in for the @supabase/supabase-js query builder, backed by
// plain in-memory arrays instead of Postgres. Only supports what this repo's
// routes actually call (select/insert/update/delete, eq, in, order, single,
// maybeSingle) — enough to unit-test route logic without a real database.
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

function fakeSupabase(tables, uniqueConstraints = {}) {
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

      const matches = (row) =>
        filters.every(([type, col, val]) =>
          type === "in" ? val.includes(row[col]) : row[col] === val,
        );

      function resolve(wantsSingle, allowNullSingle) {
        if (insertConflict) {
          return { data: null, error: insertConflict };
        }

        let matched = rows.filter(matches);

        if (pendingWrite?.type === "update") {
          matched.forEach((row) => Object.assign(row, pendingWrite.fields));
        } else if (pendingWrite?.type === "delete") {
          matched.slice().forEach((row) => {
            const index = rows.indexOf(row);
            if (index !== -1) rows.splice(index, 1);
          });
        }

        if (wantsSingle) {
          if (matched.length === 0) {
            return allowNullSingle
              ? { data: null, error: null }
              : { data: null, error: { message: "Row not found" } };
          }
          return { data: { ...matched[0] }, error: null };
        }
        return { data: matched.map((row) => ({ ...row })), error: null };
      }

      const builder = {
        select: () => builder,
        insert: (row) => {
          const conflicts = constraints.some((cols) =>
            rows.some((existing) => cols.every((c) => existing[c] === row[c])),
          );
          if (conflicts) {
            insertConflict = {
              code: "23505",
              message: "duplicate key value violates unique constraint",
            };
            filters.length = 0;
            pendingWrite = null;
            return builder;
          }

          const inserted = { id: rows.length + 1, ...row };
          rows.push(inserted);
          filters.length = 0;
          filters.push(["eq", "id", inserted.id]);
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
        in: (column, values) => {
          filters.push(["in", column, values]);
          return builder;
        },
        order: () => builder,
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

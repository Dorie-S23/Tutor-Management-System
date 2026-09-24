// A minimal stand-in for the @supabase/supabase-js query builder, backed by
// plain in-memory arrays instead of Postgres. Only supports what this repo's
// routes actually call (select/insert/update/delete, eq, neq, in, order,
// single, maybeSingle) — enough to unit-test route logic without a real
// database. Note: it does NOT perform real relational joins — a `select`
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
        filters.every(([type, col, val]) => {
          if (type === "in") return val.includes(row[col]);
          if (type === "neq") return row[col] !== val;
          if (type === "gte") return row[col] >= val;
          if (type === "lte") return row[col] <= val;
          return row[col] === val;
        });

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

          const conflicts = incoming.some((row) =>
            constraints.some((cols) =>
              rows.some((existing) =>
                cols.every((c) => existing[c] === row[c]),
              ),
            ),
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

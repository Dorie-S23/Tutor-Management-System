// A minimal stand-in for the @supabase/supabase-js query builder, backed by
// plain in-memory arrays instead of Postgres. Only supports what this repo's
// routes actually call (select/insert/update/delete, eq, order, single,
// maybeSingle) — enough to unit-test route logic without a real database.
//
// Usage:
//   const tables = { courses: [...seed rows...] };
//   const supabase = fakeSupabase(tables);
//   jest.mock("../supabaseClient", () => supabase);

function fakeSupabase(tables) {
  return {
    from(tableName) {
      const rows = tables[tableName];
      if (!rows) {
        throw new Error(`fakeSupabase: no seed data for table "${tableName}"`);
      }

      const filters = [];
      let pendingWrite = null;

      const matches = (row) => filters.every(([col, val]) => row[col] === val);

      function resolve(wantsSingle, allowNullSingle) {
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
          const inserted = { id: rows.length + 1, ...row };
          rows.push(inserted);
          filters.length = 0;
          filters.push(["id", inserted.id]);
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
          filters.push([column, value]);
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

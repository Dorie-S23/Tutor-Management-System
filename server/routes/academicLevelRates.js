const supabase = require("../supabaseClient");

const VALID_LEVELS = ["third_year", "honours", "masters", "phd"];

// One hourly_rate per academic_level, shared by every tutor at that level —
// the single source of truth for pay calculations, instead of a copy of the
// rate stored (and liable to drift) on every tutor row.
async function getRatesMap() {
  const { data, error } = await supabase
    .from("academic_level_rates")
    .select("academic_level, hourly_rate");

  if (error) return { error };

  const ratesMap = {};
  (data || []).forEach((row) => {
    ratesMap[row.academic_level] = row.hourly_rate;
  });
  return { ratesMap };
}

module.exports = { getRatesMap, VALID_LEVELS };

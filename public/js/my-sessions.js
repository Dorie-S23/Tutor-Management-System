/* ============================================================
   My Sessions
   No real backing data in Supabase yet for either list, so both
   just say so rather than showing fake local data.
   ============================================================ */

const upcomingListEl = document.getElementById("upcomingList");
const pastListEl = document.getElementById("pastList");

upcomingListEl.innerHTML = `<p class="empty-state">No upcoming sessions</p>`;
pastListEl.innerHTML = `<p class="empty-state">No past sessions</p>`;

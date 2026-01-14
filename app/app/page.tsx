"use client";

import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabaseClient";

type Shift = "AM" | "PM" | "NOC";
type Priority = "Low" | "Normal" | "High" | "Critical";

type Handoff = {
  id: string;
  created_at: string;
  author_name: string | null;
  shift: Shift;
  location: string;
  priority: Priority;
  summary: string;
  details: string | null;
  needs_follow_up: boolean;
};

const shifts: Shift[] = ["AM", "PM", "NOC"];
const priorities: Priority[] = ["Low", "Normal", "High", "Critical"];

function formatTime(iso: string) {
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    month: "short",
    day: "2-digit",
    hour: "numeric",
    minute: "2-digit",
  });
}

export default function Page() {
  // form
  const [authorName, setAuthorName] = useState("");
  const [shift, setShift] = useState<Shift>("AM");
  const [location, setLocation] = useState("Central Supply");
  const [priority, setPriority] = useState<Priority>("Normal");
  const [summary, setSummary] = useState("");
  const [details, setDetails] = useState("");
  const [needsFollowUp, setNeedsFollowUp] = useState(false);

  // list / filters
  const [handoffs, setHandoffs] = useState<Handoff[]>([]);
  const [loading, setLoading] = useState(false);
  const [filterFollowUpOnly, setFilterFollowUpOnly] = useState(false);
  const [filterLocation, setFilterLocation] = useState("");

  // mobile UX
  const [formOpen, setFormOpen] = useState(true);
  const [filtersOpen, setFiltersOpen] = useState(false);

  const openFollowUps = useMemo(
    () => handoffs.filter((h) => h.needs_follow_up).length,
    [handoffs]
  );

  async function fetchHandoffs() {
    setLoading(true);
    const { data, error } = await supabase
      .from("handoffs")
      .select("*")
      // server-side ordering (follow-up first, then newest)
      .order("needs_follow_up", { ascending: false })
      .order("created_at", { ascending: false });

    setLoading(false);

    if (error) {
      console.error(error);
      alert(`Error loading handoffs: ${error.message}`);
      return;
    }

    setHandoffs((data ?? []) as Handoff[]);
  }

  useEffect(() => {
    fetchHandoffs();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Client-side filters (sorting already handled server-side)
  const filtered = useMemo(() => {
    return handoffs.filter((h) => {
      if (filterFollowUpOnly && !h.needs_follow_up) return false;
      if (
        filterLocation.trim() &&
        !h.location.toLowerCase().includes(filterLocation.trim().toLowerCase())
      )
        return false;
      return true;
    });
  }, [handoffs, filterFollowUpOnly, filterLocation]);

  async function addHandoff() {
    if (!summary.trim()) return alert("Summary is required.");
    if (!location.trim()) return alert("Location is required.");

    setLoading(true);

    const payload = {
      author_name: authorName.trim() || null,
      shift,
      location: location.trim(),
      priority,
      summary: summary.trim(),
      details: details.trim() || null,
      needs_follow_up: needsFollowUp,
    };

    const { error } = await supabase.from("handoffs").insert(payload);

    setLoading(false);

    if (error) {
      console.error(error);
      alert(`Error saving handoff: ${error.message}`);
      return;
    }

    // reset
    setSummary("");
    setDetails("");
    setNeedsFollowUp(false);
    setPriority("Normal");

    await fetchHandoffs();
    setFormOpen(false);

    alert("Handoff saved ✅ (Supabase)");
  }

  async function toggleFollowUp(id: string, current: boolean) {
    setLoading(true);

    const { error } = await supabase
      .from("handoffs")
      .update({ needs_follow_up: !current })
      .eq("id", id);

    setLoading(false);

    if (error) {
      console.error(error);
      alert(`Error updating follow-up: ${error.message}`);
      return;
    }

    await fetchHandoffs();
  }

  async function removeHandoff(id: string) {
    if (!confirm("Delete this handoff?")) return;

    setLoading(true);
    const { error } = await supabase.from("handoffs").delete().eq("id", id);
    setLoading(false);

    if (error) {
      console.error(error);
      alert(`Error deleting handoff: ${error.message}`);
      return;
    }

    await fetchHandoffs();
  }

  async function clearAll() {
    if (!confirm("Clear ALL handoffs from the database?")) return;

    setLoading(true);
    // delete all rows (safe hack condition)
    const { error } = await supabase
      .from("handoffs")
      .delete()
      .neq("id", "00000000-0000-0000-0000-000000000000");
    setLoading(false);

    if (error) {
      console.error(error);
      alert(`Error clearing handoffs: ${error.message}`);
      return;
    }

    await fetchHandoffs();
  }

  const pillPriority = (p: Priority) =>
    `rounded-full border px-2 py-1 text-xs ${
      p === "Critical"
        ? "border-red-700 text-red-200"
        : p === "High"
        ? "border-amber-600 text-amber-200"
        : p === "Normal"
        ? "border-zinc-700 text-zinc-200"
        : "border-zinc-700 text-zinc-300"
    }`;

  const borderPriority = (p: Priority) =>
    p === "Critical"
      ? "border-red-700"
      : p === "High"
      ? "border-amber-600"
      : p === "Normal"
      ? "border-zinc-800"
      : "border-zinc-700";

  return (
    <main className="min-h-screen bg-zinc-950 text-zinc-50">
      <div className="mx-auto max-w-4xl px-4 pb-24 pt-6 sm:px-6 sm:pb-10 sm:pt-10">
        <header className="mb-4 sm:mb-8">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <h1 className="text-2xl font-bold tracking-tight sm:text-4xl">
                Central Supply Handoff
              </h1>
              <p className="mt-1 text-sm text-zinc-400 sm:mt-2 sm:text-base">
                Shift-to-shift handoff log (Supabase source of truth).
              </p>
            </div>

            <div className="flex items-center gap-2">
              <span className="rounded-full border border-zinc-800 px-2 py-1 text-xs text-zinc-200">
                Open follow-ups:{" "}
                <span className="font-semibold">{openFollowUps}</span>
              </span>

              <button
                onClick={fetchHandoffs}
                type="button"
                className="rounded-lg border border-zinc-700 px-3 py-2 text-xs text-zinc-200 hover:bg-zinc-800"
              >
                Refresh
              </button>
            </div>
          </div>

          <div className="mt-3 flex flex-wrap gap-2 sm:hidden">
            <button
              type="button"
              onClick={() => setFormOpen((v) => !v)}
              className="rounded-lg border border-zinc-800 bg-zinc-900/40 px-3 py-2 text-xs text-zinc-200"
            >
              {formOpen ? "Hide form" : "New handoff"}
            </button>
            <button
              type="button"
              onClick={() => setFiltersOpen((v) => !v)}
              className="rounded-lg border border-zinc-800 bg-zinc-900/40 px-3 py-2 text-xs text-zinc-200"
            >
              {filtersOpen ? "Hide filters" : "Filters"}
            </button>
            <button
              type="button"
              onClick={clearAll}
              className="rounded-lg border border-zinc-800 bg-zinc-900/40 px-3 py-2 text-xs text-zinc-200"
            >
              Clear all
            </button>
          </div>
        </header>

        {formOpen && (
          <section className="rounded-2xl border border-zinc-800 bg-zinc-900/40 p-4 sm:p-5">
            <div className="mb-3 flex items-baseline justify-between gap-3">
              <h2 className="text-base font-semibold sm:text-lg">Create handoff</h2>
              <span className="text-xs text-zinc-500 sm:hidden">Tap submit below</span>
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <label className="grid gap-1">
                <span className="text-xs text-zinc-400">Your name (optional)</span>
                <input
                  value={authorName}
                  onChange={(e) => setAuthorName(e.target.value)}
                  placeholder="Aaron"
                  className="h-11 rounded-xl border border-zinc-800 bg-zinc-950 px-3 outline-none focus:border-zinc-600"
                />
              </label>

              <label className="grid gap-1">
                <span className="text-xs text-zinc-400">Shift</span>
                <select
                  value={shift}
                  onChange={(e) => setShift(e.target.value as Shift)}
                  className="h-11 rounded-xl border border-zinc-800 bg-zinc-950 px-3 outline-none focus:border-zinc-600"
                >
                  {shifts.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              </label>

              <label className="grid gap-1">
                <span className="text-xs text-zinc-400">Location</span>
                <input
                  value={location}
                  onChange={(e) => setLocation(e.target.value)}
                  placeholder="ED / OR / SPD / Central Supply"
                  className="h-11 rounded-xl border border-zinc-800 bg-zinc-950 px-3 outline-none focus:border-zinc-600"
                />
              </label>

              <label className="grid gap-1">
                <span className="text-xs text-zinc-400">Priority</span>
                <select
                  value={priority}
                  onChange={(e) => setPriority(e.target.value as Priority)}
                  className="h-11 rounded-xl border border-zinc-800 bg-zinc-950 px-3 outline-none focus:border-zinc-600"
                >
                  {priorities.map((p) => (
                    <option key={p} value={p}>
                      {p}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <div className="mt-3 grid gap-3">
              <label className="grid gap-1">
                <span className="text-xs text-zinc-400">Summary (required)</span>
                <input
                  value={summary}
                  onChange={(e) => setSummary(e.target.value)}
                  placeholder="e.g., Crash cart seal broken in ED; restock needed"
                  className="h-11 rounded-xl border border-zinc-800 bg-zinc-950 px-3 outline-none focus:border-zinc-600"
                />
              </label>

              <label className="grid gap-1">
                <span className="text-xs text-zinc-400">Details (optional)</span>
                <textarea
                  value={details}
                  onChange={(e) => setDetails(e.target.value)}
                  placeholder="What happened, what was done, what needs follow-up, where items are located, who was notified..."
                  rows={4}
                  className="rounded-xl border border-zinc-800 bg-zinc-950 px-3 py-2 outline-none focus:border-zinc-600"
                />
              </label>

              <label className="flex items-center gap-2 text-sm text-zinc-200">
                <input
                  type="checkbox"
                  checked={needsFollowUp}
                  onChange={(e) => setNeedsFollowUp(e.target.checked)}
                />
                Needs follow-up
              </label>

              <div className="hidden sm:block">
                <button
                  onClick={addHandoff}
                  type="button"
                  className="h-12 w-full rounded-xl bg-zinc-50 px-4 font-semibold text-zinc-950 hover:bg-zinc-200 disabled:opacity-50"
                  disabled={loading}
                >
                  {loading ? "Loading…" : "Submit handoff"}
                </button>
              </div>
            </div>
          </section>
        )}

        <section className="mt-4 rounded-2xl border border-zinc-800 bg-zinc-900/20 p-3 sm:mt-6 sm:border-0 sm:bg-transparent sm:p-0">
          <div className="hidden sm:flex sm:flex-wrap sm:items-center sm:gap-3">
            <label className="flex items-center gap-2 text-sm text-zinc-200">
              <input
                type="checkbox"
                checked={filterFollowUpOnly}
                onChange={(e) => setFilterFollowUpOnly(e.target.checked)}
              />
              Follow-up only
            </label>

            <input
              value={filterLocation}
              onChange={(e) => setFilterLocation(e.target.value)}
              placeholder="Filter location…"
              className="h-11 w-56 rounded-xl border border-zinc-800 bg-zinc-950 px-3 text-sm outline-none focus:border-zinc-600"
            />

            <div className="text-sm text-zinc-400">
              Showing <span className="font-semibold text-zinc-200">{filtered.length}</span> /{" "}
              {handoffs.length}
            </div>
          </div>

          {filtersOpen && (
            <div className="grid gap-3 sm:hidden">
              <label className="flex items-center gap-2 text-sm text-zinc-200">
                <input
                  type="checkbox"
                  checked={filterFollowUpOnly}
                  onChange={(e) => setFilterFollowUpOnly(e.target.checked)}
                />
                Follow-up only
              </label>

              <input
                value={filterLocation}
                onChange={(e) => setFilterLocation(e.target.value)}
                placeholder="Filter location…"
                className="h-11 w-full rounded-xl border border-zinc-800 bg-zinc-950 px-3 text-sm outline-none focus:border-zinc-600"
              />
            </div>
          )}
        </section>

        <section className="mt-4 grid gap-3">
          {loading ? (
            <div className="rounded-2xl border border-zinc-800 bg-zinc-900/30 p-5 text-zinc-400">
              Loading…
            </div>
          ) : filtered.length === 0 ? (
            <div className="rounded-2xl border border-zinc-800 bg-zinc-900/30 p-5 text-zinc-400">
              No handoffs yet.
            </div>
          ) : (
            filtered.map((h) => (
              <article
                key={h.id}
                className={`rounded-2xl border p-4 sm:p-5 ${
                  h.needs_follow_up ? "bg-zinc-900/70" : "bg-zinc-900/30"
                } ${borderPriority(h.priority)}`}
              >
                <div className="flex flex-col gap-2 sm:flex-row sm:items-baseline sm:justify-between">
                  <div className="flex flex-wrap items-baseline gap-2">
                    <div className="text-base font-semibold sm:text-lg">{h.location}</div>
                    <div className="text-xs text-zinc-400 sm:text-sm">
                      {h.shift} • {formatTime(h.created_at)} • by {h.author_name ?? "—"}
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    <span className={pillPriority(h.priority)}>{h.priority}</span>
                    {h.needs_follow_up ? (
                      <span className="rounded-full border border-zinc-700 px-2 py-1 text-xs text-zinc-200">
                        Follow-up
                      </span>
                    ) : (
                      <span className="rounded-full border border-zinc-800 px-2 py-1 text-xs text-zinc-400">
                        Resolved
                      </span>
                    )}
                  </div>
                </div>

                <div className="mt-2 text-lg font-semibold sm:text-xl">{h.summary}</div>
                {h.details ? (
                  <div className="mt-2 whitespace-pre-wrap text-sm text-zinc-200/90 sm:text-base">
                    {h.details}
                  </div>
                ) : null}

                <div className="mt-4 grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:gap-2">
                  <button
                    onClick={() => toggleFollowUp(h.id, h.needs_follow_up)}
                    type="button"
                    className="h-11 rounded-lg border border-zinc-700 px-3 text-sm text-zinc-200 hover:bg-zinc-800"
                  >
                    {h.needs_follow_up ? "Mark resolved" : "Mark needs follow-up"}
                  </button>

                  <button
                    onClick={() => removeHandoff(h.id)}
                    type="button"
                    className="h-11 rounded-lg border border-zinc-800 px-3 text-sm text-zinc-400 hover:bg-zinc-900"
                  >
                    Delete
                  </button>
                </div>
              </article>
            ))
          )}
        </section>

        <footer className="mt-8 text-xs text-zinc-500">
          Supabase is the source of truth ✅ (Read + Write). Follow-ups auto-surface first.
        </footer>
      </div>

      {/* Mobile sticky action bar */}
      <div className="fixed inset-x-0 bottom-0 z-50 border-t border-zinc-800 bg-zinc-950/95 backdrop-blur sm:hidden">
        <div className="mx-auto flex max-w-4xl items-center gap-2 px-4 py-3">
          <button
            type="button"
            onClick={() => setFormOpen(true)}
            className="h-12 rounded-xl border border-zinc-800 bg-zinc-900/40 px-3 text-xs text-zinc-200"
          >
            New
          </button>

          <button
            onClick={addHandoff}
            type="button"
            className="h-12 flex-1 rounded-xl bg-zinc-50 px-4 font-semibold text-zinc-950 disabled:opacity-50"
            disabled={loading || !summary.trim() || !location.trim()}
          >
            {loading ? "Loading…" : "Submit handoff"}
          </button>

          <button
            type="button"
            onClick={fetchHandoffs}
            className="h-12 rounded-xl border border-zinc-800 bg-zinc-900/40 px-3 text-xs text-zinc-200"
          >
            Sync
          </button>
        </div>
      </div>
    </main>
  );
}

"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { createClient, SupabaseClient } from "@supabase/supabase-js";

/* =========================================================
   CENTRAL SUPPLY HANDOFF — FULL SYSTEM PAGE (DROP-IN)
   - Sticky "+ Create handoff" ALWAYS visible on mobile
   - Critical forced to top (hard-priority)
   - Strong box glow + Critical pulse animation (unresolved only)
   - Deterministic sort: unresolved -> follow-up -> priority -> newest
   - Mobile drawer: details + updates + add update + mark resolved
   - Desktop works too (same layout; drawer only on mobile)
   - Auth gate: magic link
   - AbortError ignored
   - Handoffs insert schema-aligned (NO author_user_id / snapshot fields)
   - Updates insert includes author_user_id + display snapshot
========================================================= */

type Shift = "AM" | "PM" | "NOC";
type Priority = "Low" | "Normal" | "High" | "Critical";
type HandoffStatus = "open" | "needs_followup" | "resolved";
type UpdateSource = "app" | "sms" | "system";

type Handoff = {
  id: string;
  facility_id: string | null;
  unit: string | null;
  shift: Shift | null;
  title: string;
  priority: Priority;
  status: HandoffStatus;
  created_at: string; // timestamptz
  created_by: string | null;
};

type HandoffUpdate = {
  id: string;
  handoff_id: string;
  message: string;
  source: UpdateSource;
  author_user_id: string | null;
  author_display_name_snapshot: string | null;
  created_at: string;
};

const BUILD_TAG = "CS-HANDOFF-FULLSYS-SAFE-v1";

const priorityRank: Record<Priority, number> = {
  Critical: 0,
  High: 1,
  Normal: 2,
  Low: 3,
};

function isAbortError(err: unknown) {
  // Works across browsers/Node variants
  return (
    (err instanceof DOMException && err.name === "AbortError") ||
    (typeof err === "object" &&
      err !== null &&
      "name" in err &&
      (err as any).name === "AbortError")
  );
}

function fmtTime(ts?: string) {
  if (!ts) return "";
  try {
    const d = new Date(ts);
    return d.toLocaleString();
  } catch {
    return ts;
  }
}

function cx(...parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(" ");
}

export default function Page() {
  /* =========================
     SUPABASE (SAFE INIT)
  ========================= */
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  const supabase: SupabaseClient | null =
    supabaseUrl && supabaseAnonKey ? createClient(supabaseUrl, supabaseAnonKey) : null;

  /* =========================
     REFS (useRef only)
  ========================= */
  const createSectionRef = useRef<HTMLElement | null>(null);

  /* =========================
     AUTH + PROFILE SNAPSHOT
  ========================= */
  const [sessionUserId, setSessionUserId] = useState<string | null>(null);
  const [authEmail, setAuthEmail] = useState("");
  const [authStatus, setAuthStatus] = useState<string>("");
  const [displayName, setDisplayName] = useState<string>(""); // optional in-app display name snapshot

  /* =========================
     FILTER CONTEXT
  ========================= */
  const [facilityId, setFacilityId] = useState<string>("PHC"); // default; adjust for you
  const [unit, setUnit] = useState<string>("Main");

  /* =========================
     DATA
  ========================= */
  const [handoffs, setHandoffs] = useState<Handoff[]>([]);
  const [loadingHandoffs, setLoadingHandoffs] = useState<boolean>(false);
  const [handoffErr, setHandoffErr] = useState<string>("");

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = useMemo(
    () => handoffs.find((h) => h.id === selectedId) || null,
    [handoffs, selectedId]
  );

  const [updates, setUpdates] = useState<HandoffUpdate[]>([]);
  const [loadingUpdates, setLoadingUpdates] = useState<boolean>(false);
  const [updatesErr, setUpdatesErr] = useState<string>("");

  /* =========================
     CREATE FORM (STICKY)
  ========================= */
  const [newTitle, setNewTitle] = useState("");
  const [newShift, setNewShift] = useState<Shift>("AM");
  const [newPriority, setNewPriority] = useState<Priority>("Normal");
  const [newNeedsFollowup, setNewNeedsFollowup] = useState<boolean>(false);
  const [creating, setCreating] = useState<boolean>(false);
  const [createMsg, setCreateMsg] = useState<string>("");

  /* =========================
     UPDATE FORM
  ========================= */
  const [updateText, setUpdateText] = useState<string>("");
  const [postingUpdate, setPostingUpdate] = useState<boolean>(false);

  /* =========================
     RESPONSIVE
  ========================= */
  const [isMobile, setIsMobile] = useState<boolean>(false);
  useEffect(() => {
    const onResize = () => setIsMobile(window.innerWidth < 900);
    onResize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  /* =========================
     AUTH BOOT
  ========================= */
  useEffect(() => {
    if (!supabase) return;

    let alive = true;

    (async () => {
      const { data, error } = await supabase.auth.getSession();
      if (!alive) return;
      if (error) {
        setAuthStatus(error.message);
        setSessionUserId(null);
        return;
      }
      setSessionUserId(data.session?.user?.id ?? null);
    })();

    const { data: sub } = supabase.auth.onAuthStateChange((_event, sess) => {
      setSessionUserId(sess?.user?.id ?? null);
    });

    return () => {
      alive = false;
      sub.subscription.unsubscribe();
    };
  }, [supabase]);

  /* =========================
     LOAD HANDOFFS (Abort-safe)
  ========================= */
  useEffect(() => {
    if (!supabase) return;
    if (!sessionUserId) return;

    const controller = new AbortController();

    const load = async () => {
      setLoadingHandoffs(true);
      setHandoffErr("");
      try {
        // NOTE: Adjust table/column names if yours differ.
        const { data, error } = await supabase
          .from("handoffs")
          .select(
            "id, facility_id, unit, shift, title, priority, status, created_at, created_by"
          )
          .eq("facility_id", facilityId)
          .eq("unit", unit)
          .order("created_at", { ascending: false })

        if (error) throw error;
        setHandoffs((data ?? []) as Handoff[]);
      } catch (e: any) {
        if (isAbortError(e)) return; // AbortError ignored (locked requirement)
        setHandoffErr(e?.message ?? "Failed to load handoffs");
      } finally {
        setLoadingHandoffs(false);
      }
    };

    load();

    return () => controller.abort();
  }, [supabase, sessionUserId, facilityId, unit]);

  /* =========================
     LOAD UPDATES (Abort-safe)
  ========================= */
  useEffect(() => {
    if (!supabase) return;
    if (!sessionUserId) return;
    if (!selectedId) {
      setUpdates([]);
      setUpdatesErr("");
      return;
    }

    const controller = new AbortController();

    const load = async () => {
      setLoadingUpdates(true);
      setUpdatesErr("");
      try {
        const { data, error } = await supabase
          .from("handoff_updates")
          .select(
            "id, handoff_id, message, source, author_user_id, author_display_name_snapshot, created_at"
          )
          .eq("handoff_id", selectedId)
          .order("created_at", { ascending: true })

        if (error) throw error;
        setUpdates((data ?? []) as HandoffUpdate[]);
      } catch (e: any) {
        if (isAbortError(e)) return;
        setUpdatesErr(e?.message ?? "Failed to load updates");
      } finally {
        setLoadingUpdates(false);
      }
    };

    load();

    return () => controller.abort();
  }, [supabase, sessionUserId, selectedId]);

  /* =========================
     SORT (Deterministic, Critical forced top)
     Rule:
       1) unresolved before resolved
       2) within unresolved: Critical first (hard-priority)
       3) then follow-up before open
       4) then priority (Critical, High, Normal, Low)
       5) then newest
  ========================= */
  const sortedHandoffs = useMemo(() => {
    const arr = [...handoffs];
    arr.sort((a, b) => {
      const aResolved = a.status === "resolved";
      const bResolved = b.status === "resolved";
      if (aResolved !== bResolved) return aResolved ? 1 : -1;

      const aCritical = a.priority === "Critical" && !aResolved;
      const bCritical = b.priority === "Critical" && !bResolved;
      if (aCritical !== bCritical) return aCritical ? -1 : 1;

      const aFU = a.status === "needs_followup";
      const bFU = b.status === "needs_followup";
      if (aFU !== bFU) return aFU ? -1 : 1;

      const pr = priorityRank[a.priority] - priorityRank[b.priority];
      if (pr !== 0) return pr;

      // newest first
      const at = Date.parse(a.created_at || "");
      const bt = Date.parse(b.created_at || "");
      return (isNaN(bt) ? 0 : bt) - (isNaN(at) ? 0 : at);
    });
    return arr;
  }, [handoffs]);

  /* =========================
     ACTIONS
  ========================= */
  async function sendMagicLink() {
    if (!supabase) return;
    setAuthStatus("");
    try {
      if (!authEmail.trim()) {
        setAuthStatus("Enter your email.");
        return;
      }
      const { error } = await supabase.auth.signInWithOtp({
        email: authEmail.trim(),
        options: {
          // Works in Vercel + local; adjust if you have a custom domain
          emailRedirectTo: typeof window !== "undefined" ? window.location.origin : undefined,
        },
      });
      if (error) throw error;
      setAuthStatus("Magic link sent. Check your email.");
    } catch (e: any) {
      setAuthStatus(e?.message ?? "Failed to send magic link");
    }
  }

  async function signOut() {
    if (!supabase) return;
    await supabase.auth.signOut();
    setSessionUserId(null);
    setSelectedId(null);
  }

  async function createHandoff() {
    if (!supabase) return;
    if (!sessionUserId) return;

    setCreateMsg("");
    if (!newTitle.trim()) {
      setCreateMsg("Title is required.");
      return;
    }

    setCreating(true);
    try {
      const status: HandoffStatus = newNeedsFollowup ? "needs_followup" : "open";

      // IMPORTANT: schema-aligned insert (NO author_user_id/snapshot fields)
      // We ONLY write fields that exist in the handoffs table.
      const payload: Partial<Handoff> & {
        facility_id: string;
        unit: string;
        title: string;
        priority: Priority;
        status: HandoffStatus;
        shift: Shift;
        created_by?: string;
      } = {
        facility_id: facilityId,
        unit,
        title: newTitle.trim(),
        priority: newPriority,
        status,
        shift: newShift,
        created_by: sessionUserId, // ok if table has it; remove if your schema doesn't
      };

      const { data, error } = await supabase.from("handoffs").insert(payload).select().single();
      if (error) throw error;

      const created = data as unknown as Handoff;
      setHandoffs((prev) => [created, ...prev]);
      setNewTitle("");
      setNewPriority("Normal");
      setNewNeedsFollowup(false);
      setCreateMsg("Created.");
      setSelectedId(created.id);

      // Keep create section visible on mobile; optional scroll
      if (isMobile && createSectionRef.current) {
        createSectionRef.current.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    } catch (e: any) {
      setCreateMsg(e?.message ?? "Failed to create handoff");
    } finally {
      setCreating(false);
      setTimeout(() => setCreateMsg(""), 2500);
    }
  }

  async function addUpdate() {
    if (!supabase) return;
    if (!sessionUserId) return;
    if (!selectedId) return;
    if (!updateText.trim()) return;

    setPostingUpdate(true);
    try {
      const snapshot =
        displayName.trim().length > 0 ? displayName.trim() : "CS Staff"; // snapshot naming (no PHI)

      // IMPORTANT: updates insert includes author_user_id + display snapshot
      const payload = {
        handoff_id: selectedId,
        message: updateText.trim(),
        source: "app" as UpdateSource,
        author_user_id: sessionUserId,
        author_display_name_snapshot: snapshot,
      };

      const { data, error } = await supabase
        .from("handoff_updates")
        .insert(payload)
        .select()
        .single();

      if (error) throw error;

      const created = data as unknown as HandoffUpdate;
      setUpdates((prev) => [...prev, created]);
      setUpdateText("");
    } catch (e: any) {
      // silent-ish, but visible
      setUpdatesErr(e?.message ?? "Failed to post update");
      setTimeout(() => setUpdatesErr(""), 3000);
    } finally {
      setPostingUpdate(false);
    }
  }

  async function markResolved(nextResolved: boolean) {
    if (!supabase) return;
    if (!selected) return;

    try {
      const nextStatus: HandoffStatus = nextResolved ? "resolved" : "open";

      const { data, error } = await supabase
        .from("handoffs")
        .update({ status: nextStatus })
        .eq("id", selected.id)
        .select()
        .single();

      if (error) throw error;

      const updated = data as unknown as Handoff;
      setHandoffs((prev) => prev.map((h) => (h.id === updated.id ? updated : h)));
    } catch (e: any) {
      setHandoffErr(e?.message ?? "Failed to update status");
      setTimeout(() => setHandoffErr(""), 3000);
    }
  }

  /* =========================
     UI HELPERS
  ========================= */
  function openDetails(id: string) {
    setSelectedId(id);
  }

  function closeDrawer() {
    setSelectedId(null);
    setUpdates([]);
    setUpdatesErr("");
    setUpdateText("");
  }

  /* =========================
     GUARD: Missing Supabase env
  ========================= */
  if (!supabase) {
    return (
      <main className="p-6">
        <h1 className="text-xl font-semibold">Central Supply Handoff</h1>
        <p className="mt-2 opacity-80">
          Missing Supabase env vars. Set <code>NEXT_PUBLIC_SUPABASE_URL</code> and{" "}
          <code>NEXT_PUBLIC_SUPABASE_ANON_KEY</code>.
        </p>
        <p className="mt-4 text-sm opacity-70">Build: {BUILD_TAG}</p>
      </main>
    );
  }

  /* =========================
     AUTH GATE (MAGIC LINK)
  ========================= */
  if (!sessionUserId) {
    return (
      <main className="min-h-screen flex items-center justify-center p-6">
        <div className="w-full max-w-md rounded-2xl border border-white/10 bg-black/30 p-5 backdrop-blur">
          <div className="text-xs opacity-70">Build: {BUILD_TAG}</div>
          <h1 className="mt-2 text-2xl font-semibold">Central Supply Handoff</h1>
          <p className="mt-2 opacity-80">
            Sign in with a magic link. (No PHI. Keep it enterprise-safe.)
          </p>

          <label className="block mt-4 text-sm opacity-80">Email</label>
          <input
            value={authEmail}
            onChange={(e) => setAuthEmail(e.target.value)}
            placeholder="you@hospital.org"
            className="mt-2 w-full rounded-xl border border-white/10 bg-black/40 px-3 py-2 outline-none"
          />

          <button
            onClick={sendMagicLink}
            className="mt-4 w-full rounded-xl bg-white/10 hover:bg-white/15 border border-white/10 px-4 py-2"
          >
            Send magic link
          </button>

          {authStatus && <div className="mt-3 text-sm opacity-80">{authStatus}</div>}

          <div className="mt-4 text-xs opacity-60">
            Tip: If links open in a different browser, copy the URL into the same browser session.
          </div>
        </div>
      </main>
    );
  }

  /* =========================
     MAIN APP
  ========================= */
  return (
    <main className="min-h-screen">
      {/* GLOBAL ANIMATIONS / GLOW */}
      <style jsx global>{`
        @keyframes csPulse {
          0% {
            transform: scale(1);
            filter: brightness(1);
          }
          50% {
            transform: scale(1.01);
            filter: brightness(1.2);
          }
          100% {
            transform: scale(1);
            filter: brightness(1);
          }
        }
        .cs-card-glow {
          box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.08),
            0 10px 30px rgba(0, 0, 0, 0.35),
            0 0 28px rgba(255, 255, 255, 0.06);
        }
        .cs-critical-pulse {
          animation: csPulse 1.3s ease-in-out infinite;
        }
      `}</style>

      {/* TOP BAR */}
      <header className="sticky top-0 z-50 border-b border-white/10 bg-black/50 backdrop-blur">
        <div className="mx-auto max-w-6xl px-4 py-3 flex items-center justify-between gap-3">
          <div>
            <div className="text-sm opacity-70">Central Supply Handoff</div>
            <div className="text-xs opacity-60">
              Build: {BUILD_TAG} · Facility: <b>{facilityId}</b> · Unit: <b>{unit}</b>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <input
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="Display name (optional)"
              className="hidden md:block rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-sm outline-none"
            />
            <button
              onClick={() => {
                // quick refresh
                setHandoffs((prev) => [...prev]);
              }}
              className="rounded-xl border border-white/10 bg-white/5 hover:bg-white/10 px-3 py-2 text-sm"
              title="Refresh (client-side re-render)"
            >
              Refresh
            </button>
            <button
              onClick={signOut}
              className="rounded-xl border border-white/10 bg-white/5 hover:bg-white/10 px-3 py-2 text-sm"
            >
              Sign out
            </button>
          </div>
        </div>
      </header>

      {/* CONTEXT + CREATE (Sticky on mobile) */}
      <section
        ref={createSectionRef}
        className={cx(
          "mx-auto max-w-6xl px-4",
          "pt-4",
          "md:pt-6"
        )}
      >
        <div
          className={cx(
            "rounded-2xl border border-white/10 bg-black/30 backdrop-blur p-4",
            "md:p-5",
            // sticky create on mobile (ALWAYS visible)
            "sticky top-[56px] z-40",
            "md:static md:top-auto"
          )}
          style={{
            boxShadow: "0 0 0 1px rgba(255,255,255,.06), 0 16px 40px rgba(0,0,0,.35)",
          }}
        >
          <div className="flex flex-col md:flex-row md:items-end gap-3 md:gap-4">
            <div className="flex-1">
              <div className="text-xs opacity-70">Context</div>
              <div className="mt-2 grid grid-cols-2 md:grid-cols-3 gap-2">
                <div>
                  <label className="text-xs opacity-70">Facility</label>
                  <input
                    value={facilityId}
                    onChange={(e) => setFacilityId(e.target.value)}
                    className="mt-1 w-full rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-sm outline-none"
                  />
                </div>
                <div>
                  <label className="text-xs opacity-70">Unit</label>
                  <input
                    value={unit}
                    onChange={(e) => setUnit(e.target.value)}
                    className="mt-1 w-full rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-sm outline-none"
                  />
                </div>
                <div className="hidden md:block">
                  <label className="text-xs opacity-70">Display name snapshot</label>
                  <input
                    value={displayName}
                    onChange={(e) => setDisplayName(e.target.value)}
                    placeholder="Optional"
                    className="mt-1 w-full rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-sm outline-none"
                  />
                </div>
              </div>
            </div>

            <div className="flex-1">
              <div className="text-xs opacity-70">+ Create handoff</div>
              <div className="mt-2 grid grid-cols-2 md:grid-cols-4 gap-2">
                <div className="col-span-2 md:col-span-2">
                  <label className="text-xs opacity-70">Title</label>
                  <input
                    value={newTitle}
                    onChange={(e) => setNewTitle(e.target.value)}
                    placeholder="e.g., Missing IV start kits"
                    className="mt-1 w-full rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-sm outline-none"
                  />
                </div>

                <div>
                  <label className="text-xs opacity-70">Shift</label>
                  <select
                    value={newShift}
                    onChange={(e) => setNewShift(e.target.value as Shift)}
                    className="mt-1 w-full rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-sm outline-none"
                  >
                    <option value="AM">AM</option>
                    <option value="PM">PM</option>
                    <option value="NOC">NOC</option>
                  </select>
                </div>

                <div>
                  <label className="text-xs opacity-70">Priority</label>
                  <select
                    value={newPriority}
                    onChange={(e) => setNewPriority(e.target.value as Priority)}
                    className="mt-1 w-full rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-sm outline-none"
                  >
                    <option value="Low">Low</option>
                    <option value="Normal">Normal</option>
                    <option value="High">High</option>
                    <option value="Critical">Critical</option>
                  </select>
                </div>

                <div className="col-span-2 md:col-span-4 flex items-center justify-between gap-3">
                  <label className="flex items-center gap-2 text-sm opacity-85">
                    <input
                      type="checkbox"
                      checked={newNeedsFollowup}
                      onChange={(e) => setNewNeedsFollowup(e.target.checked)}
                    />
                    Needs follow-up
                  </label>

                  <button
                    onClick={createHandoff}
                    disabled={creating}
                    className={cx(
                      "rounded-xl border border-white/10 px-4 py-2 text-sm",
                      creating ? "bg-white/5 opacity-60" : "bg-white/10 hover:bg-white/15"
                    )}
                  >
                    {creating ? "Creating..." : "Create"}
                  </button>
                </div>

                {createMsg && (
                  <div className="col-span-2 md:col-span-4 text-sm opacity-80">{createMsg}</div>
                )}
              </div>
            </div>
          </div>

          {handoffErr && <div className="mt-3 text-sm text-red-300">{handoffErr}</div>}
        </div>
      </section>

      {/* BODY */}
      <section className="mx-auto max-w-6xl px-4 pb-12 pt-4 md:pt-6">
        <div className="grid grid-cols-1 md:grid-cols-[1fr_420px] gap-4 md:gap-6">
          {/* LIST */}
          <div className="min-w-0">
            <div className="flex items-center justify-between">
              <div className="text-sm opacity-70">
                Handoffs{" "}
                <span className="opacity-60">
                  ({sortedHandoffs.length}
                  {loadingHandoffs ? ", loading…" : ""})
                </span>
              </div>
            </div>

            <div className="mt-3 space-y-3">
              {sortedHandoffs.length === 0 && !loadingHandoffs && (
                <div className="rounded-2xl border border-white/10 bg-black/20 p-4 opacity-75">
                  No handoffs yet.
                </div>
              )}

              {sortedHandoffs.map((h) => {
                const unresolved = h.status !== "resolved";
                const criticalUnresolved = unresolved && h.priority === "Critical";
                const followup = h.status === "needs_followup";

                return (
                  <button
                    key={h.id}
                    onClick={() => openDetails(h.id)}
                    className={cx(
                      "w-full text-left rounded-2xl border border-white/10 bg-black/25 p-4",
                      "hover:bg-black/35 transition",
                      "cs-card-glow",
                      selectedId === h.id && "outline outline-2 outline-white/20",
                      criticalUnresolved && "cs-critical-pulse"
                    )}
                    style={{
                      boxShadow: criticalUnresolved
                        ? "0 0 0 1px rgba(255,255,255,.10), 0 0 36px rgba(255,80,80,.16), 0 18px 50px rgba(0,0,0,.45)"
                        : "0 0 0 1px rgba(255,255,255,.08), 0 16px 40px rgba(0,0,0,.35)",
                    }}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span
                            className={cx(
                              "text-xs rounded-full px-2 py-1 border",
                              h.priority === "Critical"
                                ? "border-red-300/30 bg-red-500/10"
                                : h.priority === "High"
                                ? "border-yellow-300/30 bg-yellow-500/10"
                                : "border-white/10 bg-white/5"
                            )}
                          >
                            {h.priority}
                          </span>
                          {followup && (
                            <span className="text-xs rounded-full px-2 py-1 border border-sky-300/30 bg-sky-500/10">
                              Follow-up
                            </span>
                          )}
                          {h.status === "resolved" && (
                            <span className="text-xs rounded-full px-2 py-1 border border-emerald-300/30 bg-emerald-500/10">
                              Resolved
                            </span>
                          )}
                          <span className="text-xs opacity-60">Shift: {h.shift ?? "—"}</span>
                        </div>

                        <div className="mt-2 text-base font-medium break-words">{h.title}</div>

                        <div className="mt-2 text-xs opacity-60">
                          {h.facility_id ?? "—"} · {h.unit ?? "—"} · {fmtTime(h.created_at)}
                        </div>
                      </div>

                      <div className="text-xs opacity-60 whitespace-nowrap">
                        {unresolved ? "Open" : "Closed"}
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          {/* DETAILS PANEL (desktop) */}
          <aside className="hidden md:block">
            <div className="rounded-2xl border border-white/10 bg-black/25 p-4 cs-card-glow">
              <div className="text-sm opacity-70">Details</div>

              {!selected && (
                <div className="mt-3 opacity-70">Select a handoff to view updates.</div>
              )}

              {selected && (
                <>
                  <div className="mt-3 flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-xs rounded-full px-2 py-1 border border-white/10 bg-white/5">
                          {selected.priority}
                        </span>
                        <span className="text-xs opacity-60">Shift: {selected.shift ?? "—"}</span>
                        <span className="text-xs opacity-60">{fmtTime(selected.created_at)}</span>
                      </div>
                      <div className="mt-2 text-lg font-semibold break-words">{selected.title}</div>
                      <div className="mt-2 text-xs opacity-60">
                        {selected.facility_id ?? "—"} · {selected.unit ?? "—"}
                      </div>
                    </div>

                    <label className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={selected.status === "resolved"}
                        onChange={(e) => markResolved(e.target.checked)}
                      />
                      Resolved
                    </label>
                  </div>

                  <div className="mt-4 border-t border-white/10 pt-4">
                    <div className="text-sm opacity-70">Updates</div>

                    {loadingUpdates && <div className="mt-2 text-sm opacity-70">Loading…</div>}
                    {updatesErr && <div className="mt-2 text-sm text-red-300">{updatesErr}</div>}

                    <div className="mt-3 space-y-2 max-h-[340px] overflow-auto pr-1">
                      {updates.length === 0 && !loadingUpdates && (
                        <div className="text-sm opacity-70">No updates yet.</div>
                      )}

                      {updates.map((u) => (
                        <div
                          key={u.id}
                          className="rounded-xl border border-white/10 bg-black/25 p-3"
                        >
                          <div className="text-xs opacity-60">
                            {u.author_display_name_snapshot ?? "—"} · {fmtTime(u.created_at)} ·{" "}
                            {u.source}
                          </div>
                          <div className="mt-1 text-sm whitespace-pre-wrap">{u.message}</div>
                        </div>
                      ))}
                    </div>

                    <div className="mt-4">
                      <label className="text-xs opacity-70">Add update</label>
                      <textarea
                        value={updateText}
                        onChange={(e) => setUpdateText(e.target.value)}
                        placeholder="Short, PHI-free update…"
                        className="mt-1 w-full min-h-[90px] rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-sm outline-none"
                      />
                      <div className="mt-2 flex items-center justify-between">
                        <div className="text-xs opacity-60">
                          Stored with author snapshot (no names required).
                        </div>
                        <button
                          onClick={addUpdate}
                          disabled={postingUpdate || !updateText.trim()}
                          className={cx(
                            "rounded-xl border border-white/10 px-4 py-2 text-sm",
                            postingUpdate || !updateText.trim()
                              ? "bg-white/5 opacity-60"
                              : "bg-white/10 hover:bg-white/15"
                          )}
                        >
                          {postingUpdate ? "Posting…" : "Post"}
                        </button>
                      </div>
                    </div>
                  </div>
                </>
              )}
            </div>
          </aside>
        </div>
      </section>

      {/* MOBILE DRAWER */}
      {isMobile && selected && (
        <div className="fixed inset-0 z-[60]">
          {/* backdrop */}
          <button
            onClick={closeDrawer}
            className="absolute inset-0 bg-black/60"
            aria-label="Close drawer"
          />
          {/* sheet */}
          <div className="absolute left-0 right-0 bottom-0 rounded-t-3xl border-t border-white/10 bg-black/85 backdrop-blur p-4 max-h-[82vh] overflow-auto">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="text-xs opacity-70">
                  {selected.facility_id ?? "—"} · {selected.unit ?? "—"} · {fmtTime(selected.created_at)}
                </div>
                <div className="mt-2 text-lg font-semibold break-words">{selected.title}</div>
                <div className="mt-2 flex items-center gap-2 flex-wrap">
                  <span className="text-xs rounded-full px-2 py-1 border border-white/10 bg-white/5">
                    {selected.priority}
                  </span>
                  <span className="text-xs opacity-70">Shift: {selected.shift ?? "—"}</span>
                  {selected.status === "needs_followup" && (
                    <span className="text-xs rounded-full px-2 py-1 border border-sky-300/30 bg-sky-500/10">
                      Follow-up
                    </span>
                  )}
                  {selected.status === "resolved" && (
                    <span className="text-xs rounded-full px-2 py-1 border border-emerald-300/30 bg-emerald-500/10">
                      Resolved
                    </span>
                  )}
                </div>
              </div>

              <button
                onClick={closeDrawer}
                className="rounded-xl border border-white/10 bg-white/5 hover:bg-white/10 px-3 py-2 text-sm"
              >
                Close
              </button>
            </div>

            <div className="mt-3 flex items-center justify-between">
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={selected.status === "resolved"}
                  onChange={(e) => markResolved(e.target.checked)}
                />
                Resolved
              </label>
              <div className="text-xs opacity-60">{BUILD_TAG}</div>
            </div>

            <div className="mt-4 border-t border-white/10 pt-4">
              <div className="text-sm opacity-80">Updates</div>

              {loadingUpdates && <div className="mt-2 text-sm opacity-70">Loading…</div>}
              {updatesErr && <div className="mt-2 text-sm text-red-300">{updatesErr}</div>}

              <div className="mt-3 space-y-2">
                {updates.length === 0 && !loadingUpdates && (
                  <div className="text-sm opacity-70">No updates yet.</div>
                )}

                {updates.map((u) => (
                  <div key={u.id} className="rounded-xl border border-white/10 bg-black/40 p-3">
                    <div className="text-xs opacity-60">
                      {u.author_display_name_snapshot ?? "—"} · {fmtTime(u.created_at)} · {u.source}
                    </div>
                    <div className="mt-1 text-sm whitespace-pre-wrap">{u.message}</div>
                  </div>
                ))}
              </div>

              <div className="mt-4">
                <label className="text-xs opacity-70">Add update</label>
                <textarea
                  value={updateText}
                  onChange={(e) => setUpdateText(e.target.value)}
                  placeholder="Short, PHI-free update…"
                  className="mt-1 w-full min-h-[90px] rounded-xl border border-white/10 bg-black/40 px-3 py-2 text-sm outline-none"
                />
                <div className="mt-2 flex items-center justify-between">
                  <div className="text-xs opacity-60">author snapshot saved on insert</div>
                  <button
                    onClick={addUpdate}
                    disabled={postingUpdate || !updateText.trim()}
                    className={cx(
                      "rounded-xl border border-white/10 px-4 py-2 text-sm",
                      postingUpdate || !updateText.trim()
                        ? "bg-white/5 opacity-60"
                        : "bg-white/10 hover:bg-white/15"
                    )}
                  >
                    {postingUpdate ? "Posting…" : "Post"}
                  </button>
                </div>
              </div>
            </div>

            <div className="h-4" />
          </div>
        </div>
      )}
    </main>
  );
}

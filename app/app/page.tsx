"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { createClient, SupabaseClient } from "@supabase/supabase-js";

/**
 * v3.1 locked:
 * - BUILD_TAG shown in UI to confirm mobile is on latest deploy
 * - Sticky "+ Create handoff" (scroll + fixed for iOS reliability)
 * - Priority signal via BOX GLOW (boxShadow), border stays neutral
 * - Critical floats to top via client-side rank sort
 * - Mobile drawer for details + updates
 * - Ignore AbortError (no fake popups)
 * - handoffs insert payload matches DB (NO author_user_id / snapshot)
 * - updates table holds author_user_id + author_display_name_snapshot
 */

type Shift = "AM" | "PM" | "NOC";
type Priority = "Low" | "Normal" | "High" | "Critical";

type Handoff = {
  id: string;
  created_at: string;

  shift: Shift;
  location: string;
  priority: Priority;

  summary: string;
  details: string | null;

  needs_follow_up: boolean;
};

type UpdateSource = "app" | "sms" | "system";

type HandoffUpdate = {
  id: string;
  created_at: string;

  handoff_id: string;

  author_user_id: string;
  author_display_name_snapshot: string | null;

  source: UpdateSource;
  content: string;
};

function getSupabase(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !key) {
    throw new Error(
      "Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY. Check .env.local and restart dev server."
    );
  }

  return createClient(url, key, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
    },
  });
}

function formatWhen(iso: string) {
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function errToMsg(err: any) {
  return (
    err?.message ||
    err?.error_description ||
    err?.hint ||
    err?.details ||
    (typeof err === "string" ? err : JSON.stringify(err))
  );
}

function isAbortError(err: any) {
  return (
    err?.name === "AbortError" ||
    err?.message?.toLowerCase?.().includes("aborted") ||
    err?.code === "ERR_ABORTED"
  );
}

export default function Page() {
  // ✅ build marker so we can verify mobile is running the newest code
  const BUILD_TAG = "v3-sticky-boxglow-sort";

  const [supabase] = useState(() => getSupabase());

  // Auth
  const [session, setSession] = useState<any>(null);
  const [email, setEmail] = useState("");
  const [sendingLink, setSendingLink] = useState(false);

  // Display name snapshot (ONLY for handoff_updates inserts)
  const [displayName, setDisplayName] = useState("JD");

  // Data
  const [handoffs, setHandoffs] = useState<Handoff[]>([]);
  const [loading, setLoading] = useState(false);

  // Selection + thread
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [updates, setUpdates] = useState<HandoffUpdate[]>([]);
  const [newUpdate, setNewUpdate] = useState("");

  // Filters
  const [followUpOnly, setFollowUpOnly] = useState(false);
  const [locationFilter, setLocationFilter] = useState("");

  // Create form
  const [shift, setShift] = useState<Shift>("PM");
  const [location, setLocation] = useState("ED");
  const [priority, setPriority] = useState<Priority>("Normal");
  const [summary, setSummary] = useState("");
  const [details, setDetails] = useState("");
  const [needsFollowUp, setNeedsFollowUp] = useState(true);

  // Derived resolved index
  const [resolvedIds, setResolvedIds] = useState<Set<string>>(new Set());

  // Responsive
  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const mq = window.matchMedia("(max-width: 900px)");
    const apply = () => setIsMobile(mq.matches);
    apply();
    mq.addEventListener?.("change", apply);
    return () => mq.removeEventListener?.("change", apply);
  }, []);

  // Mobile drawer
  const [drawerOpen, setDrawerOpen] = useState(false);
  function openDrawerFor(id: string) {
    setSelectedId(id);
    setDrawerOpen(true);
  }
  function closeDrawer() {
    setDrawerOpen(false);
  }

  // Sticky create (bulletproof)
  const createRef = useRef<HTMLElement | null>(null);
  const [showStickyCreate, setShowStickyCreate] = useState(false);

  useEffect(() => {
    if (!isMobile) {
      setShowStickyCreate(false);
      return;
    }
    const onScroll = () => setShowStickyCreate(window.scrollY > 220);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [isMobile]);

  function scrollToCreate() {
    closeDrawer();
    createRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  // Guaranteed priority rank sort
  const rank: Record<Priority, number> = {
    Critical: 4,
    High: 3,
    Normal: 2,
    Low: 1,
  };

  // ✅ box glow visuals
  function cardBorder(_p: Priority, isResolved: boolean) {
    return isResolved ? "1px solid rgba(255,255,255,.10)" : "1px solid rgba(255,255,255,.14)";
  }

  function cardGlow(p: Priority, isResolved: boolean, needsFU: boolean) {
    if (isResolved) return "none";

    const boost = needsFU ? 1 : 0.65;

    const critical =
      `0 0 0 1px rgba(255,70,70,0.22), ` +
      `0 0 38px rgba(255,70,70,${0.28 * boost}), ` +
      `0 0 80px rgba(255,70,70,${0.12 * boost})`;

    const high =
      `0 0 0 1px rgba(255,165,0,0.18), ` +
      `0 0 32px rgba(255,165,0,${0.22 * boost}), ` +
      `0 0 70px rgba(255,165,0,${0.10 * boost})`;

    const low =
      `0 0 0 1px rgba(120,180,255,0.16), ` +
      `0 0 28px rgba(120,180,255,${0.18 * boost}), ` +
      `0 0 60px rgba(120,180,255,${0.08 * boost})`;

    const normal = needsFU
      ? `0 0 0 1px rgba(255,255,255,0.10), 0 0 18px rgba(255,255,255,0.10)`
      : "none";

    if (p === "Critical") return critical;
    if (p === "High") return high;
    if (p === "Low") return low;
    return normal;
  }

  // ---------------- AUTH ----------------
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: sub } = supabase.auth.onAuthStateChange((_evt, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, [supabase]);

  async function sendMagicLink() {
    if (!email.trim()) return;
    setSendingLink(true);
    const { error } = await supabase.auth.signInWithOtp({
      email: email.trim(),
      options: { emailRedirectTo: window.location.origin },
    });
    setSendingLink(false);
    if (error) alert(errToMsg(error));
    else alert("Magic link sent. Check your email.");
  }

  async function signOut() {
    await supabase.auth.signOut();
    setSelectedId(null);
    setUpdates([]);
    setHandoffs([]);
    setDrawerOpen(false);
  }

  // ---------------- LOADERS ----------------
  async function loadResolvedIndex(handoffIds: string[]) {
    if (handoffIds.length === 0) {
      setResolvedIds(new Set());
      return;
    }

    const { data, error } = await supabase
      .from("handoff_updates")
      .select("handoff_id, content, source")
      .in("handoff_id", handoffIds)
      .eq("source", "system")
      .ilike("content", "Marked as resolved%")
      .limit(500);

    if (error) {
      console.warn("Resolved index load warning:", error);
      setResolvedIds(new Set());
      return;
    }

    const s = new Set<string>();
    (data ?? []).forEach((r: any) => {
      if (r?.handoff_id) s.add(r.handoff_id);
    });
    setResolvedIds(s);
  }

  async function loadHandoffs() {
    setLoading(true);
    try {
      const { data: userRes, error: userErr } = await supabase.auth.getUser();
      if (userErr) throw userErr;
      if (!userRes?.user) {
        setHandoffs([]);
        setResolvedIds(new Set());
        return;
      }

      const { data, error } = await supabase
        .from("handoffs")
        .select("*")
        .order("created_at", { ascending: false });

      if (error) throw error;

      const rows = ((data ?? []) as Handoff[]).map((h) => ({
        ...h,
        details: h.details ?? null,
      }));

      // guaranteed sort: follow-up first, then priority rank, then newest
      rows.sort((a, b) => {
        const fu = (b.needs_follow_up ? 1 : 0) - (a.needs_follow_up ? 1 : 0);
        if (fu !== 0) return fu;

        const pr = (rank[b.priority] ?? 0) - (rank[a.priority] ?? 0);
        if (pr !== 0) return pr;

        return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
      });

      setHandoffs(rows);
      await loadResolvedIndex(rows.map((r) => r.id));
    } catch (err: any) {
      if (isAbortError(err)) return;
      console.error("LoadHandoffs FULL error:", err);
      alert("Error loading handoffs:\n" + errToMsg(err));
    } finally {
      setLoading(false);
    }
  }

  async function loadUpdates(handoffId: string) {
    setLoading(true);
    try {
      const { data: userRes, error: userErr } = await supabase.auth.getUser();
      if (userErr) throw userErr;
      if (!userRes?.user) {
        setUpdates([]);
        return;
      }

      const { data, error } = await supabase
        .from("handoff_updates")
        .select("*")
        .eq("handoff_id", handoffId)
        .order("created_at", { ascending: true });

      if (error) throw error;

      setUpdates((data ?? []) as HandoffUpdate[]);
    } catch (err: any) {
      if (isAbortError(err)) return;
      console.error("LoadUpdates FULL error:", err);
      alert("Error loading updates:\n" + errToMsg(err));
    } finally {
      setLoading(false);
    }
  }

  // ---------------- ACTIONS ----------------
  async function createHandoff() {
    if (!summary.trim()) {
      alert("Summary is required.");
      return;
    }

    setLoading(true);
    try {
      const { data: userRes, error: userErr } = await supabase.auth.getUser();
      if (userErr) throw userErr;
      const user = userRes?.user;
      if (!user) {
        alert("Please sign in first.");
        return;
      }

      // schema-aligned payload (NO author fields)
      const payload = {
        shift,
        location: location.trim(),
        priority,
        summary: summary.trim(),
        details: details.trim() || null,
        needs_follow_up: !!needsFollowUp,
      };

      const { error } = await supabase.from("handoffs").insert(payload);
      if (error) throw error;

      setSummary("");
      setDetails("");
      await loadHandoffs();

      if (isMobile) window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (err: any) {
      if (isAbortError(err)) return;
      console.error("Insert error:", err);
      alert("Error saving handoff:\n" + errToMsg(err));
    } finally {
      setLoading(false);
    }
  }

  async function markResolved(handoffId: string) {
    setLoading(true);
    try {
      const { data: userRes, error: userErr } = await supabase.auth.getUser();
      if (userErr) throw userErr;
      const user = userRes?.user;
      if (!user) {
        alert("Please sign in first.");
        return;
      }

      const { error } = await supabase.from("handoff_updates").insert({
        handoff_id: handoffId,
        author_user_id: user.id,
        author_display_name_snapshot: displayName?.trim() || null,
        source: "system",
        content: "Marked as resolved",
      });

      if (error) throw error;

      await loadHandoffs();
      if (selectedId === handoffId) await loadUpdates(handoffId);
    } catch (err: any) {
      if (isAbortError(err)) return;
      console.error("Resolve error:", err);
      alert("Error marking resolved:\n" + errToMsg(err));
    } finally {
      setLoading(false);
    }
  }

  async function addUpdate() {
    if (!selectedId) {
      alert("Select a handoff first.");
      return;
    }
    if (!newUpdate.trim()) return;

    setLoading(true);
    try {
      const { data: userRes, error: userErr } = await supabase.auth.getUser();
      if (userErr) throw userErr;
      const user = userRes?.user;
      if (!user) {
        alert("Please sign in first.");
        return;
      }

      const { error } = await supabase.from("handoff_updates").insert({
        handoff_id: selectedId,
        author_user_id: user.id,
        author_display_name_snapshot: displayName?.trim() || null,
        source: "app",
        content: newUpdate.trim(),
      });

      if (error) throw error;

      setNewUpdate("");
      await loadUpdates(selectedId);
    } catch (err: any) {
      if (isAbortError(err)) return;
      console.error("Add update error:", err);
      alert("Error adding update:\n" + errToMsg(err));
    } finally {
      setLoading(false);
    }
  }

  // ---------------- EFFECTS ----------------
  useEffect(() => {
    if (session) loadHandoffs();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);

  useEffect(() => {
    if (selectedId) loadUpdates(selectedId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  // ---------------- DERIVED UI ----------------
  const totalCount = handoffs.length;

  const filtered = useMemo(() => {
    const locQ = locationFilter.trim().toLowerCase();

    return handoffs.filter((h) => {
      const isResolved = resolvedIds.has(h.id);

      if (followUpOnly) {
        if (isResolved) return false;
        if (!h.needs_follow_up) return false;
      }

      if (locQ) {
        const loc = (h.location || "").toLowerCase();
        if (!loc.includes(locQ)) return false;
      }

      return true;
    });
  }, [handoffs, followUpOnly, locationFilter, resolvedIds]);

  const selected = useMemo(
    () => (selectedId ? handoffs.find((h) => h.id === selectedId) ?? null : null),
    [handoffs, selectedId]
  );

  // ---------------- AUTH GATE ----------------
  if (!session) {
    return (
      <div style={{ maxWidth: 560, margin: "0 auto", padding: isMobile ? 14 : 20 }}>
        <header style={{ marginBottom: 16 }}>
          <h1 style={{ fontSize: 34, fontWeight: 800, margin: 0 }}>Central Supply Handoff</h1>
          <p style={{ marginTop: 6, opacity: 0.75 }}>
            Sign in with a magic link (required for RLS).
          </p>
          <div style={{ opacity: 0.45, fontSize: 12, marginTop: 6 }}>Build: {BUILD_TAG}</div>
        </header>

        <div style={{ border: "1px solid rgba(255,255,255,.12)", borderRadius: 16, padding: 16 }}>
          <input
            placeholder="your@email.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            style={{ ...inputStyle, width: "100%" }}
          />

          <button
            onClick={sendMagicLink}
            disabled={sendingLink || !email.trim()}
            style={{ ...btnStyle, width: "100%", marginTop: 12 }}
          >
            {sendingLink ? "Sending…" : "Send magic link"}
          </button>
        </div>
      </div>
    );
  }

  // ---------------- MAIN UI ----------------
  return (
    <div style={{ maxWidth: 1100, margin: "0 auto", padding: isMobile ? 14 : 20 }}>
      {/* Sticky create (mobile, fixed) */}
      {isMobile && showStickyCreate && (
        <div
          style={{
            position: "fixed",
            top: 10,
            left: 14,
            right: 14,
            zIndex: 9999,
            padding: 10,
            borderRadius: 14,
            border: "1px solid rgba(255,255,255,.12)",
            background: "rgba(10,10,10,0.92)",
            backdropFilter: "blur(10px)",
          }}
        >
          <button onClick={scrollToCreate} style={{ ...btnStyle, width: "100%", fontWeight: 900 }}>
            + Create handoff
          </button>
        </div>
      )}
      {isMobile && showStickyCreate && <div style={{ height: 64 }} />}

      <header style={{ marginBottom: 16 }}>
        <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          <div>
            <h1 style={{ fontSize: 34, fontWeight: 800, margin: 0 }}>Central Supply Handoff</h1>
            <p style={{ marginTop: 6, opacity: 0.75 }}>
              Append-only handoff log (Supabase system of record).
            </p>
            <div style={{ opacity: 0.45, fontSize: 12, marginTop: 6 }}>Build: {BUILD_TAG}</div>
          </div>

          <div
            style={{
              marginLeft: isMobile ? 0 : "auto",
              width: isMobile ? "100%" : "auto",
              display: "flex",
              gap: 10,
              alignItems: "center",
              justifyContent: isMobile ? "space-between" : "flex-end",
            }}
          >
            <input
              placeholder="Display name (optional)"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              style={{
                ...inputStyle,
                minWidth: isMobile ? 0 : 200,
                flex: isMobile ? 1 : "unset",
              }}
            />
            <button onClick={signOut} style={btnStyle}>
              Sign out
            </button>
          </div>
        </div>
      </header>

      {/* Filters */}
      <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", marginBottom: 16 }}>
        <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input type="checkbox" checked={followUpOnly} onChange={(e) => setFollowUpOnly(e.target.checked)} />
          Follow-up only
        </label>

        <input
          placeholder="Filter location…"
          value={locationFilter}
          onChange={(e) => setLocationFilter(e.target.value)}
          style={{ ...inputStyle, minWidth: isMobile ? 0 : 220, flex: isMobile ? 1 : "unset" }}
        />

        <div style={{ marginLeft: "auto", opacity: 0.8 }}>
          Showing <b>{filtered.length}</b> / <b>{totalCount}</b>
        </div>

        <button onClick={loadHandoffs} disabled={loading} style={btnStyle}>
          {loading ? "Loading…" : "Refresh"}
        </button>
      </div>

      {/* Create section */}
      <section
        ref={(el) => (createRef.current = el)}
        style={{
          border: "1px solid rgba(255,255,255,.12)",
          borderRadius: 16,
          padding: 16,
          marginBottom: 18,
        }}
      >
        <h2 style={{ margin: 0, marginBottom: 12, fontSize: 18 }}>Create handoff</h2>

        <div style={{ display: "grid", gap: 10, gridTemplateColumns: isMobile ? "1fr 1fr" : "1fr 1fr 1fr 1fr" }}>
          <select value={shift} onChange={(e) => setShift(e.target.value as Shift)} style={inputStyle}>
            <option value="AM">AM</option>
            <option value="PM">PM</option>
            <option value="NOC">NOC</option>
          </select>

          <input placeholder="Location" value={location} onChange={(e) => setLocation(e.target.value)} style={inputStyle} />

          <select value={priority} onChange={(e) => setPriority(e.target.value as Priority)} style={inputStyle}>
            <option value="Normal">Normal</option>
            <option value="High">High</option>
            <option value="Critical">Critical</option>
            <option value="Low">Low</option>
          </select>

          <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input type="checkbox" checked={needsFollowUp} onChange={(e) => setNeedsFollowUp(e.target.checked)} />
            Follow-up
          </label>
        </div>

        <div style={{ marginTop: 10 }}>
          <input placeholder="Summary (required)" value={summary} onChange={(e) => setSummary(e.target.value)} style={{ ...inputStyle, width: "100%" }} />
        </div>

        <div style={{ marginTop: 10 }}>
          <textarea placeholder="Details (optional)…" value={details} onChange={(e) => setDetails(e.target.value)} rows={4} style={{ ...inputStyle, width: "100%", resize: "vertical" }} />
        </div>

        <button onClick={createHandoff} disabled={loading} style={{ ...btnStyle, width: "100%", marginTop: 12, fontWeight: 800 }}>
          {loading ? "Saving…" : "Save handoff"}
        </button>
      </section>

      {/* List */}
      <section style={{ display: "grid", gap: 12 }}>
        {filtered.map((h) => {
          const isResolved = resolvedIds.has(h.id);
          return (
            <button
              key={h.id}
              onClick={() => (isMobile ? openDrawerFor(h.id) : setSelectedId(h.id))}
              style={{
                textAlign: "left",
                width: "100%",
                borderRadius: 16,
                padding: isMobile ? 12 : 14,
                border: cardBorder(h.priority, isResolved),
                boxShadow: cardGlow(h.priority, isResolved, h.needs_follow_up),
                transform: "translateZ(0)",
                opacity: isResolved ? 0.65 : 1,
                background: "transparent",
                cursor: "pointer",
              }}
            >
              <div style={{ display: "flex", gap: 10, alignItems: "baseline", flexWrap: "wrap" }}>
                <div style={{ fontWeight: 900, letterSpacing: 0.3 }}>{h.location.toUpperCase()}</div>
                <div style={{ opacity: 0.8 }}>{h.shift} · {formatWhen(h.created_at)}</div>

                <div style={{ marginLeft: "auto", opacity: 0.8 }}>
                  {h.priority}
                  {isResolved ? " · Resolved" : ""}
                  {h.needs_follow_up ? " · FOLLOW-UP" : ""}
                </div>
              </div>

              <div style={{ marginTop: 8, fontSize: isMobile ? 16 : 18, fontWeight: 900 }}>
                {h.summary.toUpperCase()}
              </div>

              {h.details ? <div style={{ marginTop: 6, opacity: 0.9, whiteSpace: "pre-wrap" }}>{h.details}</div> : null}
            </button>
          );
        })}
      </section>

      {/* Mobile Drawer */}
      {isMobile && drawerOpen && (
        <div
          onClick={closeDrawer}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.55)",
            zIndex: 9999,
            display: "flex",
            alignItems: "flex-end",
            justifyContent: "center",
            padding: 12,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              width: "100%",
              maxWidth: 760,
              borderRadius: 18,
              border: "1px solid rgba(255,255,255,.14)",
              background: "rgba(10,10,10,0.98)",
              boxShadow: "0 20px 60px rgba(0,0,0,0.55)",
              overflow: "hidden",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 12px", borderBottom: "1px solid rgba(255,255,255,.10)" }}>
              <div style={{ fontWeight: 800, opacity: 0.9 }}>Handoff</div>
              <button onClick={closeDrawer} style={{ ...btnStyle, padding: "8px 10px" }}>Close</button>
            </div>

            <div style={{ padding: 12 }}>
              {!selected ? (
                <div style={{ opacity: 0.75 }}>Select a handoff…</div>
              ) : (
                <>
                  <div style={{ display: "grid", gap: 6 }}>
                    <div style={{ fontWeight: 900, fontSize: 16 }}>{selected.location.toUpperCase()} · {selected.shift}</div>
                    <div style={{ opacity: 0.8, fontSize: 13 }}>{formatWhen(selected.created_at)}</div>
                    <div style={{ fontWeight: 900, fontSize: 18 }}>{selected.summary}</div>
                    {selected.details ? <div style={{ opacity: 0.9, whiteSpace: "pre-wrap" }}>{selected.details}</div> : null}
                    <div style={{ opacity: 0.8, fontSize: 13 }}>
                      {selected.priority} · {selected.needs_follow_up ? "FOLLOW-UP" : "—"} · {resolvedIds.has(selected.id) ? "Resolved" : "Open"}
                    </div>
                  </div>

                  <div style={{ display: "flex", gap: 10, marginTop: 12 }}>
                    {!resolvedIds.has(selected.id) && (
                      <button onClick={() => markResolved(selected.id)} disabled={loading} style={{ ...btnStyle, flex: 1 }}>
                        Mark resolved
                      </button>
                    )}
                    <button onClick={closeDrawer} style={{ ...btnStyle, flex: 1, opacity: 0.9 }}>Back</button>
                  </div>

                  <hr style={{ margin: "16px 0", opacity: 0.25 }} />

                  <div style={{ display: "flex", gap: 10, marginTop: 12 }}>
                    <input placeholder="Add an update…" value={newUpdate} onChange={(e) => setNewUpdate(e.target.value)} style={{ ...inputStyle, flex: 1 }} />
                    <button onClick={addUpdate} disabled={loading || !newUpdate.trim()} style={btnStyle}>Add</button>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  padding: "10px 12px",
  borderRadius: 12,
  border: "1px solid rgba(255,255,255,.15)",
  background: "transparent",
  outline: "none",
};

const btnStyle: React.CSSProperties = {
  padding: "10px 12px",
  borderRadius: 12,
  border: "1px solid rgba(255,255,255,.15)",
  background: "transparent",
  cursor: "pointer",
  fontWeight: 700,
};

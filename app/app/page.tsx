"use client";

import React, { useEffect, useMemo, useState } from "react";
import { createClient, SupabaseClient } from "@supabase/supabase-js";

/**
 * Canon schema (append-only):
 * - public.handoffs: immutable base record
 * - public.handoff_updates: append-only updates (includes "Marked as resolved")
 */

type Shift = "AM" | "PM" | "NOC";
type Priority = "Low" | "Normal" | "High" | "Critical";

type Handoff = {
  id: string;
  created_at: string;

  author_user_id: string;
  author_display_name_snapshot: string | null;

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

export default function Page() {
  const [supabase] = useState(() => getSupabase());

  // Auth
  const [session, setSession] = useState<any>(null);
  const [email, setEmail] = useState("");
  const [sendingLink, setSendingLink] = useState(false);

  // Display name (optional, snapshot)
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

  // Derived "resolved" (from updates)
  const [resolvedIds, setResolvedIds] = useState<Set<string>>(new Set());

  // ---------------- AUTH WIRING ----------------
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
  }

  // ---------------- LOADERS ----------------
  async function loadHandoffs() {
    setLoading(true);
    try {
      // ✅ Guard: only query when authenticated (RLS)
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
        .order("needs_follow_up", { ascending: false })
        .order("priority", { ascending: false })
        .order("created_at", { ascending: false });

      if (error) throw error;

      const rows = ((data ?? []) as Handoff[]).map((h) => ({
        ...h,
        author_display_name_snapshot: h.author_display_name_snapshot ?? null,
        details: h.details ?? null,
      }));

      setHandoffs(rows);

      // ✅ derive resolved from append-only updates
      await loadResolvedIndex(rows.map((r) => r.id));
    } catch (err: any) {
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
      console.error("LoadUpdates FULL error:", err);
      alert("Error loading updates:\n" + errToMsg(err));
    } finally {
      setLoading(false);
    }
  }

  // Pull recent "Marked as resolved" events and build a Set of resolved handoff_ids
  async function loadResolvedIndex(handoffIds: string[]) {
    if (handoffIds.length === 0) {
      setResolvedIds(new Set());
      return;
    }

    // Keep it light: only fetch system events for these handoffs
    const { data, error } = await supabase
      .from("handoff_updates")
      .select("handoff_id, created_at, content, source")
      .in("handoff_id", handoffIds)
      .eq("source", "system")
      .ilike("content", "Marked as resolved%")
      .order("created_at", { ascending: false })
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

      const payload = {
        author_user_id: user.id,
        author_display_name_snapshot: displayName?.trim() || null,

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
    } catch (err: any) {
      console.error("Insert error:", err);
      alert("Error saving handoff:\n" + errToMsg(err));
    } finally {
      setLoading(false);
    }
  }

  // ✅ Append-only "resolve": insert an update event (NO updates to handoffs)
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

      // Refresh
      await loadHandoffs();
      if (selectedId === handoffId) await loadUpdates(handoffId);
    } catch (err: any) {
      console.error("Resolve error:", err);
      alert("Error marking resolved:\n" + errToMsg(err));
    } finally {
      setLoading(false);
    }
  }

  // ✅ Append-only user update
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
      console.error("Add update error:", err);
      alert("Error adding update:\n" + errToMsg(err));
    } finally {
      setLoading(false);
    }
  }

  // ❌ No delete in append-only model
  async function deleteHandoffBlocked() {
    alert("Delete is disabled. This system is append-only (audit-safe).");
  }

  // ---------------- EFFECTS ----------------
  useEffect(() => {
    // Load only after session exists (RLS)
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

      // Follow-up only = unresolved + needs follow-up (action queue)
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
      <div style={{ maxWidth: 560, margin: "0 auto", padding: 20 }}>
        <header style={{ marginBottom: 16 }}>
          <h1 style={{ fontSize: 34, fontWeight: 800, margin: 0 }}>Central Supply Handoff</h1>
          <p style={{ marginTop: 6, opacity: 0.75 }}>
            Sign in with a magic link (required for RLS).
          </p>
        </header>

        <div
          style={{
            border: "1px solid rgba(255,255,255,.12)",
            borderRadius: 16,
            padding: 16,
          }}
        >
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

          <p style={{ marginTop: 10, opacity: 0.7, fontSize: 13 }}>
            After you click the email link, you’ll come back here signed in.
          </p>
        </div>
      </div>
    );
  }

  // ---------------- MAIN UI ----------------
  return (
    <div style={{ maxWidth: 1100, margin: "0 auto", padding: 20 }}>
      <header style={{ marginBottom: 16 }}>
        <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
          <div>
            <h1 style={{ fontSize: 34, fontWeight: 800, margin: 0 }}>Central Supply Handoff</h1>
            <p style={{ marginTop: 6, opacity: 0.75 }}>
              Append-only handoff log (Supabase system of record).
            </p>
          </div>

          <div style={{ marginLeft: "auto", display: "flex", gap: 10, alignItems: "center" }}>
            <input
              placeholder="Display name (optional)"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              style={{ ...inputStyle, minWidth: 200 }}
            />
            <button onClick={signOut} style={btnStyle}>
              Sign out
            </button>
          </div>
        </div>
      </header>

      {/* Filters */}
      <div
        style={{
          display: "flex",
          gap: 12,
          alignItems: "center",
          flexWrap: "wrap",
          marginBottom: 16,
        }}
      >
        <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input
            type="checkbox"
            checked={followUpOnly}
            onChange={(e) => setFollowUpOnly(e.target.checked)}
          />
          Follow-up only
        </label>

        <input
          placeholder="Filter location…"
          value={locationFilter}
          onChange={(e) => setLocationFilter(e.target.value)}
          style={{
            ...inputStyle,
            minWidth: 220,
          }}
        />

        <div style={{ marginLeft: "auto", opacity: 0.8 }}>
          Showing <b>{filtered.length}</b> / <b>{totalCount}</b>
        </div>

        <button onClick={loadHandoffs} disabled={loading} style={btnStyle}>
          {loading ? "Loading…" : "Refresh"}
        </button>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        {/* Create handoff */}
        <section
          style={{
            border: "1px solid rgba(255,255,255,.12)",
            borderRadius: 16,
            padding: 16,
            marginBottom: 18,
          }}
        >
          <h2 style={{ margin: 0, marginBottom: 12, fontSize: 18 }}>Create handoff</h2>

          <div style={{ display: "grid", gap: 10, gridTemplateColumns: "1fr 1fr 1fr 1fr" }}>
            <select value={shift} onChange={(e) => setShift(e.target.value as Shift)} style={inputStyle}>
              <option value="AM">AM</option>
              <option value="PM">PM</option>
              <option value="NOC">NOC</option>
            </select>

            <input
              placeholder="Location"
              value={location}
              onChange={(e) => setLocation(e.target.value)}
              style={inputStyle}
            />

            <select value={priority} onChange={(e) => setPriority(e.target.value as Priority)} style={inputStyle}>
              <option value="Normal">Normal</option>
              <option value="High">High</option>
              <option value="Critical">Critical</option>
              <option value="Low">Low</option>
            </select>

            <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <input
                type="checkbox"
                checked={needsFollowUp}
                onChange={(e) => setNeedsFollowUp(e.target.checked)}
              />
              Follow-up
            </label>
          </div>

          <div style={{ marginTop: 10 }}>
            <input
              placeholder="Summary (required)"
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
              style={{ ...inputStyle, width: "100%" }}
            />
          </div>

          <div style={{ marginTop: 10 }}>
            <textarea
              placeholder="Details (optional)…"
              value={details}
              onChange={(e) => setDetails(e.target.value)}
              rows={4}
              style={{ ...inputStyle, width: "100%", resize: "vertical" }}
            />
          </div>

          <button
            onClick={createHandoff}
            disabled={loading}
            style={{ ...btnStyle, width: "100%", marginTop: 12, fontWeight: 800 }}
          >
            {loading ? "Saving…" : "Save handoff"}
          </button>

          <p style={{ marginTop: 10, opacity: 0.7, fontSize: 13 }}>
            Note: This log is append-only. No edits, no deletes—only new entries and updates.
          </p>
        </section>

        {/* Thread / updates */}
        <section
          style={{
            border: "1px solid rgba(255,255,255,.12)",
            borderRadius: 16,
            padding: 16,
            marginBottom: 18,
          }}
        >
          <h2 style={{ margin: 0, marginBottom: 12, fontSize: 18 }}>Updates</h2>

          {!selected ? (
            <div style={{ opacity: 0.7 }}>Select a handoff from the list to view or add updates.</div>
          ) : (
            <>
              <div style={{ display: "grid", gap: 6 }}>
                <div style={{ fontWeight: 900 }}>{selected.location.toUpperCase()}</div>
                <div style={{ opacity: 0.8 }}>
                  {selected.shift} · {formatWhen(selected.created_at)} ·{" "}
                  {selected.author_display_name_snapshot ? `by ${selected.author_display_name_snapshot}` : ""}
                </div>
                <div style={{ fontWeight: 900 }}>{selected.summary}</div>
                {selected.details ? <div style={{ opacity: 0.9, whiteSpace: "pre-wrap" }}>{selected.details}</div> : null}
                <div style={{ opacity: 0.8 }}>
                  {selected.priority} · {selected.needs_follow_up ? "FOLLOW-UP" : "—"} ·{" "}
                  {resolvedIds.has(selected.id) ? "Resolved" : "Open"}
                </div>
              </div>

              <div style={{ marginTop: 12, display: "flex", gap: 10 }}>
                {!resolvedIds.has(selected.id) && (
                  <button onClick={() => markResolved(selected.id)} disabled={loading} style={btnStyle}>
                    Mark resolved
                  </button>
                )} 
              </div>

              <hr style={{ margin: "16px 0", opacity: 0.25 }} />

              <div style={{ display: "grid", gap: 10 }}>
                {updates.map((u) => (
                  <div
                    key={u.id}
                    style={{
                      borderRadius: 12,
                      padding: 10,
                      border: "1px solid rgba(255,255,255,.10)",
                      opacity: 0.95,
                    }}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 10, fontSize: 12, opacity: 0.8 }}>
                      <div>
                        {(u.author_display_name_snapshot ?? "—")} · {u.source}
                      </div>
                      <div>{formatWhen(u.created_at)}</div>
                    </div>
                    <div style={{ marginTop: 6, whiteSpace: "pre-wrap" }}>{u.content}</div>
                  </div>
                ))}

                {updates.length === 0 && <div style={{ opacity: 0.7 }}>No updates yet.</div>}
              </div>

              <div style={{ display: "flex", gap: 10, marginTop: 12 }}>
                <input
                  placeholder="Add an update (append-only)…"
                  value={newUpdate}
                  onChange={(e) => setNewUpdate(e.target.value)}
                  style={{ ...inputStyle, flex: 1 }}
                />
                <button onClick={addUpdate} disabled={loading || !newUpdate.trim()} style={btnStyle}>
                  Add
                </button>
              </div>
            </>
          )}
        </section>
      </div>

      {/* List */}
      <section style={{ display: "grid", gap: 12 }}>
        {filtered.map((h) => {
          const isResolved = resolvedIds.has(h.id);

          return (
            <button
              key={h.id}
              onClick={() => setSelectedId(h.id)}
              style={{
                textAlign: "left",
                width: "100%",
                borderRadius: 16,
                padding: 14,
                border: `1px solid ${isResolved ? "rgba(255,255,255,.10)" : "rgba(255,165,0,.35)"}`,
                opacity: isResolved ? 0.65 : 1,
                background: "transparent",
                cursor: "pointer",
              }}
            >
              <div style={{ display: "flex", gap: 10, alignItems: "baseline", flexWrap: "wrap" }}>
                <div style={{ fontWeight: 900, letterSpacing: 0.3 }}>{h.location.toUpperCase()}</div>

                <div style={{ opacity: 0.8 }}>
                  {h.shift} · {formatWhen(h.created_at)}
                  {h.author_display_name_snapshot ? ` · by ${h.author_display_name_snapshot}` : ""}
                </div>

                <div style={{ marginLeft: "auto", opacity: 0.8 }}>
                  {h.priority}
                  {isResolved ? " · Resolved" : ""}
                  {h.needs_follow_up ? " · FOLLOW-UP" : ""}
                </div>
              </div>

              <div style={{ marginTop: 8, fontSize: 18, fontWeight: 900 }}>
                {h.summary.toUpperCase()}
              </div>

              {h.details ? (
                <div style={{ marginTop: 6, opacity: 0.9, whiteSpace: "pre-wrap" }}>{h.details}</div>
              ) : null}
            </button>
          );
        })}

        {!loading && filtered.length === 0 && (
          <div style={{ opacity: 0.7, padding: 12 }}>No handoffs match your filters.</div>
        )}
      </section>
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

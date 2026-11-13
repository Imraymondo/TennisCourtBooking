"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import Link from "next/link";
import type { AttendanceCallSummary } from "@/lib/attendance";
import {
  COURTS,
  TIME_ZONE,
  type Booking,
  type BookingInput,
  type Channel,
} from "@/lib/domain";

const sources: Record<Channel, string> = {
  web: "Web",
  phone: "Phone",
  sms: "SMS",
  email: "Email",
  staff: "Staff",
};

const attendanceLabels: Record<AttendanceCallSummary["status"], string> = {
  requesting: "Requesting a call…",
  queued: "Call queued. Waiting to connect.",
  ringing: "Ringing. Waiting for the customer to answer…",
  "in-progress": "Call in progress. Waiting for attendance confirmation.",
  attending: "Attendance confirmed.",
  cancelled: "Attendance updated. Refresh to see the booking status.",
  unanswered: "No answer. The booking remains confirmed.",
  completed:
    "Call ended without attendance confirmation. The booking remains confirmed.",
  failed: "Call failed. The booking remains confirmed.",
  unknown: "Call status is unknown. Refresh the schedule before trying again.",
  stale:
    "The booking has changed. This call does not confirm the current booking.",
};

class RequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    cache: "no-store",
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  const data = await response.json().catch(() => {
    if (response.ok)
      throw new Error("The server response was incomplete. Please try again.");
    return {};
  });
  if (!response.ok)
    throw new RequestError(
      data.error || "The request failed. Please try again later.",
      response.status,
    );
  return data as T;
}

function localStart(iso: string) {
  const parts = new Intl.DateTimeFormat("en-AU", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(iso));
  const value = (type: string) =>
    parts.find((part) => part.type === type)!.value;
  return `${value("year")}-${value("month")}-${value("day")}T${value("hour")}:${value("minute")}`;
}

function prettyTime(iso: string) {
  return new Intl.DateTimeFormat("en-AU", {
    timeZone: TIME_ZONE,
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(iso));
}

function attendanceStatus(booking: Booking, call?: AttendanceCallSummary) {
  if (booking.status === "cancelled") {
    return call?.status === "cancelled"
      ? "The customer cannot attend. The booking has been cancelled."
      : "The booking has been cancelled.";
  }
  if (call) {
    if (call.status === "stale" || call.bookingVersion !== booking.version)
      return "The booking has changed. This call does not confirm the current booking.";
    return attendanceLabels[call.status];
  }
  if (!booking.phone.trim())
    return "Add a phone number to confirm attendance by phone.";
  if (new Date(booking.startsAt).getTime() <= Date.now())
    return "The booking has already started. Attendance calls are unavailable.";
  return "Call the customer to confirm they will attend on time.";
}

export default function AdminConsole({ initialDate }: { initialDate: string }) {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [password, setPassword] = useState("");
  const [loginBusy, setLoginBusy] = useState(false);
  const [date, setDate] = useState(initialDate);
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [loadedDate, setLoadedDate] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);
  const [editor, setEditor] = useState<{ booking?: Booking } | null>(null);
  const [cancelId, setCancelId] = useState<string | null>(null);
  const [cancelBusy, setCancelBusy] = useState(false);
  const [attendanceCalls, setAttendanceCalls] = useState<
    Record<string, AttendanceCallSummary>
  >({});
  const [callPending, setCallPending] = useState<Record<string, boolean>>({});
  const [callIssues, setCallIssues] = useState<Record<string, string>>({});
  const pendingCalls = useRef(new Set<string>());
  const callRequests = useRef(
    new Map<
      string,
      { version: number; requestId: string; previousCallId?: string }
    >(),
  );

  const expireSession = useCallback(() => {
    setAuthenticated(false);
    setBookings([]);
    setLoadedDate("");
    setAttendanceCalls({});
    setCallPending({});
    setCallIssues({});
    pendingCalls.current.clear();
    callRequests.current.clear();
    setEditor(null);
    setCancelId(null);
    setNotice("");
  }, []);

  useEffect(() => {
    let active = true;
    api<{ authenticated: boolean }>("/api/admin/session")
      .then((data) => {
        if (active) setAuthenticated(data.authenticated);
      })
      .catch((err: Error) => {
        if (active) {
          setAuthenticated(false);
          setError(err.message);
        }
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!authenticated) return;
    const controller = new AbortController();
    let current = true;
    const load = async () => {
      try {
        const data = await api<{
          bookings: Booking[];
          attendanceCalls: Record<string, AttendanceCallSummary>;
        }>(`/api/bookings?date=${encodeURIComponent(date)}`, {
          signal: controller.signal,
        });
        if (current) {
          setBookings(data.bookings);
          const calls = data.attendanceCalls || {};
          setAttendanceCalls(calls);
          const resolved: string[] = [];
          for (const [bookingId, request] of callRequests.current) {
            const booking = data.bookings.find((item) => item.id === bookingId);
            const call = calls[bookingId];
            if (
              (booking && booking.version !== request.version) ||
              (call && call.id !== request.previousCallId)
            ) {
              callRequests.current.delete(bookingId);
              resolved.push(bookingId);
            }
          }
          if (resolved.length)
            setCallIssues((previous) => {
              const next = { ...previous };
              for (const bookingId of resolved) delete next[bookingId];
              return next;
            });
          setLoadedDate(date);
          setError("");
        }
      } catch (err) {
        if (!current || (err instanceof Error && err.name === "AbortError"))
          return;
        if (err instanceof RequestError && err.status === 401) {
          expireSession();
        }
        setError(
          err instanceof Error ? err.message : "Unable to load bookings.",
        );
      }
    };
    void load();
    const interval = setInterval(() => {
      void load();
    }, 30_000);
    return () => {
      current = false;
      controller.abort();
      clearInterval(interval);
    };
  }, [authenticated, date, refreshKey, expireSession]);

  async function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoginBusy(true);
    setError("");
    try {
      await api("/api/admin/login", {
        method: "POST",
        body: JSON.stringify({ password }),
      });
      setPassword("");
      setAuthenticated(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to sign in.");
    } finally {
      setLoginBusy(false);
    }
  }

  async function logout() {
    setError("");
    try {
      await api("/api/admin/logout", { method: "POST", body: "{}" });
      expireSession();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to sign out.");
    }
  }

  const saved = useCallback(() => {
    setRefreshKey((value) => value + 1);
    setNotice("Booking saved. The court schedule has been updated.");
  }, []);

  async function cancel(booking: Booking) {
    setCancelBusy(true);
    setError("");
    try {
      await api(`/api/bookings/${booking.id}`, {
        method: "DELETE",
        body: JSON.stringify({ version: booking.version }),
      });
      setCancelId(null);
      setRefreshKey((value) => value + 1);
      setNotice(
        `Booking ${booking.id} cancelled. The time slot is available again.`,
      );
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Unable to cancel the booking.",
      );
      if (err instanceof RequestError && err.status === 409) {
        setRefreshKey((value) => value + 1);
        setCancelId(null);
      }
      if (err instanceof RequestError && err.status === 401) expireSession();
    } finally {
      setCancelBusy(false);
    }
  }

  async function confirmAttendance(booking: Booking) {
    const call = attendanceCalls[booking.id];
    if (
      pendingCalls.current.has(booking.id) ||
      booking.status !== "confirmed" ||
      !booking.phone.trim() ||
      new Date(booking.startsAt).getTime() <= Date.now() ||
      (call && !call.canRetry)
    )
      return;

    pendingCalls.current.add(booking.id);
    setCallPending((previous) => ({ ...previous, [booking.id]: true }));
    setCallIssues((previous) => ({ ...previous, [booking.id]: "" }));
    setError("");
    setNotice("");
    try {
      let request = callRequests.current.get(booking.id);
      if (!request || request.version !== booking.version) {
        request = {
          version: booking.version,
          requestId: crypto.randomUUID(),
          previousCallId: call?.id,
        };
        callRequests.current.set(booking.id, request);
      }
      const data = await api<{ attendanceCall: AttendanceCallSummary }>(
        `/api/admin/bookings/${encodeURIComponent(booking.id)}/attendance-call`,
        {
          method: "POST",
          body: JSON.stringify({
            version: request.version,
            requestId: request.requestId,
          }),
        },
      );
      const result = data.attendanceCall;
      if (
        !result ||
        typeof result.id !== "string" ||
        !result.id ||
        result.bookingId !== booking.id ||
        !Number.isInteger(result.bookingVersion) ||
        !Object.hasOwn(attendanceLabels, result.status) ||
        typeof result.canRetry !== "boolean"
      )
        throw new Error("The call response was incomplete.");
      callRequests.current.delete(booking.id);
      setAttendanceCalls((previous) => ({
        ...previous,
        [booking.id]: result,
      }));
      setNotice(`Booking ${booking.id}: attendance call requested.`);
      setRefreshKey((value) => value + 1);
    } catch (err) {
      if (err instanceof RequestError && err.status === 401) {
        expireSession();
        setError(err.message);
      } else if (err instanceof RequestError && err.status === 409) {
        callRequests.current.delete(booking.id);
        setError(err.message);
        setRefreshKey((value) => value + 1);
      } else if (err instanceof RequestError && err.status < 500) {
        callRequests.current.delete(booking.id);
        setCallIssues((previous) => ({
          ...previous,
          [booking.id]: err.message,
        }));
      } else {
        setCallIssues((previous) => ({
          ...previous,
          [booking.id]:
            "The call request could not be confirmed. Refresh the schedule to check its status, or try again.",
        }));
        setRefreshKey((value) => value + 1);
      }
    } finally {
      pendingCalls.current.delete(booking.id);
      setCallPending((previous) => ({ ...previous, [booking.id]: false }));
    }
  }

  const visibleBookings = loadedDate === date ? bookings : [];
  return (
    <main className="admin-shell">
      <header className="admin-header">
        <Link href="/" className="admin-brand">
          COURTSIDE<span>Staff console</span>
        </Link>
        <div className="admin-header-actions">
          <Link href="/">Back to booking ↗</Link>
          {authenticated && (
            <button
              type="button"
              className="admin-button admin-button-subtle"
              onClick={logout}
            >
              Sign out
            </button>
          )}
        </div>
      </header>
      {authenticated === null ? (
        <p className="admin-loading" role="status">
          Checking your session…
        </p>
      ) : !authenticated ? (
        <section className="admin-login">
          <p className="admin-kicker">STAFF ACCESS</p>
          <h1>
            Keep every booking
            <br />
            running smoothly.
          </h1>
          <p>
            Sign in to view contact details and manage bookings from the web,
            phone, SMS and email.
          </p>
          <form onSubmit={login}>
            <label htmlFor="staff-password">Staff password</label>
            <input
              id="staff-password"
              name="password"
              type="password"
              required
              minLength={12}
              maxLength={256}
              value={password}
              autoComplete="current-password"
              onChange={(event) => setPassword(event.target.value)}
            />
            <button className="admin-button" disabled={loginBusy}>
              {loginBusy ? "Signing in…" : "Sign in →"}
            </button>
          </form>
          <p className="admin-login-help">
            Ask your club administrator for the staff password.
          </p>
          {error && (
            <p className="admin-error" role="alert">
              {error}
            </p>
          )}
        </section>
      ) : (
        <>
          <section className="admin-intro">
            <div>
              <p className="admin-kicker">THE DAILY COURT REPORT</p>
              <h1>Court bookings</h1>
              <p>Two courts · Open 24/7 · Sydney time</p>
            </div>
            <button className="admin-button" onClick={() => setEditor({})}>
              ＋ New booking
            </button>
          </section>
          <section
            className="admin-toolbar"
            aria-label="Filter bookings by date"
          >
            <label htmlFor="admin-date">
              View date{" "}
              <input
                id="admin-date"
                type="date"
                value={date}
                required
                onChange={(event) => {
                  if (event.target.value) {
                    setDate(event.target.value);
                    setNotice("");
                    setCancelId(null);
                  }
                }}
              />
            </label>
            <button
              className="admin-button admin-button-subtle"
              onClick={() => setRefreshKey((value) => value + 1)}
            >
              Refresh schedule ↻
            </button>
            <span>
              Updates every 30 seconds · Contact details are visible to staff
              only
            </span>
          </section>
          {error && (
            <p className="admin-error" role="alert">
              {error}
            </p>
          )}
          {notice && (
            <p className="admin-notice" role="status">
              {notice}
            </p>
          )}
          <div className="admin-court-summary">
            {COURTS.map((court) => {
              const confirmed = visibleBookings.filter(
                (booking) =>
                  booking.courtId === court.id &&
                  booking.status === "confirmed",
              );
              return (
                <section key={court.id}>
                  <p className="admin-kicker">{court.subtitle}</p>
                  <h2>
                    {court.name}
                    <span>
                      {confirmed.length} active{" "}
                      {confirmed.length === 1 ? "booking" : "bookings"}
                    </span>
                  </h2>
                  <p>
                    {confirmed.length
                      ? confirmed
                          .map(
                            (booking) =>
                              `${prettyTime(booking.startsAt)} ${booking.customerName}`,
                          )
                          .join(" · ")
                      : "No active bookings. Available all day."}
                  </p>
                </section>
              );
            })}
          </div>
          <section className="admin-list" aria-labelledby="admin-list-title">
            <div className="admin-list-heading">
              <h2 id="admin-list-title">Bookings for the day</h2>
              <span>
                {visibleBookings.length}{" "}
                {visibleBookings.length === 1 ? "booking" : "bookings"} ·
                Includes overnight bookings and cancellations
              </span>
            </div>
            {loadedDate !== date ? (
              <p className="admin-empty" role="status">
                Loading bookings…
              </p>
            ) : visibleBookings.length === 0 ? (
              <div className="admin-empty">
                <span>○</span>
                <h3>No bookings for this day</h3>
                <p>
                  New customer bookings appear here. Staff can also create a
                  booking on their behalf.
                </p>
              </div>
            ) : (
              <div className="admin-table-wrap">
                <table className="admin-table">
                  <thead>
                    <tr>
                      <th scope="col">Booking / Court</th>
                      <th scope="col">Time</th>
                      <th scope="col">Customer</th>
                      <th scope="col">Contact details</th>
                      <th scope="col">Source / Status</th>
                      <th scope="col">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleBookings.map((booking) => {
                      const attendanceCall = attendanceCalls[booking.id];
                      const isCallPending = Boolean(callPending[booking.id]);
                      const canCall =
                        booking.status === "confirmed" &&
                        Boolean(booking.phone.trim()) &&
                        new Date(booking.startsAt).getTime() > Date.now() &&
                        (!attendanceCall || attendanceCall.canRetry);
                      return (
                        <tr
                          key={booking.id}
                          className={
                            booking.status === "cancelled"
                              ? "admin-row-cancelled"
                              : ""
                          }
                        >
                          <td>
                            <strong>
                              {
                                COURTS.find(
                                  (court) => court.id === booking.courtId,
                                )?.name
                              }
                            </strong>
                            <small>#{booking.id}</small>
                          </td>
                          <td>
                            {prettyTime(booking.startsAt)}
                            <small>
                              to {prettyTime(booking.endsAt)} ·{" "}
                              {booking.durationHours}{" "}
                              {booking.durationHours === 1 ? "hour" : "hours"}
                            </small>
                          </td>
                          <td>{booking.customerName}</td>
                          <td>
                            {booking.phone && <span>{booking.phone}</span>}
                            {booking.email && <span>{booking.email}</span>}
                          </td>
                          <td>
                            <span>{sources[booking.source]}</span>
                            <span className={`admin-status ${booking.status}`}>
                              {booking.status === "confirmed"
                                ? "Confirmed"
                                : "Cancelled"}
                            </span>
                          </td>
                          <td>
                            {booking.status === "confirmed" ? (
                              cancelId === booking.id ? (
                                <div className="admin-cancel-confirm">
                                  <p>Cancel this booking?</p>
                                  <button
                                    className="admin-text-button admin-danger"
                                    disabled={cancelBusy}
                                    onClick={() => cancel(booking)}
                                  >
                                    {cancelBusy
                                      ? "Cancelling…"
                                      : "Confirm cancellation"}
                                  </button>
                                  <button
                                    className="admin-text-button"
                                    disabled={cancelBusy}
                                    onClick={() => setCancelId(null)}
                                  >
                                    Keep booking
                                  </button>
                                </div>
                              ) : (
                                <div className="admin-row-actions">
                                  <button
                                    className="admin-text-button"
                                    aria-label={`Edit booking ${booking.id}`}
                                    onClick={() => setEditor({ booking })}
                                  >
                                    Edit
                                  </button>
                                  <button
                                    className="admin-text-button admin-danger"
                                    aria-label={`Cancel booking ${booking.id}`}
                                    onClick={() => setCancelId(booking.id)}
                                  >
                                    Cancel
                                  </button>
                                </div>
                              )
                            ) : (
                              <span className="admin-muted">
                                Time slot released
                              </span>
                            )}
                            <div className="admin-attendance-action">
                              <button
                                type="button"
                                className="admin-attendance-button"
                                aria-label={`Call to confirm attendance for ${booking.customerName}, booking ${booking.id}`}
                                aria-describedby={`attendance-status-${booking.id}`}
                                disabled={
                                  !canCall ||
                                  isCallPending ||
                                  (cancelBusy && cancelId === booking.id)
                                }
                                onClick={() => confirmAttendance(booking)}
                              >
                                {isCallPending
                                  ? "Requesting call…"
                                  : "Call to confirm attendance"}
                              </button>
                              <p
                                id={`attendance-status-${booking.id}`}
                                className={`admin-attendance-status${callIssues[booking.id] ? " admin-attendance-error" : ""}`}
                                role="status"
                              >
                                {callIssues[booking.id] ||
                                  attendanceStatus(booking, attendanceCall)}
                              </p>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>
          <p className="admin-footer-note">
            Customer names for confirmed bookings appear on the public schedule.
            Phone numbers, email addresses and booking sources are visible to
            staff only.
          </p>
          {editor && (
            <BookingEditor
              key={editor.booking?.id || "new"}
              booking={editor.booking}
              selectedDate={date}
              onClose={() => setEditor(null)}
              onSaved={saved}
              onExpired={expireSession}
            />
          )}
        </>
      )}
    </main>
  );
}

function BookingEditor({
  booking,
  selectedDate,
  onClose,
  onSaved,
  onExpired,
}: {
  booking?: Booking;
  selectedDate: string;
  onClose: () => void;
  onSaved: () => void;
  onExpired: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const initialStart = booking
    ? localStart(booking.startsAt)
    : `${selectedDate}T10:00`;
  const [courtId, setCourtId] = useState(booking?.courtId || 1);
  const [date, setDate] = useState(initialStart.slice(0, 10));
  const [hour, setHour] = useState(initialStart.slice(11, 13));
  const [durationHours, setDurationHours] = useState(
    booking?.durationHours || 2,
  );
  const [name, setName] = useState(booking?.customerName || "");
  const [phone, setPhone] = useState(booking?.phone || "");
  const [email, setEmail] = useState(booking?.email || "");
  const [source, setSource] = useState<Channel>(booking?.source || "staff");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [created, setCreated] = useState<{
    booking: Booking;
    accessCode: string;
  } | null>(null);

  useEffect(() => {
    const node = dialog.current;
    node?.showModal();
    return () => {
      node?.close();
    };
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    if (!phone.trim() && !email.trim()) {
      setError("Enter at least one contact method: phone or email.");
      return;
    }
    setBusy(true);
    const input: BookingInput = {
      courtId,
      startLocal: `${date}T${hour}:00`,
      durationHours,
      customerName: name.trim(),
      phone: phone.trim(),
      email: email.trim(),
      source,
    };
    try {
      if (booking) {
        await api(`/api/bookings/${booking.id}`, {
          method: "PATCH",
          body: JSON.stringify({ ...input, version: booking.version }),
        });
        onSaved();
        onClose();
      } else {
        const data = await api<{ booking: Booking; accessCode: string }>(
          "/api/bookings",
          { method: "POST", body: JSON.stringify(input) },
        );
        setCreated(data);
        onSaved();
      }
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Unable to save the booking.",
      );
      if (err instanceof RequestError && err.status === 409)
        setError(
          `${err.message} Close this window and refresh the schedule before trying again. Your changes have not been saved.`,
        );
      if (err instanceof RequestError && err.status === 401) onExpired();
    } finally {
      setBusy(false);
    }
  }

  return (
    <dialog
      ref={dialog}
      className="admin-dialog"
      onCancel={(event) => {
        if (busy) event.preventDefault();
      }}
      onClose={onClose}
      aria-labelledby="admin-editor-title"
    >
      <button
        type="button"
        className="admin-dialog-close"
        aria-label="Close booking dialog"
        disabled={busy}
        onClick={onClose}
      >
        ×
      </button>
      <p className="admin-kicker">COURTSIDE / RESERVATIONS</p>
      <h2 id="admin-editor-title">
        {created ? "Booking created" : booking ? "Edit booking" : "New booking"}
      </h2>
      {created ? (
        <div className="admin-created">
          <p>
            Booking saved. Share these details securely with the customer. The
            access code is shown only once.
          </p>
          <dl>
            <div>
              <dt>Booking ID</dt>
              <dd>{created.booking.id}</dd>
            </div>
            <div>
              <dt>Access code</dt>
              <dd>{created.accessCode}</dd>
            </div>
            <div>
              <dt>Court / Time</dt>
              <dd>
                {
                  COURTS.find((court) => court.id === created.booking.courtId)
                    ?.name
                }
                <br />
                {prettyTime(created.booking.startsAt)} —{" "}
                {prettyTime(created.booking.endsAt)}
              </dd>
            </div>
          </dl>
          <button type="button" className="admin-button" onClick={onClose}>
            Details saved. Back to schedule
          </button>
        </div>
      ) : (
        <form onSubmit={submit} className="admin-editor-form">
          <p>
            All times are in Sydney time. Both courts are open 24/7. Bookings
            start on the hour and default to 2 hours.
          </p>
          <div className="admin-form-grid">
            <label>
              Court
              <select
                aria-label="Court"
                value={courtId}
                onChange={(event) => setCourtId(Number(event.target.value))}
              >
                {COURTS.map((court) => (
                  <option key={court.id} value={court.id}>
                    {court.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Source
              <select
                aria-label="Source"
                value={source}
                disabled={!!booking}
                onChange={(event) => setSource(event.target.value as Channel)}
              >
                {Object.entries(sources).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
              {booking && <small>The original booking source is kept</small>}
            </label>
            <label>
              Date
              <input
                type="date"
                value={date}
                aria-label="Date"
                required
                onChange={(event) => setDate(event.target.value)}
              />
            </label>
            <label>
              Start time
              <select
                aria-label="Start time"
                value={hour}
                onChange={(event) => setHour(event.target.value)}
              >
                {Array.from({ length: 24 }, (_, index) =>
                  String(index).padStart(2, "0"),
                ).map((value) => (
                  <option key={value} value={value}>
                    {value}:00
                  </option>
                ))}
              </select>
            </label>
            <label>
              Duration
              <select
                aria-label="Duration"
                value={durationHours}
                onChange={(event) =>
                  setDurationHours(Number(event.target.value))
                }
              >
                {Array.from({ length: 8 }, (_, index) => index + 1).map(
                  (value) => (
                    <option key={value} value={value}>
                      {value} {value === 1 ? "hour" : "hours"}
                      {value === 2 ? " (default)" : ""}
                    </option>
                  ),
                )}
              </select>
            </label>
            <label>
              Customer name
              <input
                value={name}
                required
                maxLength={80}
                onChange={(event) => setName(event.target.value)}
                autoComplete="name"
              />
            </label>
            <label>
              Phone
              <input
                type="tel"
                value={phone}
                maxLength={40}
                onChange={(event) => setPhone(event.target.value)}
                autoComplete="tel"
              />
            </label>
            <label>
              Email
              <input
                type="email"
                value={email}
                maxLength={254}
                onChange={(event) => setEmail(event.target.value)}
                autoComplete="email"
              />
            </label>
          </div>
          <p className="admin-form-help">
            Enter a phone number or email address. Let the customer know their
            name will appear on the public schedule. Contact details are visible
            to staff only.
          </p>
          {error && (
            <p className="admin-error" role="alert">
              {error}
            </p>
          )}
          <div className="admin-dialog-actions">
            <button
              type="button"
              className="admin-button admin-button-subtle"
              disabled={busy}
              onClick={onClose}
            >
              Back
            </button>
            <button className="admin-button" disabled={busy}>
              {busy ? "Saving…" : booking ? "Save changes" : "Create booking"}
            </button>
          </div>
        </form>
      )}
    </dialog>
  );
}

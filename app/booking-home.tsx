"use client";

import Link from "next/link";
import { FormEvent, useEffect, useRef, useState } from "react";
import {
  COURTS,
  TIME_ZONE,
  type Availability,
  type AvailabilitySlot,
  type Booking,
} from "@/lib/domain";

type ChannelStatus = {
  phone: boolean;
  sms: boolean;
  email: boolean;
  phoneNumber?: string;
  emailAddress?: string;
};
type BookingResult = { booking: Booking; accessCode?: string };
type Editor = {
  courtId: number;
  startLocal: string;
  durationHours: number;
  customerName: string;
  phone: string;
  email: string;
};

function Arrow({ diagonal = false }: { diagonal?: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      aria-hidden="true"
    >
      <path d={diagonal ? "M6 18 18 6M6 6h12v12" : "M4 12h15m-6-6 6 6-6 6"} />
    </svg>
  );
}
function Ball() {
  return (
    <svg viewBox="0 0 40 40" fill="none" aria-hidden="true">
      <circle cx="20" cy="20" r="18" fill="currentColor" />
      <path
        d="M7.5 7.5c15 4 15 21 25 25M32.5 7.5c-15 4-15 21-25 25"
        stroke="var(--cream)"
        strokeWidth="1.7"
      />
    </svg>
  );
}
function CourtArt() {
  return (
    <svg viewBox="0 0 440 270" fill="none" aria-hidden="true">
      <rect width="440" height="270" rx="6" fill="#8da78a" />
      <rect x="66" y="30" width="308" height="210" fill="#426e50" />
      <g stroke="#f3f1d9" strokeWidth="1.5">
        <rect x="66" y="30" width="308" height="210" />
        <path d="M105 30v210M335 30v210M105 82h230M105 188h230M220 82v106M56 135h328" />
      </g>
      <path d="M56 138h328" stroke="#173e2a" strokeWidth="5" opacity=".35" />
      <circle cx="296" cy="74" r="6" fill="#e4ed99" />
      <path d="m296 74-27 18" stroke="#e4ed99" opacity=".5" />
      <circle cx="130" cy="208" r="11" fill="#e9e7d0" />
      <circle cx="130" cy="205" r="5" fill="#cc9b77" />
      <path d="m137 199 12-13" stroke="#eee9d5" strokeWidth="4" />
      <ellipse
        cx="152"
        cy="181"
        rx="5"
        ry="8"
        transform="rotate(35 152 181)"
        stroke="#e5ecb0"
        strokeWidth="1.5"
      />
    </svg>
  );
}
function dateParts(value: string) {
  const parts = new Intl.DateTimeFormat("en-AU", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(value));
  const pick = (type: string) =>
    parts.find((part) => part.type === type)!.value;
  return {
    date: `${pick("year")}-${pick("month")}-${pick("day")}`,
    time: `${pick("hour")}:${pick("minute")}`,
  };
}
function hoursLabel(hours: number) {
  return `${hours} ${hours === 1 ? "hour" : "hours"}`;
}
function range(startsAt: string, endsAt: string) {
  const start = dateParts(startsAt),
    end = dateParts(endsAt);
  return `${start.time} – ${end.time}${end.date !== start.date ? ` (${dayLabel(end.date)})` : ""}`;
}
function dayLabel(value: string, full = false) {
  return new Intl.DateTimeFormat("en-AU", {
    timeZone: "UTC",
    month: full ? "long" : "short",
    day: "numeric",
    weekday: "short",
  }).format(new Date(`${value}T12:00:00Z`));
}
async function api<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    cache: "no-store",
    ...options,
    headers: { "Content-Type": "application/json", ...options?.headers },
  });
  const body = await response.json().catch(() => ({
    error: "The service is temporarily unavailable. Please try again later.",
  }));
  if (!response.ok)
    throw new Error(body.error || "The action failed. Please try again.");
  return body as T;
}

export default function BookingHome({ today }: { today: string }) {
  const [date, setDate] = useState(today);
  const [duration, setDuration] = useState(2);
  const [availability, setAvailability] = useState<Availability | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [updated, setUpdated] = useState("");
  const [channels, setChannels] = useState<ChannelStatus | null>(null);
  const [mode, setMode] = useState<"create" | "manage" | null>(null);
  const [editor, setEditor] = useState<Editor>({
    courtId: 1,
    startLocal: `${today}T10:00`,
    durationHours: 2,
    customerName: "",
    phone: "",
    email: "",
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [lookupId, setLookupId] = useState("");
  const [accessCode, setAccessCode] = useState("");
  const [managed, setManaged] = useState<Booking | null>(null);
  const [result, setResult] = useState<BookingResult | null>(null);
  const [notice, setNotice] = useState("");
  const [cancelConfirm, setCancelConfirm] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    async function load() {
      try {
        const data = await api<Availability>(
          `/api/availability?date=${encodeURIComponent(date)}&durationHours=${duration}`,
          { signal: controller.signal },
        );
        if (!active) return;
        setAvailability(data);
        setLoadError("");
        setUpdated(
          new Intl.DateTimeFormat("en-AU", {
            timeZone: TIME_ZONE,
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
            hourCycle: "h23",
          }).format(new Date()),
        );
      } catch (error) {
        if (active && !controller.signal.aborted)
          setLoadError(
            error instanceof Error
              ? error.message
              : "Unable to load court availability. Please try again.",
          );
      } finally {
        if (active) setLoading(false);
      }
    }
    void load();
    const interval = setInterval(() => {
      void load();
    }, 30000);
    return () => {
      active = false;
      controller.abort();
      clearInterval(interval);
    };
  }, [date, duration, refresh]);
  useEffect(() => {
    const controller = new AbortController();
    api<ChannelStatus>("/api/channels/status", { signal: controller.signal })
      .then(setChannels)
      .catch(() => {
        if (!controller.signal.aborted)
          setChannels({ phone: false, sms: false, email: false });
      });
    return () => controller.abort();
  }, []);
  useEffect(() => {
    if (mode && !dialog.current?.open) dialog.current?.showModal();
    if (!mode && dialog.current?.open) dialog.current?.close();
  }, [mode]);

  const days = Array.from({ length: 7 }, (_, index) => {
    const day = new Date(`${today}T12:00:00Z`);
    day.setUTCDate(day.getUTCDate() + index);
    return day.toISOString().slice(0, 10);
  });
  const currentData =
    availability?.date === date && availability.durationHours === duration
      ? availability
      : null;
  const editorSlot =
    mode === "create"
      ? currentData?.slots.find(
          (slot) =>
            slot.courtId === editor.courtId &&
            slot.startLocal === editor.startLocal,
        )
      : undefined;
  function chooseDate(value: string) {
    if (value === date) return;
    setDate(value);
    setLoading(true);
  }
  function refreshAvailability() {
    setRefresh((value) => value + 1);
  }
  function openCreate(slot: AvailabilitySlot) {
    const bookingDuration = Math.min(duration, slot.maxDurationHours);
    setEditor({
      courtId: slot.courtId,
      startLocal: slot.startLocal,
      durationHours: bookingDuration,
      customerName: "",
      phone: "",
      email: "",
    });
    setError("");
    setResult(null);
    setManaged(null);
    setNotice(
      bookingDuration < duration
        ? `This start time has ${hoursLabel(slot.maxDurationHours)} available in a row, so we selected ${hoursLabel(bookingDuration)}. Your requested ${hoursLabel(duration)} is unavailable. Please check the duration before booking.`
        : "",
    );
    setCancelConfirm(false);
    setMode("create");
  }
  function openManage() {
    setError("");
    setResult(null);
    setManaged(null);
    setNotice("");
    setCancelConfirm(false);
    setLookupId("");
    setAccessCode("");
    setMode("manage");
  }
  function editBooking(booking: Booking) {
    const local = dateParts(booking.startsAt);
    setEditor({
      courtId: booking.courtId,
      startLocal: `${local.date}T${local.time}`,
      durationHours: booking.durationHours,
      customerName: booking.customerName,
      phone: booking.phone,
      email: booking.email,
    });
    setManaged(booking);
  }
  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    if (!editor.phone.trim() && !editor.email.trim()) {
      setError("Please enter a phone number or email address.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const created = await api<BookingResult>("/api/bookings", {
        method: "POST",
        body: JSON.stringify(editor),
      });
      setResult(created);
      setNotice("");
      refreshAvailability();
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : "Your booking was not completed. Please try again.",
      );
      refreshAvailability();
    } finally {
      setBusy(false);
    }
  }
  async function lookup(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    setCancelConfirm(false);
    try {
      const { booking } = await api<BookingResult>("/api/bookings/lookup", {
        method: "POST",
        body: JSON.stringify({
          id: lookupId.trim(),
          accessCode: accessCode.trim(),
        }),
      });
      editBooking(booking);
    } catch (error) {
      setError(
        error instanceof Error ? error.message : "Unable to find your booking.",
      );
    } finally {
      setBusy(false);
    }
  }
  async function changeBooking(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!managed || busy) return;
    if (!editor.phone.trim() && !editor.email.trim()) {
      setError("Please enter a phone number or email address.");
      return;
    }
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const { booking } = await api<BookingResult>(
        `/api/bookings/${managed.id}`,
        {
          method: "PATCH",
          body: JSON.stringify({
            ...editor,
            version: managed.version,
            accessCode: accessCode.trim(),
          }),
        },
      );
      editBooking(booking);
      setNotice(
        "Your booking has been changed and the court schedule is up to date.",
      );
      refreshAvailability();
    } catch (error) {
      setError(
        `${error instanceof Error ? error.message : "Unable to save changes."} If your booking was changed through another channel, close this window and look it up again to get the latest details.`,
      );
      refreshAvailability();
    } finally {
      setBusy(false);
    }
  }
  async function cancelBooking() {
    if (!managed || busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const { booking } = await api<BookingResult>(
        `/api/bookings/${managed.id}`,
        {
          method: "DELETE",
          body: JSON.stringify({
            version: managed.version,
            accessCode: accessCode.trim(),
          }),
        },
      );
      editBooking(booking);
      setCancelConfirm(false);
      setNotice(
        "Your booking has been cancelled and the time is available again.",
      );
      refreshAvailability();
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : "Unable to cancel. Please look up your booking again and retry.",
      );
    } finally {
      setBusy(false);
    }
  }
  function editorFields() {
    return (
      <>
        <div className="form-row">
          <label>
            Court
            <select
              aria-label="Court"
              value={editor.courtId}
              onChange={(event) => {
                setEditor({ ...editor, courtId: Number(event.target.value) });
                setNotice("");
              }}
            >
              {COURTS.map((court) => (
                <option value={court.id} key={court.id}>
                  {court.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Booking duration
            <select
              aria-label="Booking duration"
              value={editor.durationHours}
              onChange={(event) =>
                setEditor({
                  ...editor,
                  durationHours: Number(event.target.value),
                })
              }
            >
              {Array.from({ length: 8 }, (_, i) => (
                <option
                  key={i + 1}
                  value={i + 1}
                  disabled={!!editorSlot && i + 1 > editorSlot.maxDurationHours}
                >
                  {hoursLabel(i + 1)}
                </option>
              ))}
            </select>
            {editorSlot && (
              <span className="field-hint">
                Up to {hoursLabel(editorSlot.maxDurationHours)} available from
                this start time
              </span>
            )}
          </label>
        </div>
        <label>
          Start time
          <span className="field-hint">
            Sydney time · Start on the hour; bookings can cross midnight
          </span>
          <input
            type="datetime-local"
            aria-label="Start time"
            step="3600"
            min={`${today}T00:00`}
            value={editor.startLocal}
            onChange={(event) => {
              setEditor({ ...editor, startLocal: event.target.value });
              setNotice("");
            }}
            required
          />
        </label>
        <label>
          Your name
          <input
            autoComplete="name"
            value={editor.customerName}
            maxLength={80}
            onChange={(event) =>
              setEditor({ ...editor, customerName: event.target.value })
            }
            placeholder="Enter your full name"
            required
          />
        </label>
        <div className="form-row">
          <label>
            Phone number
            <input
              type="tel"
              autoComplete="tel"
              maxLength={40}
              value={editor.phone}
              onChange={(event) =>
                setEditor({ ...editor, phone: event.target.value })
              }
              placeholder="e.g. +61 412 345 678"
            />
          </label>
          <label>
            Email
            <input
              type="email"
              autoComplete="email"
              maxLength={254}
              value={editor.email}
              onChange={(event) =>
                setEditor({ ...editor, email: event.target.value })
              }
              placeholder="name@example.com"
            />
          </label>
        </div>
        <p className="privacy-note">
          Enter a phone number or email address. These are visible only to you
          with your access code and to signed-in staff. Your name will appear on
          the public court schedule.
        </p>
      </>
    );
  }

  return (
    <main>
      <header className="site-header">
        <Link className="brand" href="/" aria-label="COURTSIDE home">
          <Ball />
          <span>
            COURTSIDE<small>Make every game count.</small>
          </span>
        </Link>
        <nav aria-label="Main navigation">
          <a href="#schedule">Court schedule</a>
          <a href="#channels">Phone · Email · SMS</a>
        </nav>
        <div className="header-actions">
          <button className="text-button" onClick={openManage}>
            Manage my booking
          </button>
          <Link className="staff-link" href="/admin">
            Staff <Arrow diagonal />
          </Link>
        </div>
      </header>
      <section className="hero">
        <div className="hero-copy">
          <p className="eyebrow">
            <span /> YOUR NEXT GOOD GAME
          </p>
          <h1>
            Make time,
            <br />
            for a <span>good game.</span>
          </h1>
          <p>
            Two courts. Open around the clock.
            <br />
            Find your time and make room for the game you love.
          </p>
          <a href="#schedule" className="primary-button">
            View available times <Arrow />
          </a>
          <div className="hero-features">
            <span>
              <strong>02</strong> Courts
            </span>
            <span>
              <strong>24/7</strong> Open
            </span>
            <span>
              <strong>2h</strong> Default duration
            </span>
          </div>
        </div>
        <div className="hero-art">
          <span className="art-kicker">THE COURT IS CALLING.</span>
          <div className="art-court">
            <CourtArt />
          </div>
          <div className="art-bottom">
            <span>
              LESS SCROLLING.
              <br />
              MORE SERVING.
            </span>
            <em>See you on court.</em>
          </div>
        </div>
      </section>
      <section
        id="schedule"
        className="schedule-section"
        aria-labelledby="schedule-title"
      >
        <div className="section-heading">
          <div>
            <p className="eyebrow">FIND YOUR TIME</p>
            <h2 id="schedule-title">
              Court schedule<span>.</span>
            </h2>
          </div>
          <p>
            Sydney time · Australia/Sydney
            <br />
            <span className="live-indicator" /> Updates every 30 seconds
          </p>
        </div>
        <div className="schedule-controls">
          <div className="controls-top">
            <div>
              <h3>Choose a date</h3>
              <span>{dayLabel(date, true)}</span>
            </div>
            <div className="control-inputs">
              <label>
                Another date
                <input
                  aria-label="Choose another date"
                  type="date"
                  min={today}
                  value={date}
                  onChange={(event) => {
                    if (event.target.value) chooseDate(event.target.value);
                  }}
                />
              </label>
              <label>
                Duration
                <select
                  aria-label="Booking duration"
                  value={duration}
                  onChange={(event) => {
                    setDuration(Number(event.target.value));
                    setLoading(true);
                  }}
                >
                  {Array.from({ length: 8 }, (_, index) => (
                    <option key={index + 1} value={index + 1}>
                      {hoursLabel(index + 1)}
                      {index === 1 ? " (default)" : ""}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          </div>
          <div
            className="date-list"
            role="group"
            aria-label="Choose a booking date"
          >
            {days.map((day, index) => (
              <button
                key={day}
                aria-pressed={date === day}
                className={date === day ? "selected" : ""}
                onClick={() => chooseDate(day)}
              >
                <span>
                  {new Intl.DateTimeFormat("en-AU", {
                    timeZone: "UTC",
                    weekday: "short",
                  }).format(new Date(`${day}T12:00:00Z`))}
                </span>
                <strong>{day.slice(8)}</strong>
                <span>
                  {index === 0
                    ? "Today"
                    : new Intl.DateTimeFormat("en-AU", {
                        timeZone: "UTC",
                        month: "short",
                      }).format(new Date(`${day}T12:00:00Z`))}
                </span>
              </button>
            ))}
          </div>
          <div className="schedule-legend">
            <span>
              <i className="legend-free" /> Available (1 hour per slot)
            </span>
            <span>
              <i className="legend-booked" /> Booked
            </span>
            <span>
              <i className="legend-unavailable" /> Past / unavailable
            </span>
            <span>
              Booking for {hoursLabel(duration)}; choose a shorter duration when
              needed
            </span>
          </div>
        </div>
        {loadError && (
          <div className="alert error" role="alert">
            {loadError}{" "}
            <button
              onClick={() => {
                setLoading(true);
                refreshAvailability();
              }}
            >
              Reload
            </button>
          </div>
        )}
        {loading && !currentData && (
          <div className="loading-state" role="status">
            Loading the court schedule…
          </div>
        )}
        {!loading && !currentData && !loadError && (
          <div className="loading-state">
            No schedule is available right now.
          </div>
        )}
        {currentData && (
          <div className="court-grid">
            {COURTS.map((court) => {
              const booked =
                currentData.courts.find((value) => value.id === court.id)
                  ?.bookings || [];
              const slots = currentData.slots.filter(
                (slot) => slot.courtId === court.id,
              );
              const availableStarts = slots.filter(
                (slot) => slot.maxDurationHours >= 1,
              ).length;
              return (
                <article
                  className={`court-card court-${court.id}`}
                  key={court.id}
                >
                  <div className="court-card-heading">
                    <div className="court-icon" aria-hidden="true">
                      <svg viewBox="0 0 40 48" fill="none">
                        <rect
                          x="6"
                          y="5"
                          width="28"
                          height="38"
                          stroke="currentColor"
                        />
                        <path
                          d="M10 5v38M30 5v38M10 15h20M10 33h20M20 15v18M3 24h34"
                          stroke="currentColor"
                        />
                      </svg>
                    </div>
                    <div>
                      <p className="eyebrow">{court.subtitle}</p>
                      <h3>{court.name}</h3>
                    </div>
                    <span className="court-open">Open 24 hours</span>
                  </div>
                  <div className="slot-section">
                    <div className="slots-label">
                      <h4>Choose a start time</h4>
                      <span>
                        {availableStarts}{" "}
                        {availableStarts === 1
                          ? "available start"
                          : "available starts"}
                      </span>
                    </div>
                    <div className="time-slots">
                      {slots.map((slot) => {
                        const free = slot.maxDurationHours >= 1;
                        const shorter = free && !slot.available;
                        const description = free
                          ? shorter
                            ? `Available for up to ${hoursLabel(slot.maxDurationHours)}; your requested ${hoursLabel(duration)} is unavailable`
                            : `Available for ${hoursLabel(duration)}`
                          : slot.occupied
                            ? "Booked"
                            : slot.reason || "Unavailable";
                        return (
                          <button
                            key={slot.startLocal}
                            className={
                              free
                                ? shorter
                                  ? "slot-short"
                                  : "slot-free"
                                : slot.occupied
                                  ? "slot-occupied"
                                  : "slot-unavailable"
                            }
                            disabled={!free || loading || !!loadError}
                            title={description}
                            aria-label={`${court.name} ${slot.startLocal.slice(11)} ${description}`}
                            onClick={() => openCreate(slot)}
                          >
                            <span>{slot.startLocal.slice(11)}</span>
                            {shorter && (
                              <small className="slot-capacity">
                                {slot.maxDurationHours}h max
                              </small>
                            )}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                  <div className="day-bookings">
                    <div className="slots-label">
                      <h4>Daily bookings</h4>
                      <span>
                        {booked.length}{" "}
                        {booked.length === 1 ? "booking" : "bookings"}
                      </span>
                    </div>
                    {booked.length ? (
                      <ul>
                        {booked.map((booking) => (
                          <li key={booking.id}>
                            <div>
                              <strong>
                                {range(booking.startsAt, booking.endsAt)}
                              </strong>
                              <span>{booking.customerName}</span>
                            </div>
                            <span className="status-tag">Booked</span>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <div className="empty-court">
                        <span aria-hidden="true">↗</span>
                        <p>
                          No bookings for this day yet.
                          <br />
                          <small>
                            Pick your time and be the first on court.
                          </small>
                        </p>
                      </div>
                    )}
                  </div>
                </article>
              );
            })}
          </div>
        )}
        <div className="schedule-footnote">
          <span>
            Bookings appear immediately. If several people choose the same time,
            the final confirmation determines availability.
          </span>
          {updated && <span>Last updated {updated}</span>}
        </div>
      </section>
      <section
        className="channels-section"
        id="channels"
        aria-labelledby="channels-title"
      >
        <div className="section-heading">
          <div>
            <p className="eyebrow">BOOK YOUR WAY</p>
            <h2 id="channels-title">
              More ways to book<span>.</span>
            </h2>
          </div>
          <p>Phone, email and SMS share the same court schedule.</p>
        </div>
        <div className="channels-grid">
          <article>
            <span className="channel-symbol" aria-hidden="true">
              ↗
            </span>
            <div className="channel-title">
              <h3>Book by phone</h3>
              <span
                className={
                  channels?.phone ? "channel-ready" : "channel-pending"
                }
              >
                {channels === null
                  ? "Checking…"
                  : channels.phone
                    ? "Ready"
                    : "Setup needed"}
              </span>
            </div>
            <p>
              Talk to our booking assistant to check live availability. Confirm
              your name, phone number and time before the assistant submits your
              booking.
            </p>
            {channels?.phone && channels.phoneNumber ? (
              <a
                href={`tel:${channels.phoneNumber}`}
                className="channel-contact"
              >
                {channels.phoneNumber}
              </a>
            ) : (
              <span className="channel-help">
                Available once the phone service is connected
              </span>
            )}
          </article>
          <article>
            <span className="channel-symbol" aria-hidden="true">
              @
            </span>
            <div className="channel-title">
              <h3>Book by email</h3>
              <span
                className={
                  channels?.email ? "channel-ready" : "channel-pending"
                }
              >
                {channels === null
                  ? "Checking…"
                  : channels.email
                    ? "Ready"
                    : "Setup needed"}
              </span>
            </div>
            <p>
              Send a booking command for an automatic reply. Include your access
              code when changing or cancelling a booking.
            </p>
            {channels?.email && channels.emailAddress ? (
              <a
                href={`mailto:${channels.emailAddress}`}
                className="channel-contact"
              >
                {channels.emailAddress}
              </a>
            ) : (
              <span className="channel-help">
                Available once the email service is connected
              </span>
            )}
          </article>
          <article>
            <span className="channel-symbol" aria-hidden="true">
              ···
            </span>
            <div className="channel-title">
              <h3>Book by SMS</h3>
              <span
                className={channels?.sms ? "channel-ready" : "channel-pending"}
              >
                {channels === null
                  ? "Checking…"
                  : channels.sms
                    ? "Ready"
                    : "Setup needed"}
              </span>
            </div>
            <p>
              Send a command by SMS to check availability or make a booking,
              wherever you are.
            </p>
            {channels?.sms && channels.phoneNumber ? (
              <a
                href={`sms:${channels.phoneNumber}`}
                className="channel-contact"
              >
                {channels.phoneNumber}
              </a>
            ) : (
              <span className="channel-help">
                Available once the SMS service is connected
              </span>
            )}
          </article>
        </div>
        <details className="command-help">
          <summary>
            View email and SMS commands <span>＋</span>
          </summary>
          <div>
            <p>
              All dates and times use Sydney time. Enter a name without spaces.
              The default duration is 2 hours.
            </p>
            <code>{`QUERY ${today}`}</code>
            <code>{`BOOK 1 ${today} 10:00 Alex 2`}</code>
            <code>{`CHANGE booking_id access_code 2 ${days[1]} 14:00 2`}</code>
            <code>CANCEL booking_id access_code</code>
            <p>
              Replace the example dates, name, booking_id and access_code with
              your details. Check that your chosen channel is ready before
              sending.
            </p>
          </div>
        </details>
      </section>
      <section className="closing-banner">
        <div>
          <p className="eyebrow">MAKE TIME FOR YOUR GAME</p>
          <h2>See you on court.</h2>
          <p>Any time is a good time to make room for your game.</p>
        </div>
        <a href="#schedule" aria-label="Back to the court schedule">
          <Arrow diagonal />
        </a>
      </section>
      <footer>
        <Link href="/" className="footer-brand">
          COURTSIDE<span>Make room for tennis.</span>
        </Link>
        <p>© {today.slice(0, 4)} COURTSIDE</p>
        <Link href="/admin">Staff sign in ↗</Link>
      </footer>
      <dialog
        ref={dialog}
        className="booking-dialog"
        onClose={() => {
          if (!busy) setMode(null);
        }}
        onCancel={(event) => {
          if (busy) event.preventDefault();
        }}
        aria-labelledby="dialog-title"
      >
        <button
          className="dialog-close"
          aria-label="Close booking window"
          disabled={busy}
          onClick={() => setMode(null)}
        >
          ×
        </button>
        <p className="eyebrow">YOUR NEXT GOOD GAME</p>
        <h2 id="dialog-title">
          {result
            ? "Booked. See you on court."
            : mode === "create"
              ? "Make room for your game."
              : "Manage my booking"}
        </h2>
        {error && (
          <div className="alert error" role="alert">
            {error}
          </div>
        )}
        {notice && (
          <div className="alert success" role="status">
            {notice}
          </div>
        )}
        {mode === "create" && !result && (
          <form onSubmit={create} className="booking-form">
            <p className="dialog-intro">
              Save your booking ID and access code after booking. You will need
              them to change or cancel your booking.
            </p>
            {editorFields()}
            <label className="consent-check">
              <input type="checkbox" required />
              <span>
                I understand my name will appear on the public schedule and
                confirm that my booking details are correct.
              </span>
            </label>
            <button
              className="primary-button form-submit"
              disabled={
                busy ||
                (!!editorSlot &&
                  editor.durationHours > editorSlot.maxDurationHours)
              }
            >
              {busy ? "Confirming availability…" : "Confirm booking"}
              <Arrow />
            </button>
          </form>
        )}
        {result && (
          <div className="booking-success">
            <div className="success-circle" aria-hidden="true">
              ✓
            </div>
            <p>
              Your booking is saved. Keep these details safe. Your access code
              is shown only in this confirmation.
            </p>
            <dl className="booking-details">
              <div>
                <dt>Court</dt>
                <dd>
                  {
                    COURTS.find((court) => court.id === result.booking.courtId)
                      ?.name
                  }
                </dd>
              </div>
              <div>
                <dt>Date</dt>
                <dd>
                  {dayLabel(dateParts(result.booking.startsAt).date, true)}
                </dd>
              </div>
              <div>
                <dt>Time</dt>
                <dd>{range(result.booking.startsAt, result.booking.endsAt)}</dd>
              </div>
              <div>
                <dt>Name</dt>
                <dd>{result.booking.customerName}</dd>
              </div>
            </dl>
            <div className="booking-credentials">
              <div>
                <span>Booking ID</span>
                <strong>{result.booking.id}</strong>
              </div>
              <div>
                <span>Access code · Keep private</span>
                <strong>{result.accessCode}</strong>
              </div>
            </div>
            <p className="privacy-note">
              Keep a screenshot or save your access code to change or cancel
              your booking. Web bookings do not automatically send SMS or email
              notifications.
            </p>
            <button
              className="primary-button form-submit"
              onClick={() => setMode(null)}
            >
              Saved, back to schedule <Arrow />
            </button>
          </div>
        )}
        {mode === "manage" && !managed && (
          <form className="booking-form" onSubmit={lookup}>
            <p className="dialog-intro">
              Enter the booking ID and access code from your confirmation. You
              can also manage bookings made by phone, email or SMS here.
            </p>
            <label>
              Booking ID
              <input
                value={lookupId}
                onChange={(event) => setLookupId(event.target.value)}
                inputMode="numeric"
                autoComplete="off"
                pattern="[0-9]{8}"
                minLength={8}
                maxLength={8}
                required
                placeholder="8-digit booking ID"
              />
            </label>
            <label>
              Access code
              <input
                type="password"
                value={accessCode}
                onChange={(event) => setAccessCode(event.target.value)}
                inputMode="numeric"
                autoComplete="off"
                pattern="[0-9]{10}"
                minLength={10}
                maxLength={10}
                required
                placeholder="10-digit access code"
              />
            </label>
            <button className="primary-button form-submit" disabled={busy}>
              {busy ? "Looking up…" : "Find my booking"}
              <Arrow />
            </button>
          </form>
        )}
        {mode === "manage" && managed && (
          <>
            <div className="managed-heading">
              <span>Booking #{managed.id}</span>
              <span
                className={`status-tag ${managed.status === "cancelled" ? "cancelled" : ""}`}
              >
                {managed.status === "cancelled" ? "Cancelled" : "Confirmed"}
              </span>
            </div>
            {managed.status === "confirmed" ? (
              <form className="booking-form" onSubmit={changeBooking}>
                {editorFields()}
                <button className="primary-button form-submit" disabled={busy}>
                  {busy ? "Saving…" : "Save changes"}
                  <Arrow />
                </button>
                <div className="cancel-area">
                  {cancelConfirm ? (
                    <>
                      <p>
                        Cancel this booking? The time will become available
                        again.
                      </p>
                      <div>
                        <button
                          type="button"
                          className="secondary-button"
                          disabled={busy}
                          onClick={() => setCancelConfirm(false)}
                        >
                          Keep booking
                        </button>
                        <button
                          type="button"
                          className="danger-button"
                          disabled={busy}
                          onClick={cancelBooking}
                        >
                          {busy ? "Cancelling…" : "Confirm cancellation"}
                        </button>
                      </div>
                    </>
                  ) : (
                    <button
                      type="button"
                      className="danger-link"
                      disabled={busy}
                      onClick={() => setCancelConfirm(true)}
                    >
                      Cancel this booking
                    </button>
                  )}
                </div>
              </form>
            ) : (
              <>
                <dl className="booking-details">
                  <div>
                    <dt>Court</dt>
                    <dd>
                      {
                        COURTS.find((court) => court.id === managed.courtId)
                          ?.name
                      }
                    </dd>
                  </div>
                  <div>
                    <dt>Original date</dt>
                    <dd>{dayLabel(dateParts(managed.startsAt).date, true)}</dd>
                  </div>
                  <div>
                    <dt>Original time</dt>
                    <dd>{range(managed.startsAt, managed.endsAt)}</dd>
                  </div>
                </dl>
                <button
                  className="primary-button form-submit"
                  onClick={() => setMode(null)}
                >
                  Back to schedule <Arrow />
                </button>
              </>
            )}
          </>
        )}
      </dialog>
    </main>
  );
}

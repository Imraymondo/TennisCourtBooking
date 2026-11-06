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
  const parts = new Intl.DateTimeFormat("en-CA", {
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
function range(startsAt: string, endsAt: string) {
  const start = dateParts(startsAt),
    end = dateParts(endsAt);
  return `${start.time} – ${end.time}${end.date !== start.date ? `（${end.date.slice(5)}）` : ""}`;
}
function dayLabel(value: string, full = false) {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "UTC",
    month: full ? "long" : "numeric",
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
  const body = await response
    .json()
    .catch(() => ({ error: "服务暂时无法响应，请稍后重试。" }));
  if (!response.ok) throw new Error(body.error || "操作失败，请重试。");
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
          new Intl.DateTimeFormat("zh-CN", {
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
            error instanceof Error ? error.message : "无法加载场地，请重试。",
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
  function chooseDate(value: string) {
    if (value === date) return;
    setDate(value);
    setLoading(true);
  }
  function refreshAvailability() {
    setRefresh((value) => value + 1);
  }
  function openCreate(slot: AvailabilitySlot) {
    setEditor({
      courtId: slot.courtId,
      startLocal: slot.startLocal,
      durationHours: duration,
      customerName: "",
      phone: "",
      email: "",
    });
    setError("");
    setResult(null);
    setManaged(null);
    setNotice("");
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
      setError("请至少填写电话号码或邮箱中的一项。");
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
      refreshAvailability();
    } catch (error) {
      setError(error instanceof Error ? error.message : "预订未完成，请重试。");
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
      setError(error instanceof Error ? error.message : "无法查询预约。");
    } finally {
      setBusy(false);
    }
  }
  async function changeBooking(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!managed || busy) return;
    if (!editor.phone.trim() && !editor.email.trim()) {
      setError("请至少填写电话号码或邮箱中的一项。");
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
      setNotice("预约已修改，场地日程已更新。");
      refreshAvailability();
    } catch (error) {
      setError(
        `${error instanceof Error ? error.message : "修改失败。"} 如预约已被其他渠道修改，请关闭窗口后重新查询最新预约。`,
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
      setNotice("预约已取消，原时段已重新开放。");
      refreshAvailability();
    } catch (error) {
      setError(
        error instanceof Error ? error.message : "取消失败，请重新查询后重试。",
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
            场地
            <select
              aria-label="场地"
              value={editor.courtId}
              onChange={(event) =>
                setEditor({ ...editor, courtId: Number(event.target.value) })
              }
            >
              {COURTS.map((court) => (
                <option value={court.id} key={court.id}>
                  {court.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            预约时长
            <select
              aria-label="预约时长"
              value={editor.durationHours}
              onChange={(event) =>
                setEditor({
                  ...editor,
                  durationHours: Number(event.target.value),
                })
              }
            >
              {Array.from({ length: 8 }, (_, i) => (
                <option key={i + 1} value={i + 1}>
                  {i + 1} 小时
                </option>
              ))}
            </select>
          </label>
        </div>
        <label>
          开始时间
          <span className="field-hint">悉尼时间 · 整点开始，可跨午夜</span>
          <input
            type="datetime-local"
            aria-label="开始时间"
            step="3600"
            min={`${today}T00:00`}
            value={editor.startLocal}
            onChange={(event) =>
              setEditor({ ...editor, startLocal: event.target.value })
            }
            required
          />
        </label>
        <label>
          预约人姓名
          <input
            autoComplete="name"
            value={editor.customerName}
            maxLength={80}
            onChange={(event) =>
              setEditor({ ...editor, customerName: event.target.value })
            }
            placeholder="请输入真实姓名"
            required
          />
        </label>
        <div className="form-row">
          <label>
            电话号码
            <input
              type="tel"
              autoComplete="tel"
              maxLength={40}
              value={editor.phone}
              onChange={(event) =>
                setEditor({ ...editor, phone: event.target.value })
              }
              placeholder="例如 +61 412 345 678"
            />
          </label>
          <label>
            邮箱
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
          电话与邮箱至少填写一项，仅本人凭管理码及已登录工作人员可见。预约人姓名将公开显示在球场日程上。
        </p>
      </>
    );
  }

  return (
    <main>
      <header className="site-header">
        <Link className="brand" href="/" aria-label="COURTSIDE 首页">
          <Ball />
          <span>
            COURTSIDE<small>让每一次上场，都刚刚好。</small>
          </span>
        </Link>
        <nav aria-label="主导航">
          <a href="#schedule">球场日程</a>
          <a href="#channels">电话 · 邮件 · 短信</a>
        </nav>
        <div className="header-actions">
          <button className="text-button" onClick={openManage}>
            管理我的预约
          </button>
          <Link className="staff-link" href="/admin">
            工作人员 <Arrow diagonal />
          </Link>
        </div>
      </header>
      <section className="hero">
        <div className="hero-copy">
          <p className="eyebrow">
            <span /> YOUR NEXT GOOD GAME
          </p>
          <h1>
            留点时间，
            <br />
            给下一场<span>好球。</span>
          </h1>
          <p>
            两片球场，全天候开放。
            <br />
            找到空闲时段，把时间留给热爱。
          </p>
          <a href="#schedule" className="primary-button">
            查看可用时段 <Arrow />
          </a>
          <div className="hero-features">
            <span>
              <strong>02</strong> 片场地
            </span>
            <span>
              <strong>24/7</strong> 全天开放
            </span>
            <span>
              <strong>2h</strong> 默认时长
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
              球场日程<span>。</span>
            </h2>
          </div>
          <p>
            悉尼时间 · Australia/Sydney
            <br />
            <span className="live-indicator" /> 每 30 秒自动更新
          </p>
        </div>
        <div className="schedule-controls">
          <div className="controls-top">
            <div>
              <h3>选择日期</h3>
              <span>{dayLabel(date, true)}</span>
            </div>
            <div className="control-inputs">
              <label>
                其他日期
                <input
                  aria-label="选择其他日期"
                  type="date"
                  min={today}
                  value={date}
                  onChange={(event) => {
                    if (event.target.value) chooseDate(event.target.value);
                  }}
                />
              </label>
              <label>
                每次时长
                <select
                  aria-label="预约时长"
                  value={duration}
                  onChange={(event) => {
                    setDuration(Number(event.target.value));
                    setLoading(true);
                  }}
                >
                  {Array.from({ length: 8 }, (_, index) => (
                    <option key={index + 1} value={index + 1}>
                      {index + 1} 小时{index === 1 ? "（默认）" : ""}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          </div>
          <div className="date-list" role="group" aria-label="选择预订日期">
            {days.map((day, index) => (
              <button
                key={day}
                aria-pressed={date === day}
                className={date === day ? "selected" : ""}
                onClick={() => chooseDate(day)}
              >
                <span>
                  {new Intl.DateTimeFormat("zh-CN", {
                    timeZone: "UTC",
                    weekday: "short",
                  }).format(new Date(`${day}T12:00:00Z`))}
                </span>
                <strong>{day.slice(8)}</strong>
                <span>{index === 0 ? "今天" : day.slice(5, 7) + " 月"}</span>
              </button>
            ))}
          </div>
          <div className="schedule-legend">
            <span>
              <i className="legend-free" /> 可预订
            </span>
            <span>
              <i className="legend-booked" /> 已占用 / 不可预订
            </span>
            <span>按钮表示开始时间，连续预订 {duration} 小时</span>
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
              重新加载
            </button>
          </div>
        )}
        {loading && !currentData && (
          <div className="loading-state" role="status">
            正在读取球场日程…
          </div>
        )}
        {!loading && !currentData && !loadError && (
          <div className="loading-state">暂时没有可显示的日程。</div>
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
                    <span className="court-open">24 小时开放</span>
                  </div>
                  <div className="slot-section">
                    <div className="slots-label">
                      <h4>选择开始时间</h4>
                      <span>
                        {slots.filter((slot) => slot.available).length}{" "}
                        个时段可选
                      </span>
                    </div>
                    <div className="time-slots">
                      {slots.map((slot) => (
                        <button
                          key={slot.startLocal}
                          disabled={!slot.available || loading || !!loadError}
                          title={
                            slot.available
                              ? `预订 ${duration} 小时`
                              : slot.reason || "该时段不可预订"
                          }
                          aria-label={`${court.name} ${slot.startLocal.slice(11)} ${slot.available ? `预订${duration}小时` : "不可预订"}`}
                          onClick={() => openCreate(slot)}
                        >
                          {slot.startLocal.slice(11)}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="day-bookings">
                    <div className="slots-label">
                      <h4>当天预约</h4>
                      <span>{booked.length} 场</span>
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
                            <span className="status-tag">已预订</span>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <div className="empty-court">
                        <span aria-hidden="true">↗</span>
                        <p>
                          这一天，还没有预约。
                          <br />
                          <small>选个喜欢的时段，成为第一个上场的人。</small>
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
            预订即时写入日程；如多人同时选择同一时段，以系统最终确认结果为准。
          </span>
          {updated && <span>最近更新 {updated}</span>}
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
              预约，不只一种方式<span>。</span>
            </h2>
          </div>
          <p>电话、邮件和短信，共用同一份球场日程。</p>
        </div>
        <div className="channels-grid">
          <article>
            <span className="channel-symbol" aria-hidden="true">
              ↗
            </span>
            <div className="channel-title">
              <h3>电话预约</h3>
              <span
                className={
                  channels?.phone ? "channel-ready" : "channel-pending"
                }
              >
                {channels === null
                  ? "读取配置中"
                  : channels.phone
                    ? "已配置"
                    : "待接入"}
              </span>
            </div>
            <p>
              与预约专用语音助手交谈，查询真实空档；核对姓名、联系电话和时段，明确确认后提交预约。
            </p>
            {channels?.phone && channels.phoneNumber ? (
              <a
                href={`tel:${channels.phoneNumber}`}
                className="channel-contact"
              >
                {channels.phoneNumber}
              </a>
            ) : (
              <span className="channel-help">配置电话服务及号码后开放</span>
            )}
          </article>
          <article>
            <span className="channel-symbol" aria-hidden="true">
              @
            </span>
            <div className="channel-title">
              <h3>邮件预约</h3>
              <span
                className={
                  channels?.email ? "channel-ready" : "channel-pending"
                }
              >
                {channels === null
                  ? "读取配置中"
                  : channels.email
                    ? "已配置"
                    : "待接入"}
              </span>
            </div>
            <p>
              发送预约指令，由系统自动查询和处理；修改或取消时需提供管理码。
            </p>
            {channels?.email && channels.emailAddress ? (
              <a
                href={`mailto:${channels.emailAddress}`}
                className="channel-contact"
              >
                {channels.emailAddress}
              </a>
            ) : (
              <span className="channel-help">配置邮件收发服务后开放</span>
            )}
          </article>
          <article>
            <span className="channel-symbol" aria-hidden="true">
              ···
            </span>
            <div className="channel-title">
              <h3>短信预约</h3>
              <span
                className={channels?.sms ? "channel-ready" : "channel-pending"}
              >
                {channels === null
                  ? "读取配置中"
                  : channels.sms
                    ? "已配置"
                    : "待接入"}
              </span>
            </div>
            <p>
              通过短信发送结构化指令，获取可用时段或预约结果，无需打开网页。
            </p>
            {channels?.sms && channels.phoneNumber ? (
              <a
                href={`sms:${channels.phoneNumber}`}
                className="channel-contact"
              >
                {channels.phoneNumber}
              </a>
            ) : (
              <span className="channel-help">配置短信服务及号码后开放</span>
            )}
          </article>
        </div>
        <details className="command-help">
          <summary>
            查看邮件与短信的指令格式 <span>＋</span>
          </summary>
          <div>
            <p>
              日期和时间均为悉尼时间，姓名请使用不含空格的称呼。时长省略时默认 2
              小时。
            </p>
            <code>查询 2026-11-10</code>
            <code>预订 1 2026-11-10 10:00 张三 2</code>
            <code>修改 预约编号 管理码 2 2026-11-11 14:00 2</code>
            <code>取消 预约编号 管理码</code>
            <p>请将示例日期替换为实际日期。发送前请确认对应渠道已配置。</p>
          </div>
        </details>
      </section>
      <section className="closing-banner">
        <div>
          <p className="eyebrow">MAKE TIME FOR YOUR GAME</p>
          <h2>球场见，是最好的约定。</h2>
          <p>不论哪个时刻，给热爱留一个位置。</p>
        </div>
        <a href="#schedule" aria-label="返回球场日程">
          <Arrow diagonal />
        </a>
      </section>
      <footer>
        <Link href="/" className="footer-brand">
          COURTSIDE<span>用一场网球，打开生活。</span>
        </Link>
        <p>© {today.slice(0, 4)} COURTSIDE</p>
        <Link href="/admin">工作人员入口 ↗</Link>
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
          aria-label="关闭预约窗口"
          disabled={busy}
          onClick={() => setMode(null)}
        >
          ×
        </button>
        <p className="eyebrow">YOUR NEXT GOOD GAME</p>
        <h2 id="dialog-title">
          {result
            ? "预约成功，球场见。"
            : mode === "create"
              ? "为热爱，留个位置。"
              : "管理我的预约"}
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
              预订完成后，请保存预约编号和管理码。你可以凭它们修改或取消预约。
            </p>
            {editorFields()}
            <label className="consent-check">
              <input type="checkbox" required />
              <span>
                我知悉预约人姓名将在公开日程中显示，并确认预约信息准确。
              </span>
            </label>
            <button className="primary-button form-submit" disabled={busy}>
              {busy ? "正在确认时段…" : "确认预约"}
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
              你的预约已保存。请保管以下管理信息，管理码仅在本次确认中显示。
            </p>
            <dl className="booking-details">
              <div>
                <dt>球场</dt>
                <dd>
                  {
                    COURTS.find((court) => court.id === result.booking.courtId)
                      ?.name
                  }
                </dd>
              </div>
              <div>
                <dt>日期</dt>
                <dd>
                  {dayLabel(dateParts(result.booking.startsAt).date, true)}
                </dd>
              </div>
              <div>
                <dt>时段</dt>
                <dd>{range(result.booking.startsAt, result.booking.endsAt)}</dd>
              </div>
              <div>
                <dt>预约人</dt>
                <dd>{result.booking.customerName}</dd>
              </div>
            </dl>
            <div className="booking-credentials">
              <div>
                <span>预约编号</span>
                <strong>{result.booking.id}</strong>
              </div>
              <div>
                <span>管理码 · 请勿分享</span>
                <strong>{result.accessCode}</strong>
              </div>
            </div>
            <p className="privacy-note">
              管理码是修改或取消预约的凭证，请截屏或妥善保存。网页预订不会自动发送短信或邮件通知。
            </p>
            <button
              className="primary-button form-submit"
              onClick={() => setMode(null)}
            >
              已保存，返回日程 <Arrow />
            </button>
          </div>
        )}
        {mode === "manage" && !managed && (
          <form className="booking-form" onSubmit={lookup}>
            <p className="dialog-intro">
              输入预约成功时获得的编号和管理码。电话、邮件和短信创建的预约同样可以在此管理。
            </p>
            <label>
              预约编号
              <input
                value={lookupId}
                onChange={(event) => setLookupId(event.target.value)}
                inputMode="numeric"
                autoComplete="off"
                pattern="[0-9]{8}"
                minLength={8}
                maxLength={8}
                required
                placeholder="8 位预约编号"
              />
            </label>
            <label>
              管理码
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
                placeholder="10 位管理码"
              />
            </label>
            <button className="primary-button form-submit" disabled={busy}>
              {busy ? "正在查询…" : "查询我的预约"}
              <Arrow />
            </button>
          </form>
        )}
        {mode === "manage" && managed && (
          <>
            <div className="managed-heading">
              <span>预约 #{managed.id}</span>
              <span
                className={`status-tag ${managed.status === "cancelled" ? "cancelled" : ""}`}
              >
                {managed.status === "cancelled" ? "已取消" : "已确认"}
              </span>
            </div>
            {managed.status === "confirmed" ? (
              <form className="booking-form" onSubmit={changeBooking}>
                {editorFields()}
                <button className="primary-button form-submit" disabled={busy}>
                  {busy ? "正在保存…" : "保存修改"}
                  <Arrow />
                </button>
                <div className="cancel-area">
                  {cancelConfirm ? (
                    <>
                      <p>确定取消这次预约？取消后时段将重新开放。</p>
                      <div>
                        <button
                          type="button"
                          className="secondary-button"
                          disabled={busy}
                          onClick={() => setCancelConfirm(false)}
                        >
                          保留预约
                        </button>
                        <button
                          type="button"
                          className="danger-button"
                          disabled={busy}
                          onClick={cancelBooking}
                        >
                          {busy ? "正在取消…" : "确定取消预约"}
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
                      取消这次预约
                    </button>
                  )}
                </div>
              </form>
            ) : (
              <>
                <dl className="booking-details">
                  <div>
                    <dt>球场</dt>
                    <dd>
                      {
                        COURTS.find((court) => court.id === managed.courtId)
                          ?.name
                      }
                    </dd>
                  </div>
                  <div>
                    <dt>原日期</dt>
                    <dd>{dayLabel(dateParts(managed.startsAt).date, true)}</dd>
                  </div>
                  <div>
                    <dt>原时段</dt>
                    <dd>{range(managed.startsAt, managed.endsAt)}</dd>
                  </div>
                </dl>
                <button
                  className="primary-button form-submit"
                  onClick={() => setMode(null)}
                >
                  返回日程 <Arrow />
                </button>
              </>
            )}
          </>
        )}
      </dialog>
    </main>
  );
}

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
  web: "网页",
  phone: "电话",
  sms: "短信",
  email: "邮件",
  staff: "工作人员",
};

const attendanceLabels: Record<AttendanceCallSummary["status"], string> = {
  requesting: "正在提交拨号请求…",
  queued: "拨号已排队，等待接通。",
  ringing: "正在振铃，等待客户接听…",
  "in-progress": "通话中，等待客户确认到场。",
  attending: "已确认到场。",
  cancelled: "到场结果已更新，请刷新预约状态。",
  unanswered: "未接听，预约保留。",
  completed: "通话已结束，未确认到场，预约保留。",
  failed: "拨号失败，预约保留。",
  unknown: "拨号状态待确认，请勿重复拨打。",
  stale: "预约已变更，此次电话不再确认当前预约。",
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
    if (response.ok) throw new Error("服务器响应不完整，请重试。");
    return {};
  });
  if (!response.ok)
    throw new RequestError(
      data.error || "请求失败，请稍后重试。",
      response.status,
    );
  return data as T;
}

function localStart(iso: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
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
  return new Intl.DateTimeFormat("zh-CN", {
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
      ? "已确认不能到场，预约已取消。"
      : "预约已取消。";
  }
  if (call) {
    if (call.status === "stale" || call.bookingVersion !== booking.version)
      return "预约已变更，此次电话不再确认当前预约。";
    return attendanceLabels[call.status];
  }
  if (!booking.phone.trim()) return "未填写电话，无法电话确认。";
  if (new Date(booking.startsAt).getTime() <= Date.now())
    return "预约已开始，无法电话确认。";
  return "拨打客户电话，询问是否按时到场。";
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
        setError(err instanceof Error ? err.message : "读取预约失败。");
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
      setError(err instanceof Error ? err.message : "登录失败。");
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
      setError(err instanceof Error ? err.message : "退出失败。");
    }
  }

  const saved = useCallback(() => {
    setRefreshKey((value) => value + 1);
    setNotice("预约已保存，场地日程已更新。");
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
      setNotice(`预约 ${booking.id} 已取消，时段重新开放。`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "取消失败。");
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
        throw new Error("拨号请求返回结果不完整。");
      callRequests.current.delete(booking.id);
      setAttendanceCalls((previous) => ({
        ...previous,
        [booking.id]: result,
      }));
      setNotice(`预约 ${booking.id}：拨号请求已提交。`);
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
          [booking.id]: "拨号请求结果待确认。可刷新状态或重试同一请求。",
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
          COURTSIDE<span>工作人员控制台</span>
        </Link>
        <div className="admin-header-actions">
          <Link href="/">返回预约首页 ↗</Link>
          {authenticated && (
            <button
              type="button"
              className="admin-button admin-button-subtle"
              onClick={logout}
            >
              退出登录
            </button>
          )}
        </div>
      </header>
      {authenticated === null ? (
        <p className="admin-loading" role="status">
          正在检查登录状态…
        </p>
      ) : !authenticated ? (
        <section className="admin-login">
          <p className="admin-kicker">STAFF ACCESS</p>
          <h1>
            让每一场预约，
            <br />
            都有条不紊。
          </h1>
          <p>登录后查看联系方式，管理来自网页、电话、短信和邮件的预约。</p>
          <form onSubmit={login}>
            <label htmlFor="staff-password">工作人员密码</label>
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
              {loginBusy ? "正在登录…" : "登录控制台 →"}
            </button>
          </form>
          <p className="admin-login-help">
            生产环境请配置
            ADMIN_PASSWORD。开发环境首次启动后，初始密码保存在服务器的{" "}
            <code>.data/admin-password</code> 文件中，请向环境管理员获取。
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
              <h1>场地预约管理</h1>
              <p>两片球场 · 每周七天，全天开放 · 悉尼时间</p>
            </div>
            <button className="admin-button" onClick={() => setEditor({})}>
              ＋ 新建预约
            </button>
          </section>
          <section className="admin-toolbar" aria-label="预约日期筛选">
            <label htmlFor="admin-date">
              查看日期{" "}
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
              刷新日程 ↻
            </button>
            <span>每 30 秒自动更新 · 联系方式仅工作人员可见</span>
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
                    <span>{confirmed.length} 笔有效预约</span>
                  </h2>
                  <p>
                    {confirmed.length
                      ? confirmed
                          .map(
                            (booking) =>
                              `${prettyTime(booking.startsAt)} ${booking.customerName}`,
                          )
                          .join(" · ")
                      : "暂无有效预约，全天可预订"}
                  </p>
                </section>
              );
            })}
          </div>
          <section className="admin-list" aria-labelledby="admin-list-title">
            <div className="admin-list-heading">
              <h2 id="admin-list-title">当日预约记录</h2>
              <span>{visibleBookings.length} 笔 · 包含跨日预约和取消记录</span>
            </div>
            {loadedDate !== date ? (
              <p className="admin-empty" role="status">
                正在读取预约…
              </p>
            ) : visibleBookings.length === 0 ? (
              <div className="admin-empty">
                <span>○</span>
                <h3>这一天还没有预约</h3>
                <p>客户的新预约会显示在这里，也可由工作人员代为创建。</p>
              </div>
            ) : (
              <div className="admin-table-wrap">
                <table className="admin-table">
                  <thead>
                    <tr>
                      <th scope="col">预约 / 球场</th>
                      <th scope="col">时间</th>
                      <th scope="col">预约人</th>
                      <th scope="col">联系方式</th>
                      <th scope="col">来源 / 状态</th>
                      <th scope="col">操作</th>
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
                              至 {prettyTime(booking.endsAt)} ·{" "}
                              {booking.durationHours} 小时
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
                                ? "已确认"
                                : "已取消"}
                            </span>
                          </td>
                          <td>
                            {booking.status === "confirmed" ? (
                              cancelId === booking.id ? (
                                <div className="admin-cancel-confirm">
                                  <p>确认取消此预约？</p>
                                  <button
                                    className="admin-text-button admin-danger"
                                    disabled={cancelBusy}
                                    onClick={() => cancel(booking)}
                                  >
                                    {cancelBusy ? "正在取消…" : "确认取消"}
                                  </button>
                                  <button
                                    className="admin-text-button"
                                    disabled={cancelBusy}
                                    onClick={() => setCancelId(null)}
                                  >
                                    保留预约
                                  </button>
                                </div>
                              ) : (
                                <div className="admin-row-actions">
                                  <button
                                    className="admin-text-button"
                                    aria-label={`修改预约 ${booking.id}`}
                                    onClick={() => setEditor({ booking })}
                                  >
                                    修改
                                  </button>
                                  <button
                                    className="admin-text-button admin-danger"
                                    aria-label={`取消预约 ${booking.id}`}
                                    onClick={() => setCancelId(booking.id)}
                                  >
                                    取消
                                  </button>
                                </div>
                              )
                            ) : (
                              <span className="admin-muted">已释放时段</span>
                            )}
                            <div className="admin-attendance-action">
                              <button
                                type="button"
                                className="admin-attendance-button"
                                aria-label={`电话确认到场：${booking.customerName}，预约 ${booking.id}`}
                                aria-describedby={`attendance-status-${booking.id}`}
                                disabled={
                                  !canCall ||
                                  isCallPending ||
                                  (cancelBusy && cancelId === booking.id)
                                }
                                onClick={() => confirmAttendance(booking)}
                              >
                                {isCallPending
                                  ? "正在请求拨号…"
                                  : "电话确认到场"}
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
            已确认预约的姓名会显示在公开日程中；电话、邮箱和来源仅在工作人员控制台显示。修改与取消均实时检查预约版本和场地冲突。
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
      setError("请至少填写一种联系方式：电话或邮箱。");
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
      setError(err instanceof Error ? err.message : "保存失败。");
      if (err instanceof RequestError && err.status === 409)
        setError(
          `${err.message} 请关闭窗口、刷新日程后重新操作，当前内容尚未保存。`,
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
        aria-label="关闭预约窗口"
        disabled={busy}
        onClick={onClose}
      >
        ×
      </button>
      <p className="admin-kicker">COURTSIDE / RESERVATIONS</p>
      <h2 id="admin-editor-title">
        {created ? "预约已创建" : booking ? "修改预约" : "新建预约"}
      </h2>
      {created ? (
        <div className="admin-created">
          <p>
            已成功保存，请将以下凭据安全交给预约人。管理码仅在本次创建时显示。
          </p>
          <dl>
            <div>
              <dt>预约编号</dt>
              <dd>{created.booking.id}</dd>
            </div>
            <div>
              <dt>管理码</dt>
              <dd>{created.accessCode}</dd>
            </div>
            <div>
              <dt>场地 / 时间</dt>
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
            已保存凭据，返回日程
          </button>
        </div>
      ) : (
        <form onSubmit={submit} className="admin-editor-form">
          <p>
            所有时间为悉尼时间，每片球场全天开放。开始时间为整点，默认预约 2
            小时。
          </p>
          <div className="admin-form-grid">
            <label>
              球场
              <select
                aria-label="球场"
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
              来源
              <select
                aria-label="来源"
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
              {booking && <small>保留预约的原始来源</small>}
            </label>
            <label>
              日期
              <input
                type="date"
                value={date}
                aria-label="日期"
                required
                onChange={(event) => setDate(event.target.value)}
              />
            </label>
            <label>
              开始时间
              <select
                aria-label="开始时间"
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
              预约时长
              <select
                aria-label="预约时长"
                value={durationHours}
                onChange={(event) =>
                  setDurationHours(Number(event.target.value))
                }
              >
                {Array.from({ length: 8 }, (_, index) => index + 1).map(
                  (value) => (
                    <option key={value} value={value}>
                      {value} 小时{value === 2 ? "（默认）" : ""}
                    </option>
                  ),
                )}
              </select>
            </label>
            <label>
              预约人姓名
              <input
                value={name}
                required
                maxLength={80}
                onChange={(event) => setName(event.target.value)}
                autoComplete="name"
              />
            </label>
            <label>
              电话
              <input
                type="tel"
                value={phone}
                maxLength={40}
                onChange={(event) => setPhone(event.target.value)}
                autoComplete="tel"
              />
            </label>
            <label>
              邮箱
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
            电话和邮箱至少填写一项。客户姓名会显示在公开日程上，请先向客户说明；联系方式仅工作人员可见。
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
              返回
            </button>
            <button className="admin-button" disabled={busy}>
              {busy ? "正在保存…" : booking ? "保存修改" : "确认创建"}
            </button>
          </div>
        </form>
      )}
    </dialog>
  );
}

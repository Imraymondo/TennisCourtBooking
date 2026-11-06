"use client";

import { useEffect, useRef, useState } from "react";

type Court = {
  id: number;
  name: string;
  english: string;
  type: "室外硬地" | "室内球场";
  surface: string;
  price: number;
  color: string;
  slots: string[];
  unavailable: string[];
};

const courts: Court[] = [
  {
    id: 1,
    name: "花园一号场",
    english: "THE GARDEN COURT",
    type: "室外硬地",
    surface: "丙烯酸硬地 · 自然采光",
    price: 120,
    color: "garden",
    slots: ["08:00", "09:00", "10:00", "14:00", "16:00", "18:00"],
    unavailable: ["09:00", "14:00"],
  },
  {
    id: 2,
    name: "中央二号场",
    english: "THE CENTRE COURT",
    type: "室外硬地",
    surface: "丙烯酸硬地 · 夜间照明",
    price: 150,
    color: "centre",
    slots: ["08:00", "09:00", "11:00", "15:00", "17:00", "19:00"],
    unavailable: ["11:00"],
  },
  {
    id: 3,
    name: "全天候三号场",
    english: "THE INDOOR COURT",
    type: "室内球场",
    surface: "室内硬地 · 风雨无阻",
    price: 180,
    color: "indoor",
    slots: ["09:00", "10:00", "13:00", "15:00", "18:00", "20:00"],
    unavailable: ["10:00", "18:00"],
  },
];

export type DateOption = {
  key: string;
  day: string;
  number: string;
  label: string;
  isToday: boolean;
  isWeekend: boolean;
};

function Arrow({ diagonal = false }: { diagonal?: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      aria-hidden="true"
    >
      <path d={diagonal ? "M6 18 18 6M6 6h12v12" : "M4 12h15m-6-6 6 6-6 6"} />
    </svg>
  );
}

function Ball({ className = "" }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 40 40"
      fill="none"
      aria-hidden="true"
    >
      <circle cx="20" cy="20" r="18" fill="currentColor" />
      <path
        d="M7.5 7.5c15 4 15 21 25 25M32.5 7.5c-15 4-15 21-25 25"
        stroke="var(--cream)"
        strokeWidth="1.7"
      />
    </svg>
  );
}

function CourtDrawing({ hero = false }: { hero?: boolean }) {
  return (
    <svg
      className={hero ? "hero-court-svg" : "court-svg"}
      viewBox="0 0 520 340"
      fill="none"
      role="img"
      aria-label="网球场示意图"
    >
      <rect width="520" height="340" className="court-surround" />
      <rect
        x="85"
        y="38"
        width="350"
        height="264"
        className="court-playing-area"
      />
      <g stroke="var(--court-lines)" strokeWidth="2" opacity=".9">
        <rect x="85" y="38" width="350" height="264" />
        <path d="M129 38v264M391 38v264M129 102h262M129 238h262M260 102v136M85 170h350" />
      </g>
      <path d="M73 170h374" stroke="var(--court-lines)" strokeWidth="4" />
      <path d="M73 175h374" stroke="#163e30" strokeWidth="6" opacity=".2" />
      <circle cx="350" cy="94" r="7" fill="#e5ee99" />
      <path d="m350 94-24 18" stroke="#e5ee99" strokeWidth="2" opacity=".5" />
      {hero && (
        <g>
          <circle cx="129" cy="265" r="13" fill="#f5f0df" />
          <circle cx="129" cy="262" r="6" fill="#d8ad87" />
          <path d="m137 253 13-15" stroke="#f5f0df" strokeWidth="4" />
          <ellipse
            cx="154"
            cy="233"
            rx="7"
            ry="10"
            transform="rotate(35 154 233)"
            stroke="#e8edb0"
            strokeWidth="2"
          />
          <circle cx="360" cy="70" r="12" fill="#d5df8b" />
          <circle cx="360" cy="67" r="5" fill="#d8ad87" />
        </g>
      )}
    </svg>
  );
}

export default function BookingHome({
  dates,
  monthLabel,
}: {
  dates: DateOption[];
  monthLabel: string;
}) {
  const [date, setDate] = useState(0);
  const [filter, setFilter] = useState("所有场地");
  const [booking, setBooking] = useState<{
    court: Court;
    slot: string;
    date: string;
  } | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const visibleCourts = courts.filter(
    (court) => filter === "所有场地" || court.type === filter,
  );

  useEffect(() => {
    if (booking && !dialog.current?.open) dialog.current?.showModal();
    if (!booking && dialog.current?.open) dialog.current?.close();
  }, [booking]);

  function openBooking(court: Court, slot: string) {
    setConfirmed(false);
    setBooking({ court, slot, date: dates[date].label });
  }

  return (
    <main>
      <header className="site-header">
        <a href="#" className="brand" aria-label="COURTSIDE 首页">
          <Ball />
          <span>
            COURTSIDE<span className="brand-sub">网球，让生活好一点。</span>
          </span>
        </a>
        <nav aria-label="主导航">
          <a className="nav-active" href="#reserve">
            预订球场
          </a>
          <a href="#club">关于俱乐部</a>
        </nav>
        <a className="header-cta" href="#reserve">
          去打球 <Arrow diagonal />
        </a>
      </header>

      <section className="hero" aria-labelledby="hero-title">
        <div className="hero-copy">
          <div className="eyebrow">
            <span className="little-line" /> A LITTLE MORE TENNIS, A LITTLE MORE
            LIFE.
          </div>
          <h1 id="hero-title">
            留点时间，
            <br />给<span className="hero-accent">下一场好球。</span>
          </h1>
          <p className="hero-description">
            放下日常的忙碌，走上你喜欢的球场。
            <br />
            属于你的挥拍时刻，从这里开始。
          </p>
          <a className="primary-button" href="#reserve">
            寻找我的球场 <Arrow />
          </a>
          <div className="hero-footnote">
            <span className="availability-dot" /> 三片好场地，每天都有新的期待
          </div>
        </div>
        <div className="hero-art" aria-label="阳光下的绿色网球场插画">
          <div className="art-topline">
            <span>THE COURT IS CALLING.</span>
            <span>↗</span>
          </div>
          <div className="hero-court-wrap">
            <CourtDrawing hero />
          </div>
          <div className="court-caption">
            <span>
              LESS SCROLLING.
              <br />
              MORE SERVING.
            </span>
            <span className="caption-script">See you on court.</span>
          </div>
          <div className="art-stamp">
            <Ball />
            <span>
              GOOD DAYS
              <br />
              START HERE
            </span>
          </div>
        </div>
      </section>

      <div className="benefits" id="club">
        <div>
          <span className="benefit-number">01</span>
          <span>
            为每一次挥拍准备
            <span className="benefit-sub">专业场地，舒适体验</span>
          </span>
        </div>
        <div>
          <span className="benefit-number">02</span>
          <span>
            你的时间，你来安排
            <span className="benefit-sub">按小时预订，轻松开场</span>
          </span>
        </div>
        <div>
          <span className="benefit-number">03</span>
          <span>
            带上球拍就出发
            <span className="benefit-sub">室内室外，总有好选择</span>
          </span>
        </div>
      </div>

      <section
        className="booking-section"
        id="reserve"
        aria-labelledby="booking-title"
      >
        <div className="section-heading">
          <div>
            <p className="eyebrow">FIND YOUR NEXT COURT</p>
            <h2 id="booking-title">
              好球场，等你上场<span>。</span>
            </h2>
          </div>
          <p>选个日子，把时间留给热爱。</p>
        </div>
        <div className="booking-controls">
          <div className="date-header">
            <h3>选择日期</h3>
            <span>
              {monthLabel} <span aria-hidden="true">↘</span>
            </span>
          </div>
          <div className="date-list" role="group" aria-label="选择预订日期">
            {dates.map((item, index) => (
              <button
                key={item.key}
                className={`date-button ${date === index ? "selected" : ""}`}
                aria-pressed={date === index}
                onClick={() => setDate(index)}
              >
                <span>{item.day}</span>
                <strong>{item.number}</strong>
                <span className="date-note">
                  {item.isToday ? "今日" : item.isWeekend ? "周末" : "可预订"}
                </span>
              </button>
            ))}
          </div>
          <div className="filter-row">
            <div
              className="filter-buttons"
              role="group"
              aria-label="筛选球场类型"
            >
              {["所有场地", "室外硬地", "室内球场"].map((item) => (
                <button
                  key={item}
                  aria-pressed={filter === item}
                  className={filter === item ? "active" : ""}
                  onClick={() => setFilter(item)}
                >
                  {item}
                </button>
              ))}
            </div>
            <span className="filter-count" aria-live="polite">
              {visibleCourts.length} 片场地可选择
            </span>
          </div>
        </div>

        <div className="court-grid">
          {visibleCourts.map((court) => (
            <article className={`court-card ${court.color}`} key={court.id}>
              <div className="court-image">
                <CourtDrawing />
                <span className="court-type">{court.type}</span>
                <span className="court-id">0{court.id}</span>
              </div>
              <div className="court-content">
                <p className="court-english">{court.english}</p>
                <div className="court-title-row">
                  <h3>{court.name}</h3>
                  <p className="court-price">
                    <strong>¥{court.price}</strong>
                    <span> / 小时</span>
                  </p>
                </div>
                <p className="court-surface">{court.surface}</p>
                <div className="slots-heading">
                  <span>可选时段</span>
                  <span>每场 60 分钟</span>
                </div>
                <div className="time-slots">
                  {court.slots.map((slot) => (
                    <button
                      key={slot}
                      disabled={court.unavailable.includes(slot)}
                      onClick={() => openBooking(court, slot)}
                      aria-label={`${dates[date].label}，${court.name}，${slot}，${court.unavailable.includes(slot) ? "不可预订" : "预订一小时"}`}
                    >
                      {slot}
                    </button>
                  ))}
                </div>
              </div>
            </article>
          ))}
        </div>
        <div className="booking-note">
          <span className="note-icon" aria-hidden="true">
            i
          </span>
          <p>
            这是预订体验演示。场地、价格与时段均为示例，确认操作不会生成真实订单或扣款。
          </p>
          <span className="legend">
            <span /> 已被预订
          </span>
        </div>
      </section>

      <section className="closing-banner">
        <div>
          <p className="eyebrow">MAKE TIME FOR YOUR GAME</p>
          <h2>球场见，是最好的约定。</h2>
          <p>一个人练习，或和朋友来一场。好时光，都算数。</p>
        </div>
        <a href="#reserve" aria-label="返回选择球场">
          <Arrow diagonal />
        </a>
      </section>
      <footer>
        <a className="footer-brand" href="#">
          COURTSIDE<span>用一场网球，打开生活。</span>
        </a>
        <p>© {dates[0].key.slice(0, 4)} COURTSIDE · 网球场预订演示</p>
        <span>LOVE THE GAME. LOVE THE DAY.</span>
      </footer>

      <dialog
        ref={dialog}
        className="booking-dialog"
        onClose={() => setBooking(null)}
        aria-labelledby="dialog-title"
        aria-describedby="dialog-description"
      >
        <button
          className="dialog-close"
          aria-label="关闭预订窗口"
          onClick={() => setBooking(null)}
        >
          ×
        </button>
        {booking && (
          <>
            <div className="dialog-icon">
              {confirmed ? <span aria-hidden="true">✓</span> : <Ball />}
            </div>
            <p className="eyebrow">
              {confirmed ? "SEE YOU ON COURT" : "YOUR NEXT GOOD GAME"}
            </p>
            <h2 id="dialog-title">
              {confirmed ? "体验确认完成" : "给自己留一场好球"}
            </h2>
            <p id="dialog-description">
              {confirmed
                ? "你已完成演示流程。此操作未创建真实预订，也不会产生费用。"
                : "请确认以下示例场次。此页面为演示，不会创建真实预订。"}
            </p>
            <dl className="booking-details">
              <div>
                <dt>球场</dt>
                <dd>{booking.court.name}</dd>
              </div>
              <div>
                <dt>日期</dt>
                <dd>{booking.date}</dd>
              </div>
              <div>
                <dt>时段</dt>
                <dd>
                  {booking.slot} —{" "}
                  {String(Number(booking.slot.split(":")[0]) + 1).padStart(
                    2,
                    "0",
                  )}
                  :00
                </dd>
              </div>
              <div>
                <dt>示例费用</dt>
                <dd>¥{booking.court.price} / 60 分钟</dd>
              </div>
            </dl>
            <button
              className="primary-button dialog-confirm"
              onClick={() =>
                confirmed ? setBooking(null) : setConfirmed(true)
              }
            >
              {confirmed ? "继续挑选球场" : "确认体验预订"}
              <Arrow />
            </button>
          </>
        )}
      </dialog>
    </main>
  );
}

import { useEffect, useState } from "react";
import { useGame } from "./net";
import { cardLabel, SUIT_LABEL, SUIT_NAME } from "../../shared/deck";
import { Card, ClientView, Suit, SUITS, teamOfSeat } from "../../shared/types";

// ---------------------------------------------------------------------------
//  Room + name bootstrap
// ---------------------------------------------------------------------------

const roomFromHash = () => window.location.hash.replace("#", "").toUpperCase() || null;
const randomRoom = () => {
  const alpha = "ABCDEFGHJKLMNPRSTUVWXYZ23456789";
  let s = "";
  for (let i = 0; i < 4; i++) s += alpha[Math.floor(Math.random() * alpha.length)];
  return s;
};

export function App() {
  const [roomId, setRoomId] = useState<string | null>(roomFromHash());
  const [name, setName] = useState<string | null>(
    () => localStorage.getItem("ruung_name") || null,
  );

  useEffect(() => {
    const onHash = () => setRoomId(roomFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  if (!roomId || !name) {
    return (
      <Landing
        onStart={(n, r) => {
          localStorage.setItem("ruung_name", n);
          window.location.hash = r;
          setName(n);
          setRoomId(r);
        }}
      />
    );
  }

  return <Game roomId={roomId} name={name} />;
}

// ---------------------------------------------------------------------------
//  Landing screen
// ---------------------------------------------------------------------------

function Landing({ onStart }: { onStart: (name: string, room: string) => void }) {
  const [name, setName] = useState(localStorage.getItem("ruung_name") || "");
  const [room, setRoom] = useState(roomFromHash() || "");

  const go = (r: string) => {
    const n = name.trim();
    if (!n) return;
    onStart(n, r.trim().toUpperCase());
  };

  return (
    <div className="screen center">
      <div className="card-panel landing">
        <h1 className="logo">Ruung</h1>
        <p className="muted">Trumps with friends — 4 players, 2 teams.</p>

        <label className="field">
          <span>Your name</span>
          <input
            value={name}
            maxLength={16}
            placeholder="e.g. Taimoor"
            onChange={(e) => setName(e.target.value)}
          />
        </label>

        <label className="field">
          <span>Room code</span>
          <input
            value={room}
            placeholder="Join with a code"
            onChange={(e) => setRoom(e.target.value.toUpperCase())}
          />
        </label>

        <div className="row gap">
          <button className="btn primary" disabled={!name.trim() || !room.trim()} onClick={() => go(room)}>
            Join room
          </button>
          <button className="btn" disabled={!name.trim()} onClick={() => go(randomRoom())}>
            Create new room
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
//  Game screen
// ---------------------------------------------------------------------------

function Game({ roomId, name }: { roomId: string; name: string }) {
  const net = useGame(roomId, name);
  const { view, error, connected } = net;

  useEffect(() => {
    if (!error) return;
    const t = setTimeout(net.clearError, 3500);
    return () => clearTimeout(t);
  }, [error]);

  if (!view) {
    return (
      <div className="screen center">
        <div className="muted">{connected ? "Loading game…" : "Connecting…"}</div>
      </div>
    );
  }

  return (
    <div className="screen">
      <Header view={view} roomId={roomId} />
      {error && <div className="toast">{error}</div>}

      {view.phase === "lobby" && <Lobby view={view} roomId={roomId} send={net.send} />}
      {view.phase === "auction" && <Auction view={view} send={net.send} />}
      {view.phase === "playing" && <Play view={view} send={net.send} />}
      {view.phase === "roundOver" && <RoundOver view={view} send={net.send} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
//  Header
// ---------------------------------------------------------------------------

function Header({ view, roomId }: { view: ClientView; roomId: string }) {
  const copyLink = () => {
    navigator.clipboard?.writeText(`${window.location.origin}/#${roomId}`);
  };
  return (
    <header className="header">
      <div className="row gap center-v">
        <strong className="brand">Ruung</strong>
        <button className="chip" onClick={copyLink} title="Copy invite link">
          Room {roomId} · copy link
        </button>
      </div>
      <div className="row gap center-v">
        {view.round > 0 && <span className="chip">Round {view.round}</span>}
        {view.trump && (
          <span className={`chip suit-${view.trump}`}>
            Trump {SUIT_LABEL[view.trump]}
          </span>
        )}
        {view.contract && <span className="chip">Contract {view.contract}</span>}
        <span className="chip">
          Us {view.matchScore[youTeam(view)]} · Them {view.matchScore[oppTeam(view)]}
        </span>
      </div>
    </header>
  );
}

const youTeam = (v: ClientView) => (v.youSeat === null ? 0 : teamOfSeat(v.youSeat));
const oppTeam = (v: ClientView) => (youTeam(v) === 0 ? 1 : 0);

// ---------------------------------------------------------------------------
//  Lobby
// ---------------------------------------------------------------------------

function Lobby({
  view,
  roomId,
  send,
}: {
  view: ClientView;
  roomId: string;
  send: ReturnType<typeof useGame>["send"];
}) {
  const seated = view.players.filter((p) => p.name).length;
  const link = `${window.location.origin}/#${roomId}`;
  // Team 1 sits in seats 0 & 2, Team 2 in seats 1 & 3 (partners opposite).
  const teams: number[][] = [
    [0, 2],
    [1, 3],
  ];

  const SeatRow = ({ seat }: { seat: number }) => {
    const p = view.players[seat];
    const isYou = seat === view.youSeat;
    const occupied = !!p.name;
    return (
      <div className={`lobby-seat ${isYou ? "you" : ""}`}>
        <span className="ls-name">
          {occupied ? p.name : <em className="muted">empty</em>}
          {isYou && " (you)"}
          {occupied && !p.connected && " ⚠"}
        </span>
        {!isYou && (
          <button className="btn tiny" onClick={() => send({ type: "takeSeat", seat })}>
            {occupied ? "Swap" : "Sit here"}
          </button>
        )}
      </div>
    );
  };

  return (
    <div className="panel-stack">
      <div className="card-panel">
        <h2>Choose your team ({seated}/4)</h2>
        <p className="muted small">Tap a seat to sit there or swap places. Partners sit opposite.</p>
        <div className="team-picker">
          {teams.map((seatsOfTeam, t) => (
            <div key={t} className={`team-col team-${t}`}>
              <div className="team-label">Team {t + 1}</div>
              {seatsOfTeam.map((seat) => (
                <SeatRow key={seat} seat={seat} />
              ))}
            </div>
          ))}
        </div>
      </div>

      <div className="card-panel">
        <h3>Invite friends</h3>
        <p className="muted small">Send this link — anyone who opens it joins this room.</p>
        <div className="row gap">
          <input className="grow" readOnly value={link} onFocus={(e) => e.target.select()} />
          <button className="btn" onClick={() => navigator.clipboard?.writeText(link)}>
            Copy
          </button>
        </div>
      </div>

      <button
        className="btn primary big"
        disabled={seated < 4}
        onClick={() => send({ type: "startGame" })}
      >
        {seated < 4 ? `Waiting for ${4 - seated} more…` : "Start game"}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
//  Auction
// ---------------------------------------------------------------------------

function Auction({
  view,
  send,
}: {
  view: ClientView;
  send: ReturnType<typeof useGame>["send"];
}) {
  const [suit, setSuit] = useState<Suit>("S");
  const yourTurn = view.auctionTurnSeat === view.youSeat;
  const minCount = view.currentBid ? view.currentBid.count : 0;
  const counts: (7 | 10 | 13)[] = [7, 10, 13];

  return (
    <div className="panel-stack">
      {view.drawReveal && (
        <div className="card-panel">
          <h3>Draw for first call</h3>
          <div className="row gap wrap">
            {view.drawReveal.map((d) => (
              <div key={d.seat} className="draw-item">
                <PlayingCard card={d.card} small />
                <span className="small">
                  {view.players[d.seat].name}
                  {d.seat === view.callerSeat && " 👑"}
                </span>
              </div>
            ))}
          </div>
          <p className="muted small">
            {view.callerSeat !== null && view.players[view.callerSeat].name} drew highest and
            calls first.
          </p>
        </div>
      )}

      <div className="card-panel">
        <h2>Bidding</h2>
        <p className="muted">
          Current bid:{" "}
          {view.currentBid ? (
            <strong>
              {view.currentBid.count} on {SUIT_NAME[view.currentBid.suit]} ·{" "}
              {view.players[view.currentBid.seat].name}
            </strong>
          ) : (
            <em>none yet</em>
          )}
        </p>
        <p className="muted small">
          Turn:{" "}
          {view.auctionTurnSeat !== null && (
            <strong>{view.players[view.auctionTurnSeat].name}</strong>
          )}
        </p>

        <YourHand cards={view.hand} title="Your first 5 cards" />

        {yourTurn ? (
          <div className="auction-controls">
            <div className="suit-picker">
              {SUITS.map((s) => (
                <button
                  key={s}
                  className={`suit-btn suit-${s} ${suit === s ? "sel" : ""}`}
                  onClick={() => setSuit(s)}
                >
                  {SUIT_LABEL[s]}
                </button>
              ))}
            </div>
            <div className="row gap wrap">
              {counts.map((c) => (
                <button
                  key={c}
                  className="btn primary"
                  disabled={c <= minCount}
                  onClick={() => send({ type: "bid", count: c, suit })}
                >
                  Bid {c}
                </button>
              ))}
              <button
                className="btn"
                disabled={!view.currentBid && view.youSeat === view.callerSeat}
                onClick={() => send({ type: "pass" })}
              >
                Pass
              </button>
            </div>
          </div>
        ) : (
          <p className="muted">Waiting for others to bid…</p>
        )}
      </div>

      <div className="card-panel log">
        <h3>Auction log</h3>
        <ul>
          {view.auctionLog.slice(-8).map((l, i) => (
            <li key={i}>{l}</li>
          ))}
        </ul>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
//  Play
// ---------------------------------------------------------------------------

const POS = ["pos-bottom", "pos-left", "pos-top", "pos-right"];
const relPos = (seat: number, youSeat: number | null) =>
  POS[(seat - (youSeat ?? 0) + 4) % 4];

function Play({
  view,
  send,
}: {
  view: ClientView;
  send: ReturnType<typeof useGame>["send"];
}) {
  const yourTurn = view.turnSeat === view.youSeat;
  const isLegal = (c: Card) =>
    !view.legalCards || view.legalCards.some((l) => l.suit === c.suit && l.rank === c.rank);

  return (
    <div className="panel-stack">
      <div className="table-info">
        <span className="chip">Trick {view.trickNumber}/13</span>
        {isWasted(view.trickNumber) && <span className="chip warn">Wasted round</span>}
        {view.trump && <span className={`chip suit-${view.trump}`}>Trump {SUIT_LABEL[view.trump]}</span>}
      </div>

      <div className="table-felt">
        {view.players.map((p) => {
          const active = view.turnSeat === p.seat;
          return (
            <div
              key={p.seat}
              className={`nameplate ${relPos(p.seat, view.youSeat)} team-t${teamOfSeat(p.seat)} ${
                active ? "active" : ""
              }`}
            >
              <div className="np-name">
                {p.name}
                {p.seat === view.youSeat && " (you)"}
                {!p.connected && " ⚠"}
              </div>
              <div className="np-meta">
                Team {teamOfSeat(p.seat) + 1} · {p.handCount} cards
                {p.seat === view.callerSeat && " · 👑"}
              </div>
            </div>
          );
        })}

        <div className="table-center">
          {view.players.map((p) => {
            const played = view.currentTrick.find((t) => t.seat === p.seat);
            return (
              <div key={p.seat} className={`center-slot ${relPos(p.seat, view.youSeat)}`}>
                {played ? (
                  <PlayingCard card={played.card} />
                ) : (
                  <div className="card-ghost sm" />
                )}
              </div>
            );
          })}
          {view.leadSeat !== null && (
            <div className="center-hint small muted">
              {yourTurn ? "your turn" : `${view.players[view.turnSeat ?? 0].name}'s turn`}
            </div>
          )}
        </div>
      </div>

      <ScorePanel view={view} />

      <div className="hand-wrap">
        <div className="hand-title">
          {yourTurn ? <strong className="turn-flag">Your turn — play a card</strong> : "Your hand"}
        </div>
        <div className="hand">
          {view.hand.map((c) => {
            const legal = yourTurn && isLegal(c);
            return (
              <button
                key={`${c.suit}${c.rank}`}
                className={`playing-card big ${suitColor(c.suit)} ${legal ? "playable" : ""} ${
                  yourTurn && !legal ? "dimmed" : ""
                }`}
                disabled={!legal}
                onClick={() => send({ type: "playCard", card: c })}
              >
                <span className="pc-rank">{cardLabel(c).slice(0, -1)}</span>
                <span className="pc-suit">{SUIT_LABEL[c.suit]}</span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
//  Score panel (seniority + credited)
// ---------------------------------------------------------------------------

function ScorePanel({ view }: { view: ClientView }) {
  const s = view.score;
  return (
    <div className="card-panel score">
      <div className="score-row">
        <span>Credited tricks</span>
        <strong>
          Us {s.credited[youTeam(view)]} · Them {s.credited[oppTeam(view)]}
        </strong>
      </div>
      <div className="score-row small muted">
        <span>
          Senior:{" "}
          {s.seniorTeam === null
            ? "—"
            : s.seniorTeam === youTeam(view)
              ? `Us (streak ${s.streakLen})`
              : `Them (streak ${s.streakLen})`}
        </span>
        {view.contract && (
          <span>
            Target {view.contract} ·{" "}
            {view.contractTeam === youTeam(view) ? "we called" : "they called"}
          </span>
        )}
      </div>
      {view.lastTrick && (
        <div className="score-row small muted">
          <span>Last trick won by {view.players[view.lastTrick.winnerSeat].name}</span>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
//  Round over
// ---------------------------------------------------------------------------

function RoundOver({
  view,
  send,
}: {
  view: ClientView;
  send: ReturnType<typeof useGame>["send"];
}) {
  const r = view.roundResult!;
  const weWon = r.winnerTeam === youTeam(view);
  return (
    <div className="panel-stack">
      <div className={`card-panel result ${weWon ? "win" : "lose"}`}>
        <h2>{weWon ? "Your team won the round 🎉" : "Other team won the round"}</h2>
        <p>
          Contract was <strong>{r.contract}</strong>, called by{" "}
          <strong>Team {r.contractTeam + 1}</strong> — {r.contractMade ? "made ✅" : "failed ❌"}.
        </p>
        <p className="muted">
          Credited tricks — Team 1: {r.credited[0]} · Team 2: {r.credited[1]}
        </p>
        <p className="muted small">
          {view.callerSeat !== null && view.players[view.callerSeat].name} calls Ruung next round.
        </p>
      </div>
      <button className="btn primary big" onClick={() => send({ type: "nextRound" })}>
        Next round
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
//  Small pieces
// ---------------------------------------------------------------------------

function YourHand({ cards, title }: { cards: Card[]; title: string }) {
  return (
    <div className="hand-wrap tight">
      <div className="hand-title small muted">{title}</div>
      <div className="hand">
        {cards.map((c) => (
          <div key={`${c.suit}${c.rank}`} className={`playing-card ${suitColor(c.suit)}`}>
            <span className="pc-rank">{cardLabel(c).slice(0, -1)}</span>
            <span className="pc-suit">{SUIT_LABEL[c.suit]}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function PlayingCard({ card, small }: { card: Card; small?: boolean }) {
  return (
    <div className={`playing-card ${small ? "" : "med"} ${suitColor(card.suit)}`}>
      <span className="pc-rank">{cardLabel(card).slice(0, -1)}</span>
      <span className="pc-suit">{SUIT_LABEL[card.suit]}</span>
    </div>
  );
}

const suitColor = (s: Suit) => (s === "H" || s === "D" ? "red" : "black");
const isWasted = (n: number) => n === 1 || n === 2 || n === 3 || n === 12;

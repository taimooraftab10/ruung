import { ReactNode, useEffect, useRef, useState } from "react";
import { useGame } from "./net";
import { cardEq, cardLabel, SUIT_LABEL, SUIT_NAME } from "../../shared/deck";
import { Card, ClientView, Suit, SUITS, teamOfSeat } from "../../shared/types";
import {
  isMuted,
  playCardSound,
  playFanfare,
  playGoon,
  playTurnChime,
  setMuted,
  unlockAudio,
} from "./sound";

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

  return (
    <Game
      roomId={roomId}
      name={name}
      onLeave={() => {
        window.location.hash = "";
        setRoomId(null);
      }}
    />
  );
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

function Game({
  roomId,
  name,
  onLeave,
}: {
  roomId: string;
  name: string;
  onLeave: () => void;
}) {
  const net = useGame(roomId, name);
  const { view, error, connected, roomClosed } = net;
  const wasYourTurn = useRef(false);
  const cardsPlayed = useRef(0);

  // Allow audio after the first tap anywhere (browsers block it until then).
  useEffect(() => {
    const unlock = () => unlockAudio();
    window.addEventListener("pointerdown", unlock, { once: true });
    return () => window.removeEventListener("pointerdown", unlock);
  }, []);

  // Chime when it becomes your turn (in the auction or in play).
  const active =
    !!view &&
    ((view.phase === "playing" && view.turnSeat === view.youSeat) ||
      (view.phase === "auction" && view.auctionTurnSeat === view.youSeat));
  useEffect(() => {
    if (active && !wasYourTurn.current) playTurnChime();
    wasYourTurn.current = active;
  }, [active]);

  // Click when any card is played (count total cards = finished tricks * 4 + current).
  const total = view ? view.trickResults.length * 4 + view.currentTrick.length : 0;
  useEffect(() => {
    if (total > cardsPlayed.current) playCardSound();
    cardsPlayed.current = total;
  }, [total]);

  useEffect(() => {
    if (!error) return;
    const t = setTimeout(net.clearError, 3500);
    return () => clearTimeout(t);
  }, [error]);

  if (roomClosed) {
    return (
      <div className="screen center">
        <div className="card-panel landing">
          <h1 className="logo">Room closed</h1>
          <p className="muted">{roomClosed}</p>
          <button className="btn primary big" onClick={onLeave}>
            Back to home
          </button>
        </div>
      </div>
    );
  }

  if (!view) {
    return (
      <div className="screen center">
        <div className="muted">{connected ? "Loading game…" : "Connecting…"}</div>
      </div>
    );
  }

  const spectating = view.youSeat === null;

  return (
    <div className="screen">
      <Header view={view} roomId={roomId} />
      {error && <div className="toast">{error}</div>}

      {view.hostGraceMsLeft != null && (
        <HostGraceBar msLeft={view.hostGraceMsLeft} hostName={view.hostName} />
      )}

      {spectating && (
        <div className="spectator-bar">
          👀 You’re spectating — you can see everyone’s cards and chat. Grab a free
          seat in the lobby to play.
        </div>
      )}

      {view.phase === "lobby" && <Lobby view={view} roomId={roomId} send={net.send} />}
      {view.phase === "auction" && <Auction view={view} send={net.send} />}
      {view.phase === "playing" && <Play view={view} send={net.send} />}
      {view.phase === "roundOver" && <RoundOver view={view} send={net.send} />}
      {view.phase === "gameOver" && <GameOver view={view} send={net.send} />}

      {spectating &&
        view.allHands &&
        (view.phase === "auction" || view.phase === "playing") && (
          <SpectatorHands view={view} />
        )}

      <Chat view={view} send={net.send} />

      {(view.phase === "roundOver" || view.phase === "gameOver") &&
        view.roundResult &&
        view.roundResult.kind !== "normal" &&
        (view.roundResult.winnerTeam === youTeam(view) ? (
          // The winning team celebrates their court / goon court.
          <BigWin
            key={`win-${view.round}`}
            kind={view.roundResult.kind}
            points={view.roundResult.points}
          />
        ) : view.roundResult.kind === "goon-court" ? (
          // Only the goon-courted (losing) team sees the elephant.
          <GoonElephant key={`ele-${view.round}`} />
        ) : null)}
    </div>
  );
}

// ---------------------------------------------------------------------------
//  Header
// ---------------------------------------------------------------------------

function Header({ view, roomId }: { view: ClientView; roomId: string }) {
  const [muted, setMutedState] = useState(isMuted());
  const copyLink = () => {
    navigator.clipboard?.writeText(`${window.location.origin}/#${roomId}`);
  };
  const toggleMute = () => {
    const m = !muted;
    setMuted(m);
    setMutedState(m);
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
        <button className="chip" onClick={toggleMute} title="Sound on/off">
          {muted ? "🔇" : "🔊"}
        </button>
        {view.round > 0 && <span className="chip">Round {view.round}</span>}
        {view.trump && (
          <span className={`chip suit-${view.trump}`}>
            Ruung {SUIT_LABEL[view.trump]} {SUIT_NAME[view.trump]}
          </span>
        )}
        {view.contract && view.contractSeat !== null && (
          <span className="chip">
            {view.players[view.contractSeat].name} called {view.contract}
          </span>
        )}
        {view.spectators.length > 0 && (
          <span className="chip" title={view.spectators.join(", ")}>
            👀 {view.spectators.length}
          </span>
        )}
        <span className="chip" title={`First to ${view.targetScore}`}>
          {view.youSeat === null
            ? `Team 1 ${view.matchScore[0]} · Team 2 ${view.matchScore[1]} / ${view.targetScore}`
            : `Us ${view.matchScore[youTeam(view)]} · Them ${view.matchScore[oppTeam(view)]} / ${view.targetScore}`}
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

  const spectating = view.youSeat === null;
  const SeatRow = ({ seat }: { seat: number }) => {
    const p = view.players[seat];
    const isYou = seat === view.youSeat;
    const occupied = !!p.name;
    // Spectators may only take an EMPTY seat; seated players can swap or move.
    const canAct = !isYou && (spectating ? !occupied : true);
    return (
      <div className={`lobby-seat ${isYou ? "you" : ""}`}>
        <span className="ls-name">
          {occupied ? p.name : <em className="muted">empty</em>}
          {isYou && " (you)"}
          {occupied && seat === view.hostSeat && " 👑"}
          {occupied && !p.connected && " ⚠"}
        </span>
        {canAct && (
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
        {view.spectators.length > 0 && (
          <p className="small muted">
            👀 Watching: {view.spectators.join(", ")}
          </p>
        )}
      </div>

      <div className="card-panel">
        <h3>Series length</h3>
        <p className="muted small">First team to this many points wins the series.</p>
        <div className="row gap wrap">
          {[5, 10, 15, 21].map((n) => (
            <button
              key={n}
              className={`btn ${view.targetScore === n ? "primary" : ""}`}
              onClick={() => send({ type: "setTarget", target: n })}
            >
              {n}
            </button>
          ))}
          <span className="chip">First to {view.targetScore}</span>
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
        disabled={seated < 4 || !view.isHost}
        onClick={() => send({ type: "startGame" })}
      >
        {seated < 4
          ? `Waiting for ${4 - seated} more…`
          : view.isHost
            ? `Start · first to ${view.targetScore}`
            : "Waiting for the host to start…"}
      </button>
      {seated >= 4 && !view.isHost && (
        <p className="muted small center-text">
          👑 Only the host ({view.hostSeat !== null ? view.players[view.hostSeat].name : "?"}) can
          start the game.
        </p>
      )}
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
  const mustOpen = !view.currentBid && view.youSeat === view.callerSeat;

  const seatMeta = (seat: number) => {
    const crown = seat === view.callerSeat ? "👑 " : "";
    const a = view.auctionActions[seat];
    if (a === "pass") return <span className="bid-pass">{crown}Passed</span>;
    if (a) return (
      <span className={`bid-made suit-${a.suit}`}>
        {crown}
        {a.count} {SUIT_LABEL[a.suit]}
      </span>
    );
    if (seat === view.auctionTurnSeat) return <span className="bid-think">{crown}bidding…</span>;
    return <span className="muted">{crown}waiting</span>;
  };

  const center = view.currentBid ? (
    <div className="bid-center">
      <div className="bid-big">
        {view.currentBid.count}
        <span className={`suit-${view.currentBid.suit}`}> {SUIT_LABEL[view.currentBid.suit]}</span>
      </div>
      <div className="small">on {SUIT_NAME[view.currentBid.suit]}</div>
      <div className="small muted">{view.players[view.currentBid.seat].name} leads 👑</div>
    </div>
  ) : (
    <div className="bid-center small muted">no bids yet</div>
  );

  return (
    <div className="panel-stack">
      <div className="table-info">
        <span className="chip">Round {view.round}</span>
        <span className="chip">Bidding — one call each</span>
        {view.auctionTurnSeat !== null && view.turnMsLeft != null && (
          <TurnClock
            key={`bid-${view.round}-${view.auctionTurnSeat}`}
            msLeft={view.turnMsLeft}
            label={
              view.auctionTurnSeat === view.youSeat
                ? "your bid"
                : `${view.players[view.auctionTurnSeat].name} bidding`
            }
          />
        )}
      </div>

      <PlayerRing
        view={view}
        activeSeat={view.auctionTurnSeat}
        leadingSeat={view.currentBid?.seat ?? null}
        seatMeta={seatMeta}
        center={center}
      />

      {view.drawReveal && (
        <div className="card-panel">
          <h3 className="small">Draw for first call</h3>
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
        </div>
      )}

      <div className="card-panel">
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
              <button className="btn" disabled={mustOpen} onClick={() => send({ type: "pass" })}>
                Pass
              </button>
            </div>
            <p className="small muted">
              {mustOpen
                ? "You called highest in the draw — open the bidding."
                : "One call each. Calling 13 starts the game right away."}
            </p>
          </div>
        ) : (
          <p className="muted">
            Waiting for{" "}
            {view.auctionTurnSeat !== null ? view.players[view.auctionTurnSeat].name : "…"} to
            bid…
          </p>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
//  Play
// ---------------------------------------------------------------------------

// Anti-clockwise seating: you at the bottom, next player (you+3) to your left,
// partner (you+2) across the top, previous player (you+1) to your right.
const POS = ["pos-bottom", "pos-right", "pos-top", "pos-left"];
const relPos = (seat: number, youSeat: number | null) =>
  POS[(seat - (youSeat ?? 0) + 4) % 4];

// Shared ring-of-players table used by both the auction and the play screens.
function PlayerRing({
  view,
  activeSeat,
  seatMeta,
  center,
  leadingSeat = null,
  showDirection = false,
}: {
  view: ClientView;
  activeSeat: number | null;
  seatMeta: (seat: number) => ReactNode;
  center: ReactNode;
  leadingSeat?: number | null;
  showDirection?: boolean;
}) {
  return (
    <div className="table-felt">
      {showDirection && (
        <div className="ring-dir" aria-hidden title="Play goes anti-clockwise">
          ↺
        </div>
      )}
      {view.players.map((p) => (
        <div
          key={p.seat}
          className={`nameplate ${relPos(p.seat, view.youSeat)} team-t${teamOfSeat(p.seat)} ${
            activeSeat === p.seat ? "active" : ""
          } ${leadingSeat === p.seat ? "leading" : ""}`}
        >
          <div className="np-name">
            {p.name || <em className="muted">empty</em>}
            {p.seat === view.youSeat && " (you)"}
            {p.name && !p.connected && " ⚠"}
          </div>
          <div className="np-meta">{seatMeta(p.seat)}</div>
        </div>
      ))}
      <div className="table-center">{center}</div>
    </div>
  );
}

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

  // ---- Pre-moves: queue a card while it's not your turn; it auto-plays the
  // instant your turn arrives (if still legal), so you never have to wait.
  const [premove, setPremove] = useState<Card | null>(null);
  useEffect(() => {
    if (!yourTurn || !premove) return;
    if (view.hand.some((c) => cardEq(c, premove)) && isLegal(premove)) {
      send({ type: "playCard", card: premove });
    }
    setPremove(null); // played, or no longer legal — clear either way
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [yourTurn, premove]);
  // Drop a queued card if you no longer hold it (e.g. it was auto-played).
  useEffect(() => {
    if (premove && !view.hand.some((c) => cardEq(c, premove))) setPremove(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view.hand]);

  // Warn when your Ace would be "dead" (you played an Ace last trick too).
  const youAcedLast =
    view.lastTrick?.plays.find((p) => p.seat === view.youSeat)?.card.rank === 14;

  // Keep the finished trick on the table until the next card is played, so the
  // winning card is visible instead of vanishing the instant the 4th card lands.
  const showingLast = view.currentTrick.length === 0 && !!view.lastTrick;
  const shown = view.currentTrick.length > 0 ? view.currentTrick : view.lastTrick?.plays ?? [];
  const winnerSeat = showingLast ? view.lastTrick!.winnerSeat : null;
  // Crown = who starts the next trick: the last trick's winner during the pause,
  // otherwise whoever is leading the current trick.
  const crownSeat = winnerSeat ?? view.leadSeat;

  const seatMeta = (seat: number) => (
    <>
      Team {teamOfSeat(seat) + 1} · {view.players[seat].handCount}
      {seat === crownSeat && " 👑"}
    </>
  );

  const center = (
    <>
      {view.players.map((p) => {
        const play = shown.find((t) => t.seat === p.seat);
        return (
          <div
            key={p.seat}
            className={`center-slot ${relPos(p.seat, view.youSeat)} ${
              winnerSeat === p.seat ? "won" : ""
            }`}
          >
            {play ? <PlayingCard card={play.card} /> : <div className="card-ghost sm" />}
          </div>
        );
      })}
    </>
  );

  return (
    <div className="panel-stack">
      <div className="table-info">
        <span className="chip">Trick {view.trickNumber}/13</span>
        {isWasted(view.trickNumber) && <span className="chip warn">Wasted round</span>}
        {view.trickNumber === 4 && (
          <span className="chip warn">Earliest win lands on trick 5</span>
        )}
        {view.trickNumber === 12 && <span className="chip warn">Can’t clinch on 12</span>}
        {view.trickNumber === 13 && <span className="chip warn">Last trick — winner takes all</span>}
        {view.trump && <span className={`chip suit-${view.trump}`}>Ruung {SUIT_LABEL[view.trump]}</span>}
        {view.turnSeat !== null && view.turnMsLeft != null && (
          <TurnClock
            key={`play-${view.trickNumber}-${view.turnSeat}`}
            msLeft={view.turnMsLeft}
            label={
              view.turnSeat === view.youSeat
                ? "your turn"
                : `${view.players[view.turnSeat].name}’s turn`
            }
          />
        )}
      </div>

      <ContractBanner view={view} />

      <PlayerRing
        view={view}
        activeSeat={view.turnSeat}
        seatMeta={seatMeta}
        center={center}
        showDirection
      />

      <ScorePanel view={view} />

      <div className="hand-wrap">
        <div className="hand-title">
          {yourTurn ? (
            <strong className="turn-flag">Your turn — play a card</strong>
          ) : (
            <span>
              Your hand{" "}
              <span className="small muted">· tap a card to pre-move (auto-plays on your turn)</span>
            </span>
          )}
        </div>
        {yourTurn && youAcedLast && (
          <p className="small warn-text">
            ⚠ You played an Ace last trick — another Ace now counts as the weakest card.
          </p>
        )}
        {!yourTurn && premove && (
          <p className="small premove-note">
            Pre-move set: <strong>{cardLabel(premove)}</strong> — plays automatically on your turn.{" "}
            <button className="btn tiny" onClick={() => setPremove(null)}>
              Cancel
            </button>
          </p>
        )}
        <div className="hand">
          {view.hand.map((c) => {
            const legal = yourTurn && isLegal(c);
            const isPre = !!premove && cardEq(premove, c);
            return (
              <button
                key={`${c.suit}${c.rank}`}
                className={`playing-card big ${suitColor(c.suit)} ${legal ? "playable" : ""} ${
                  yourTurn && !legal ? "dimmed" : ""
                } ${isPre ? "premoved" : ""}`}
                disabled={yourTurn && !legal}
                onClick={() =>
                  yourTurn
                    ? send({ type: "playCard", card: c })
                    : setPremove((prev) => (prev && cardEq(prev, c) ? null : c))
                }
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
        <span>Won tricks</span>
        <strong>
          Us {s.credited[youTeam(view)]} · Them {s.credited[oppTeam(view)]}
        </strong>
      </div>
      <div className="score-row small muted">
        <span>On the board (unclaimed)</span>
        <span>{view.trickResults.length - s.claimed}</span>
      </div>
      <div className="score-row small muted">
        <span>
          Senior:{" "}
          {s.seniorSeat === null
            ? "—"
            : `${view.players[s.seniorSeat].name}${
                s.seniorSeat === view.youSeat ? " (you)" : ""
              } — ${s.streakLen} in a row`}
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
  const banner =
    r.kind === "court"
      ? `COURT! +${r.points} points`
      : r.kind === "goon-court"
        ? `GOON COURT! +${r.points} points`
        : `+${r.points} point`;
  return (
    <div className="panel-stack">
      <div className={`card-panel result ${weWon ? "win" : "lose"}`}>
        <h2>{weWon ? "Your team won the round 🎉" : "Other team won the round"}</h2>
        <div className={`round-banner kind-${r.kind}`}>{banner}</div>
        <p>
          Contract was <strong>{r.contract}</strong>, called by{" "}
          <strong>Team {r.contractTeam + 1}</strong> — {r.contractMade ? "made ✅" : "failed ❌"}
          {r.sweep && " · won all 13 rounds!"}.
        </p>
        <p className="muted">
          Credited tricks — Team 1: {r.credited[0]} · Team 2: {r.credited[1]}
        </p>
        <p className="score-big">
          Series — Us {view.matchScore[youTeam(view)]} · Them {view.matchScore[oppTeam(view)]}{" "}
          <span className="muted small">(first to {view.targetScore})</span>
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
//  Series over
// ---------------------------------------------------------------------------

function GameOver({
  view,
  send,
}: {
  view: ClientView;
  send: ReturnType<typeof useGame>["send"];
}) {
  const weWon = view.seriesWinner === youTeam(view);
  const r = view.roundResult;
  return (
    <div className="panel-stack">
      <div className={`card-panel result ${weWon ? "win" : "lose"}`}>
        <h1 className="logo">{weWon ? "🏆 Your team wins!" : "Series lost"}</h1>
        <p className="score-big">
          Final — Us {view.matchScore[youTeam(view)]} · Them {view.matchScore[oppTeam(view)]}
        </p>
        <p className="muted">
          Team {(view.seriesWinner ?? 0) + 1} reached {view.targetScore} points
          {r && r.kind !== "normal" && ` with a ${r.kind === "court" ? "COURT" : "GOON COURT"}`}.
        </p>
        <p className="muted small">
          {view.callerSeat !== null && view.players[view.callerSeat].name} (winning team) calls
          first next series.
        </p>
      </div>
      <button className="btn primary big" onClick={() => send({ type: "newSeries" })}>
        New series
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
//  Goon-court elephant
// ---------------------------------------------------------------------------

function GoonElephant() {
  useEffect(() => {
    playGoon();
  }, []);
  return (
    <div className="elephant-overlay" aria-hidden>
      <div className="ele-caption">🐘 GOON COURT! 🐘</div>
      <div className="elephant">
        <span className="ele-body">🐘</span>
      </div>
    </div>
  );
}

// Celebration overlay shown to the WINNING team on a court / goon court.
const CONFETTI_COLORS = ["#e7c26b", "#2fae74", "#6cc6ff", "#ffb27a", "#e0564b", "#ffffff"];
function BigWin({ kind, points }: { kind: string; points: number }) {
  useEffect(() => {
    playFanfare();
  }, []);
  return (
    <div className="celebrate-overlay" aria-hidden>
      <div className="celebrate-text">
        🎉 {kind === "goon-court" ? "GOON COURT!" : "COURT!"} 🎉
        <div className="celebrate-sub">You won all 13 · +{points} points</div>
      </div>
      <div className="confetti">
        {Array.from({ length: 26 }).map((_, i) => (
          <span
            key={i}
            className="confetti-piece"
            style={{
              left: `${Math.random() * 100}%`,
              background: CONFETTI_COLORS[i % CONFETTI_COLORS.length],
              animationDelay: `${Math.random() * 0.6}s`,
              animationDuration: `${1.6 + Math.random() * 1.4}s`,
            }}
          />
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
//  Small pieces
// ---------------------------------------------------------------------------

// A live countdown for the player on the clock. Keyed by the turn so it remounts
// (and restarts) whenever the active seat changes; it counts down locally from
// the ms-remaining the server sent, so it stays smooth between broadcasts.
function TurnClock({ msLeft, label }: { msLeft: number; label: string }) {
  const endRef = useRef(Date.now() + msLeft);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 200);
    return () => clearInterval(id);
  }, []);
  const remaining = Math.max(0, endRef.current - now);
  const secs = Math.ceil(remaining / 1000);
  const urgent = remaining <= 4000;
  return (
    <span className={`chip turn-clock ${urgent ? "urgent" : ""}`}>
      ⏱ {secs}s · {label}
    </span>
  );
}

// Shown to everyone else while the host is away: the room is held open for a
// short grace period so a refresh or a blip doesn't end the game.
function HostGraceBar({ msLeft, hostName }: { msLeft: number; hostName: string | null }) {
  const endRef = useRef(Date.now() + msLeft);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, []);
  const secs = Math.ceil(Math.max(0, endRef.current - now) / 1000);
  return (
    <div className="host-grace-bar">
      ⏳ <strong>{hostName || "The host"}</strong> disconnected — waiting {secs}s for them to
      come back, or the room closes.
    </div>
  );
}

// Big, unambiguous banner naming who called and which suit is Ruung (trump).
function ContractBanner({ view }: { view: ClientView }) {
  if (view.contract === null || view.trump === null || view.contractSeat === null) return null;
  const seat = view.contractSeat;
  const weCalled = teamOfSeat(seat) === youTeam(view);
  return (
    <div className={`contract-banner suit-${view.trump} ${weCalled ? "ours" : "theirs"}`}>
      <span className="cb-suit">{SUIT_LABEL[view.trump]}</span>
      <span className="cb-text">
        <strong>{view.players[seat].name}</strong>
        {seat === view.youSeat ? " (you)" : ""} · {weCalled ? "your team" : "opponents"} called{" "}
        <strong>{view.contract}</strong>
        <br />
        <span className={`cb-ruung suit-${view.trump}`}>
          {SUIT_NAME[view.trump]} {SUIT_LABEL[view.trump]} is Ruung (trump)
        </span>
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
//  Chat (players + spectators)
// ---------------------------------------------------------------------------

function Chat({
  view,
  send,
}: {
  view: ClientView;
  send: ReturnType<typeof useGame>["send"];
}) {
  const [text, setText] = useState("");
  const [open, setOpen] = useState(true);
  const listRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to the newest message.
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [view.chat.length, open]);

  const submit = () => {
    const t = text.trim();
    if (!t) return;
    send({ type: "chat", text: t });
    setText("");
  };

  return (
    <div className="card-panel chat">
      <button className="chat-head" onClick={() => setOpen((o) => !o)}>
        <strong>💬 Chat</strong>
        <span className="small muted">
          {view.spectators.length > 0 && `👀 ${view.spectators.length} watching · `}
          {open ? "hide" : "show"}
        </span>
      </button>

      {open && (
        <>
          <div className="chat-list" ref={listRef}>
            {view.chat.length === 0 ? (
              <p className="muted small">No messages yet — say hi 👋</p>
            ) : (
              view.chat.map((m) => (
                <div key={m.id} className="chat-msg">
                  <span
                    className={`chat-from ${
                      m.seat === null ? "spec" : `team-t${m.team}`
                    }`}
                  >
                    {m.name}
                    {m.seat === null ? " 👀" : ""}
                  </span>
                  <span className="chat-text">{m.text}</span>
                </div>
              ))
            )}
          </div>
          <div className="row gap">
            <input
              className="grow"
              value={text}
              maxLength={300}
              placeholder="Message everyone…"
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submit();
              }}
            />
            <button className="btn" onClick={submit} disabled={!text.trim()}>
              Send
            </button>
          </div>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
//  Spectator view — every hand face-up
// ---------------------------------------------------------------------------

function SpectatorHands({ view }: { view: ClientView }) {
  if (!view.allHands) return null;
  return (
    <div className="card-panel spectator-hands">
      <div className="chat-head static">
        <strong>👀 All hands</strong>
        <span className="small muted">spectator view</span>
      </div>
      <div className="spec-grid">
        {view.players.map((p) => (
          <div key={p.seat} className={`spec-seat team-t${teamOfSeat(p.seat)}`}>
            <div className="spec-name">
              {p.name || <em className="muted">empty</em>} · Team {teamOfSeat(p.seat) + 1}
              {p.seat === view.turnSeat && " ⏳"}
            </div>
            <div className="hand spec-hand">
              {view.allHands![p.seat].map((c) => (
                <div key={`${c.suit}${c.rank}`} className={`playing-card ${suitColor(c.suit)}`}>
                  <span className="pc-rank">{cardLabel(c).slice(0, -1)}</span>
                  <span className="pc-suit">{SUIT_LABEL[c.suit]}</span>
                </div>
              ))}
              {view.allHands![p.seat].length === 0 && (
                <span className="muted small">no cards</span>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

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
const isWasted = (n: number) => n === 1 || n === 2 || n === 3;

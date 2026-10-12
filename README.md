# Tempo

Chess coach that watches you play in Chess.app or on Lichess. Stockfish finds the moves. Claude explains them. Every mistake you make gets logged and turned into a drill.

## How it works

```
Chess.app ──(Accessibility API)──> tempo-watch (Swift) ──NDJSON──┐
                                                                  ├──> daemon (Fastify, 127.0.0.1:4848)
Lichess ──(Board API stream, board:play token)───────────────────┘        │
                                                                           ├── Stockfish (UCI, MultiPV 3)
                                                                           ├── Claude (coach, explanations only)
                                                                           └── SQLite (~/.tempo/tempo.db)
                                                                           │
                                                      web panel (Next.js, localhost:3100) <── WebSocket
                                                      tempo-overlay (Swift) ── floats /overlay over the game window
```

- **Overlay.** A small coach panel floats over the game window while it's in front. In Chess.app the hint square and arrow are drawn on the real board.
- **Live mode.** Eval bar, last-move grade, tiered hints (nudge → piece → move → why). Hints are on demand. Nothing is shown unless you ask.
- **Review.** When a game ends, every position is analyzed. Inaccuracies, mistakes, and blunders are graded by win-probability drop (same thresholds Lichess uses). Claude explains the worst ones and names the motif.
- **Patterns.** Mistakes are tagged by motif and phase, so the Stats tab shows what you keep getting wrong.
- **Drills.** Your own mistake positions come back as puzzles. Find the better move.

## Fair play

Live hints run only against a computer: Lichess AI opponents (Stockfish levels 1-8) and Chess.app games. Against a human on Lichess, Tempo goes silent until the game ends, then reviews it. Using an engine against people is cheating and gets accounts closed.

In Chess.app, Tempo reads the players from the window title (`Game 1 | You - Computer`). Hints run only when exactly one side is `Computer`, so Game Center and two-player games stay quiet. This relies on the English title. If your Chess.app is in another language, turn Live hints off yourself for Game Center games.

## Setup

Requires macOS (for Chess.app), Node 22.13+, Xcode command line tools. Bootstrap installs Stockfish with Homebrew.

```bash
git clone git@github.com:wpf002/tempo.git
cd tempo
./scripts/bootstrap.sh
```

Then fill in `.env`:

| Var | What |
|---|---|
| `ANTHROPIC_API_KEY` | Claude API key for the coach |
| `LICHESS_TOKEN` | Personal token, `board:play` scope only. [Create one](https://lichess.org/account/oauth/token/create?scopes[]=board:play&description=Tempo) |
| `STOCKFISH_PATH` | Set by bootstrap from `brew install stockfish` |
| `TEMPO_SOURCES` | `lichess`, `chessapp`, or both |

Run:

```bash
pnpm dev
```

Open http://localhost:3100 and put it next to your board.

### Chess.app permission

The reader uses the Accessibility API. The first run prompts for permission. Grant it to the terminal that runs `pnpm dev` (System Settings → Privacy & Security → Accessibility).

Tempo reads the position from the board itself (Chess.app exposes every square) and works out each move from how the position changed. Start a new game and it follows from move one.

If you start Tempo in the middle of a game, it picks the game up from the current position. Moves played before that aren't in the review unless Chess.app's Game Log window (Moves menu) is open, which gives Tempo the full move list.

`pnpm watch:dump` prints Chess.app's accessibility tree if the reader ever needs debugging.

### Overlay

`pnpm dev` starts `tempo-overlay` along with the daemon. It shows only while the game window is frontmost:

| Game | What you get |
|---|---|
| Chess.app | Coach panel docked beside the window. Hint square and arrow drawn on the real board, at any view angle. |
| Lichess in a browser | Coach panel docked beside the browser window. The hint is shown on a small copy of the board, because a browser doesn't expose where Lichess draws its board. |

Drag the panel by its top edge to move it. Set `TEMPO_OVERLAY=0` in `.env` to turn it off. It needs the same Accessibility permission as the reader.

## Status

| Piece | State |
|---|---|
| Core (notation, engine, grading, hints, review, drills, store) | Tested, including Stockfish integration |
| Daemon (hub, REST, WebSocket, origin/host checks) | End-to-end tested with Stockfish and a stubbed coach |
| Web panel | Built and checked in a browser against the daemon: Live, Review, Stats, Drills, light and dark, narrow width |
| Lichess source | Written against the official API spec; needs a first run with a real token |
| `tempo-watch` (Swift) | Built and run against Chess.app. Reads the board position and players |
| Chess.app move tracking | Board-following is unit tested and was run against live Chess.app games, from the starting position and joined mid-game. Not yet run through a full game |
| `tempo-overlay`, Chess.app | Run against Chess.app at one window size: panel placement and hint arrow confirmed on screen. Chess.app reports square positions upside down, so the overlay flips them |
| `tempo-overlay`, Lichess | Written. Not yet run against a Lichess window |

## Repo layout

```
apps/daemon        Fastify daemon: sources, live pipeline, review, REST + WS
apps/web           Next.js panel: Live, Review, Stats, Drills
packages/core      Chess logic, UCI engine, grading, hints, Claude coach, SQLite store
native/tempo-watch Swift package: tempo-watch (reads Chess.app through Accessibility) and tempo-overlay (the on-screen overlay)
scripts            bootstrap.sh
```

## Security

- Daemon binds to `127.0.0.1` only. REST and WebSocket reject any `Origin` other than the panel and any `Host` other than localhost, which blocks other websites and DNS rebinding.
- API keys live in `.env` (mode 600) and stay in the daemon. The browser never sees them.
- Lichess token is `board:play` scope only. Tempo never sends moves, only reads.
- `tempo-watch` and `tempo-overlay` are spawned with fixed paths and argument lists, no shell. Both only read from other apps. The overlay's web view refuses to load anything but the local panel.
- All inbound payloads are validated with zod. FENs and moves are validated by chess.js before they reach Stockfish.

## Commands

```bash
pnpm dev          # daemon + panel
pnpm test         # core tests
pnpm typecheck
pnpm watch:build  # rebuild the Swift reader and overlay
pnpm watch:dump   # print Chess.app's accessibility tree
pnpm overlay      # run the overlay on its own (pnpm dev already starts it)
```

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
```

- **Live mode.** Eval bar, last-move grade, tiered hints (nudge → piece → move → why). Hints are on demand. Nothing is shown unless you ask.
- **Review.** When a game ends, every position is analyzed. Inaccuracies, mistakes, and blunders are graded by win-probability drop (same thresholds Lichess uses). Claude explains the worst ones and names the motif.
- **Patterns.** Mistakes are tagged by motif and phase, so the Stats tab shows what you keep getting wrong.
- **Drills.** Your own mistake positions come back as puzzles. Find the better move.

## Fair play

Live hints run only against a computer: Lichess AI opponents (Stockfish levels 1-8) and Chess.app games. Against a human on Lichess, Tempo goes silent until the game ends, then reviews it. Using an engine against people is cheating and gets accounts closed.

Chess.app can't tell Tempo whether you're on Game Center, so that's on you. Don't turn on hints in Game Center games.

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

Open Chess.app's Game Log window (it's in the menu bar) so the move list is on screen. Tempo reads the moves from it.

If Tempo shows "no moves found" while a game is going, run `pnpm watch:dump` with Chess.app open and send the output. It prints Chess.app's accessibility tree so the reader can be pointed at the right element.

## Status

| Piece | State |
|---|---|
| Core (notation, engine, grading, hints, review, drills, store) | Tested, including Stockfish integration |
| Daemon (hub, REST, WebSocket, origin/host checks) | End-to-end tested with Stockfish and a stubbed coach |
| Web panel | Built and screenshot-checked against the daemon |
| Lichess source | Written against the official API spec; needs a first run with a real token |
| `tempo-watch` (Swift) | Written, not yet compiled. First build happens on your Mac via bootstrap |
| Chess.app move-list parsing | Handles SAN, coordinate, and figurine notation. Exact Chess.app layout unconfirmed until `pnpm watch:dump` runs |

## Repo layout

```
apps/daemon        Fastify daemon: sources, live pipeline, review, REST + WS
apps/web           Next.js panel: Live, Review, Stats, Drills
packages/core      Chess logic, UCI engine, grading, hints, Claude coach, SQLite store
native/tempo-watch Swift CLI that reads Chess.app through Accessibility
scripts            bootstrap.sh
```

## Security

- Daemon binds to `127.0.0.1` only. REST and WebSocket reject any `Origin` other than the panel and any `Host` other than localhost, which blocks other websites and DNS rebinding.
- API keys live in `.env` (mode 600) and stay in the daemon. The browser never sees them.
- Lichess token is `board:play` scope only. Tempo never sends moves, only reads.
- `tempo-watch` is spawned with a fixed path and argument list, no shell.
- All inbound payloads are validated with zod. FENs and moves are validated by chess.js before they reach Stockfish.

## Commands

```bash
pnpm dev          # daemon + panel
pnpm test         # core tests
pnpm typecheck
pnpm watch:dump   # print Chess.app's accessibility tree
```

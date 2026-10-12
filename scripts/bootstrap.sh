#!/usr/bin/env bash
# Tempo bootstrap. Idempotent: safe to re-run.
# Sets up prerequisites, dependencies, env, the Chess.app reader, and the local data dir.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

say()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!!\033[0m  %s\n' "$*"; }
die()  { printf '\033[1;31mxx\033[0m  %s\n' "$*" >&2; exit 1; }

[[ "$(uname -s)" == "Darwin" ]] || warn "Not macOS. Lichess source works anywhere; the Chess.app reader needs a Mac."

# 1. Prerequisites
say "Checking prerequisites"
# Node 22.13+ for the built-in node:sqlite module (no native build step).
command -v node >/dev/null || die "Node 22.13+ required (brew install node@22)"
node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=13)?0:1)' \
  || die "Node 22.13+ required, found $(node -v)"

if ! command -v pnpm >/dev/null; then
  say "Enabling pnpm via corepack"
  corepack enable && corepack prepare pnpm@10.28.0 --activate
fi

if ! command -v stockfish >/dev/null; then
  if command -v brew >/dev/null; then
    say "Installing Stockfish"
    brew install stockfish
  else
    die "Install Stockfish (brew install stockfish) and set STOCKFISH_PATH in .env"
  fi
fi

# 2. Folder structure (already in the repo; this guards partial clones)
say "Ensuring folder structure"
mkdir -p apps/daemon/src/sources apps/web/app packages/core/src packages/core/test \
         native/tempo-watch/Sources/tempo-watch scripts

# 3. Env
if [[ ! -f .env ]]; then
  say "Creating .env from .env.example"
  cp .env.example .env
  SF="$(command -v stockfish || true)"
  [[ -n "$SF" ]] && sed -i '' "s|^STOCKFISH_PATH=.*|STOCKFISH_PATH=$SF|" .env 2>/dev/null || true
  CORES="$(sysctl -n hw.perflevel0.physicalcpu 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 4)"
  sed -i '' "s|^STOCKFISH_THREADS=.*|STOCKFISH_THREADS=$CORES|" .env 2>/dev/null || true
  chmod 600 .env
  warn "Fill in ANTHROPIC_API_KEY and LICHESS_TOKEN in .env"
fi
# Daemon gets the full .env. The web panel only gets the daemon URL: it never sees API keys.
ln -sf ../../.env apps/daemon/.env
grep '^NEXT_PUBLIC_' .env > apps/web/.env.local || true

# 4. Dependencies
say "Installing JS dependencies"
pnpm install

# 5. Chess.app reader
if [[ "$(uname -s)" == "Darwin" ]]; then
  command -v swift >/dev/null || die "Swift toolchain missing. Run: xcode-select --install"
  say "Building tempo-watch and tempo-overlay (Chess.app reader and on-screen overlay)"
  swift build -c release --package-path native/tempo-watch
  warn "First run: macOS will ask to grant Accessibility to your terminal. System Settings > Privacy & Security > Accessibility."
fi

# 6. Local data dir
mkdir -p "$HOME/.tempo"
chmod 700 "$HOME/.tempo"

# 7. Build + test
say "Building and testing"
pnpm build
pnpm test

say "Done. Start with: pnpm dev   (panel at http://localhost:3100)"

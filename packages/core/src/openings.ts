/**
 * Common openings by move order (SAN), longest match wins. Covers the openings club players meet most;
 * anything else returns null and the coach names it from the moves if it can.
 */
const OPENINGS: [string, string][] = [
  ["e4 e5 Nf3 Nc6 Bc4", "Italian Game"],
  ["e4 e5 Nf3 Nc6 Bb5", "Ruy Lopez"],
  ["e4 e5 Nf3 Nc6 d4", "Scotch Game"],
  ["e4 e5 Nf3 Nf6", "Petrov's Defense"],
  ["e4 e5 Nc3", "Vienna Game"],
  ["e4 e5 f4", "King's Gambit"],
  ["e4 e5 Nf3", "King's Knight Opening"],
  ["e4 e5", "Open Game"],
  ["e4 c5", "Sicilian Defense"],
  ["e4 c6", "Caro-Kann Defense"],
  ["e4 e6", "French Defense"],
  ["e4 d5", "Scandinavian Defense"],
  ["e4 Nf6", "Alekhine's Defense"],
  ["e4 d6", "Pirc Defense"],
  ["e4 g6", "Modern Defense"],
  ["e4", "King's Pawn Opening"],
  ["d4 d5 c4 c6", "Slav Defense"],
  ["d4 d5 c4 Nc6", "Chigorin Defense"],
  ["d4 d5 c4", "Queen's Gambit"],
  ["d4 d5 Bf4", "London System"],
  ["d4 d5 Nf3 Nf6 Bf4", "London System"],
  ["d4 Nf6 Bf4", "London System"],
  ["d4 Nf6 Nf3 g6 Bf4", "London System"],
  ["d4 Nf6 Bg5", "Trompowsky Attack"],
  ["d4 Nf6 c4 c5 d5 b5", "Benko Gambit"],
  ["d4 Nf6 c4 c5", "Benoni Defense"],
  ["d4 Nf6 c4 g6 Nc3 d5", "Grünfeld Defense"],
  ["d4 Nf6 c4 g6", "King's Indian Defense"],
  ["d4 Nf6 c4 e6 Nc3 Bb4", "Nimzo-Indian Defense"],
  ["d4 Nf6 c4 e6 Nf3 Bb4+", "Bogo-Indian Defense"],
  ["d4 Nf6 c4 e6 g3", "Catalan Opening"],
  ["d4 f5", "Dutch Defense"],
  ["d4 d5", "Queen's Pawn Game"],
  ["d4", "Queen's Pawn Opening"],
  ["Nf3 d5 g3", "King's Indian Attack"],
  ["Nf3 d5 c4", "Réti Opening"],
  ["Nf3", "Réti Opening"],
  ["c4", "English Opening"],
  ["b3", "Nimzowitsch-Larsen Attack"],
  ["f4", "Bird's Opening"],
  ["g3", "King's Fianchetto Opening"],
  ["g4", "Grob Opening"],
];

export function openingName(sans: string[]): string | null {
  let best: { len: number; name: string } | null = null;
  for (const [line, name] of OPENINGS) {
    const moves = line.split(" ");
    if (moves.length > sans.length || (best && moves.length <= best.len)) continue;
    if (moves.every((m, i) => sans[i] === m)) best = { len: moves.length, name };
  }
  return best?.name ?? null;
}

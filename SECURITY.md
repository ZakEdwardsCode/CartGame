# Security

Coast 2 Coast Karting is a static web game (GitHub Pages) plus an optional
Node server for public matchmaking. There are no accounts, passwords, payments
or personal data, and nothing secret lives in this repository.

## What's protected

- **Untrusted input from other players.** Names, colours, kart state and race
  data from other devices are validated and length-limited before use; names
  are escaped before they reach the page; only `#rrggbb` colours are accepted.
- **Content Security Policy** on the page: scripts only from this site and the
  pinned three.js/PeerJS builds on jsDelivr; no plugins, no form posts.
- **Server (`server.js`)**: serves only the game's own files (no path
  traversal, no dotfiles), caps WebSocket message size and rate, limits
  connections per address, rejects impossible lap times, and sends
  `nosniff` / frame / referrer / permissions headers.
- **Parties** use random 4-letter codes; a party holds at most 16 drivers.

## Known limits

- In **parties** (no server) each device reports its own laps, so a modified
  copy of the game could fake a result. That's fine for racing friends; it is
  not a trusted leaderboard.
- Time-trial bests are stored only in your own browser.

## Reporting a problem

Please open a private report via the repository's **Security → Report a
vulnerability** tab (or an issue for anything not sensitive). Include steps to
reproduce. Thanks!

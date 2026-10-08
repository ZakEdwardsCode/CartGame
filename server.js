// ============================================================================
// Coast 2 Coast Karting — game server. Node built-ins only, no npm install.
//
//   node server.js [port]          (default: $PORT or 3001)
//
// Serves the game over http and runs the online race server on /ws, so one
// deployment (Render, Fly.io, Railway, a VPS...) gives you the whole game
// with multiplayer. See README → "Publishing".
// ============================================================================

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { attachWebSocket } from "./server/ws.js";
import { RaceServer } from "./server/race.js";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.argv[2]) || Number(process.env.PORT) || 3001;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".glb": "model/gltf-binary",
  ".ogg": "audio/ogg",
  ".mp3": "audio/mpeg",
};
// only these top-level entries are public
const PUBLIC = new Set(["index.html", "style.css", "config.js", "track-data.js", "manifest.webmanifest", "src", "assets", "icon.svg"]);

const server = http.createServer((req, res) => {
  let reqPath;
  try { reqPath = decodeURIComponent((req.url || "/").split("?")[0]); }
  catch { res.writeHead(400); res.end(); return; }
  if (reqPath === "/") reqPath = "/index.html";

  if (reqPath === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, ...race.stats() }));
    return;
  }

  const rel = path.normalize(reqPath).replace(/^([/\\])+/, "");
  const top = rel.split(/[/\\]/)[0];
  const filePath = path.join(ROOT, rel);
  if (!PUBLIC.has(top) || !filePath.startsWith(ROOT + path.sep) || rel.split(/[/\\]/).some(s => s.startsWith("."))) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("404 Not Found");
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("404 Not Found");
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      "Content-Type": MIME[ext] || "application/octet-stream",
      "Cache-Control": ext === ".html" ? "no-cache" : "public, max-age=300",
    });
    res.end(data);
  });
});

const race = new RaceServer({ log: (...a) => console.log(new Date().toISOString().slice(11, 19), ...a) });
const sockets = new Set();
attachWebSocket(server, "/ws", ws => {
  sockets.add(ws);
  ws.on("close", () => sockets.delete(ws));
  race.connect(ws);
});

// keep idle connections alive through proxies; drop dead ones
setInterval(() => {
  const t = Date.now();
  for (const ws of sockets) {
    if (t - ws.lastSeen > 45000) ws.close(1001);
    else ws.ping();
  }
}, 15000).unref();

server.listen(PORT, () => {
  console.log(`Coast 2 Coast Karting — http://localhost:${PORT}  (multiplayer on ws://localhost:${PORT}/ws)`);
});

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
const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-Frame-Options": "SAMEORIGIN",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), accelerometer=(self), gyroscope=(self)",
};
const MAX_SOCKETS = 2000, MAX_PER_IP = 12;
// only these top-level entries are public
const PUBLIC = new Set(["index.html", "style.css", "config.js", "track-data.js", "manifest.webmanifest", "src", "assets", "icon.svg"]);

const server = http.createServer((req, res) => {
  let reqPath;
  try { reqPath = decodeURIComponent((req.url || "/").split("?")[0]); }
  catch { res.writeHead(400); res.end(); return; }
  if (reqPath === "/") reqPath = "/index.html";

  if (reqPath === "/health") {
    res.writeHead(200, { "Content-Type": "application/json", ...SECURITY_HEADERS });
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
      ...SECURITY_HEADERS,
    });
    res.end(data);
  });
});

const race = new RaceServer({ log: (...a) => console.log(new Date().toISOString().slice(11, 19), ...a) });
const sockets = new Set();
const perIp = new Map();
attachWebSocket(server, "/ws", ws => {
  // behind a proxy (Render, Fly) the client address is the first X-Forwarded-For hop
  const ip = String(ws.req.headers["x-forwarded-for"] || ws.req.socket.remoteAddress || "").split(",")[0].trim();
  const n = perIp.get(ip) || 0;
  if (sockets.size >= MAX_SOCKETS || n >= MAX_PER_IP) { ws.close(1013); return; }
  perIp.set(ip, n + 1);
  sockets.add(ws);
  ws.on("close", () => {
    sockets.delete(ws);
    const left = (perIp.get(ip) || 1) - 1;
    if (left <= 0) perIp.delete(ip); else perIp.set(ip, left);
  });
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

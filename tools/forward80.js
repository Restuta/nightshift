#!/usr/bin/env node
// Tiny TCP forwarder: listen on a privileged port (:80, via the LaunchDaemon
// installed by tools/install-host.js) and shuttle every connection to the
// nightshift board on loopback. Zero deps.
//
// Why a forwarder and not "run the board on :80": the board WRITES logs (inbox
// cards via POST /event). Running it as root would make those files root-owned
// and break the user-level hooks that append to the same logs. This process
// only moves bytes — it never touches the filesystem — so the board stays
// unprivileged and keeps owning its writes.

const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');

const LISTEN = Number(process.env.NS_FORWARD_PORT || 80);
// Runs as root under launchd, so os.homedir() is /var/root — the installer
// passes the real user's board.json path in NS_BOARD_JSON.
const BOARD_JSON = process.env.NS_BOARD_JSON || path.join(os.homedir(), '.nightshift', 'board.json');

// The board's port can change between runs; read it fresh per connection so the
// forwarder always follows the live board (fallback to the default).
function targetPort() {
  try { return Number(JSON.parse(fs.readFileSync(BOARD_JSON, 'utf8')).port) || 4173; }
  catch { return 4173; }
}

const server = net.createServer(client => {
  const upstream = net.connect(targetPort(), '127.0.0.1');
  // If the board isn't up yet, close the client cleanly instead of crashing.
  upstream.on('error', () => { client.destroy(); });
  client.on('error', () => { upstream.destroy(); });
  client.pipe(upstream);
  upstream.pipe(client);
});

server.on('error', e => { console.error('forward80:', e.message); process.exit(1); });
// Loopback only — nightshift.local resolves to 127.0.0.1, and we don't want the
// board reachable from the network just because :80 is now bound.
server.listen(LISTEN, '127.0.0.1', () => console.log(`nightshift forward 127.0.0.1:${LISTEN} -> board (${BOARD_JSON})`));

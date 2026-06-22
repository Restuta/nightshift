#!/usr/bin/env node
// Back-compat shim. The Claude installer (tools/install-global.js) registers
// THIS path in ~/.claude/settings.json, so it must keep working — but the hook
// logic is now shared with Codex and lives in agent-hook.js. Requiring it runs
// it (it reads stdin and records on load), so existing installs need no change.
require('./agent-hook.js');

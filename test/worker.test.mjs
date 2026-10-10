import assert from "node:assert/strict";
import fs from "node:fs";

const source = fs.readFileSync(new URL("../src/index.js", import.meta.url), "utf8");

assert.match(source, /new WebSocketPair\(\)/);
assert.match(source, /new WebSocket\(upstreamURL\)/);
assert.match(source, /origin unavailable/);
assert.match(source, /ORIGIN_SCHEME/);
assert.doesNotMatch(source, /originSocket\.accept/);
assert.match(source, /binaryType = "arraybuffer"/);
assert.match(source, /normalizeOriginHost/);
assert.match(source, /isValidIPv6/);
assert.match(source, /websocket upgrade required/);
assert.match(source, /PATH_TOKEN/);
assert.match(source, /REQUIRE_PATH_TOKEN/);
assert.match(source, /MAX_CONNECTIONS/);
assert.match(source, /upstream timeout/);
assert.doesNotMatch(source, /fetcher\.connect/);

console.log("worker source checks passed");

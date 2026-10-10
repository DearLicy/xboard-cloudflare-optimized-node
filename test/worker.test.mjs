import assert from "node:assert/strict";
import fs from "node:fs";

const source = fs.readFileSync(new URL("../src/index.js", import.meta.url), "utf8");

assert.match(source, /new WebSocketPair\(\)/);
assert.match(source, /fetch\(upstreamURL/);
assert.match(source, /origin websocket upgrade failed/);
assert.match(source, /websocket upgrade required/);
assert.match(source, /Cf-Connecting-Ip/);
assert.doesNotMatch(source, /fetcher\.connect/);

console.log("worker source checks passed");

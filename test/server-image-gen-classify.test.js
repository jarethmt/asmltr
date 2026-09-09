"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

test("server records image-gen-classify usage", () => {
  const server = fs.readFileSync(path.join(__dirname, "..", "core", "src", "server.js"), "utf8");
  assert.match(server, /image-gen-classify/);
});

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { Logger } from "../node_modules/homebridge/dist/logger.js";
import { withPluginPrefix } from "../dist/logger.js";

let lines;
let originalLog;
let originalError;

beforeEach(() => {
  lines = [];
  originalLog = console.log;
  originalError = console.error;
  console.log = (line) => lines.push(line);
  console.error = (line) => lines.push(line);
  Logger.setTimestampEnabled(false);
});

afterEach(() => {
  console.log = originalLog;
  console.error = originalError;
  Logger.setTimestampEnabled(true);
});

describe("withPluginPrefix", () => {
  it("tags messages with the package name Homebridge uses for its own warnings", () => {
    const log = withPluginPrefix(Logger.withPrefix("GoLutron"));

    log("started");
    log.info("info");
    log.warn("warn");
    log.error("error");

    assert.equal(log.prefix, "homebridge-go-lutron");
    assert.equal(lines.length, 4);
    for (const line of lines) {
      assert.match(line, /\[homebridge-go-lutron\]/);
      assert.doesNotMatch(line, /\[GoLutron\]/);
    }
  });

  it("leaves the Homebridge logger it wraps unchanged", () => {
    const original = Logger.withPrefix("GoLutron");
    withPluginPrefix(original);

    original.info("hello");

    assert.equal(original.prefix, "GoLutron");
    assert.match(lines[0], /\[GoLutron\]/);
  });
});

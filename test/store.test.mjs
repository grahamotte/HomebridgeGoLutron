import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { CredentialStore, isBridgeId } from "../dist/store.js";
import { BRIDGE_HOST, BRIDGE_ID, CREDENTIALS } from "./fakes.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "go-lutron-store-"));
after(() => fs.rmSync(root, { recursive: true, force: true }));

describe("CredentialStore", () => {
  it("returns nothing before anything is paired", () => {
    assert.deepEqual(new CredentialStore(path.join(root, "missing")).list(), []);
  });

  it("saves private credentials and reads them back", () => {
    const directory = path.join(root, "saved");
    const store = new CredentialStore(directory);
    store.save({ id: BRIDGE_ID, host: BRIDGE_HOST, ...CREDENTIALS, extra: "dropped" });
    store.save({ id: "0A", host: "192.168.1.5", ...CREDENTIALS });

    assert.deepEqual(store.list(), [
      { id: "067D50DC", host: BRIDGE_HOST, ...CREDENTIALS },
      { id: "0A", host: "192.168.1.5", ...CREDENTIALS }
    ]);
    assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(directory, "067D50DC.json")).mode & 0o777, 0o600);
    assert.deepEqual(fs.readdirSync(directory).sort(), ["067D50DC.json", "0A.json"]);

    store.save({ id: BRIDGE_ID, host: "192.168.1.9", ...CREDENTIALS });
    assert.equal(store.list()[0].host, "192.168.1.9");
  });

  it("ignores unreadable, mismatched, and incomplete files", () => {
    const directory = path.join(root, "junk");
    fs.mkdirSync(directory);
    fs.writeFileSync(path.join(directory, "AA.json"), "{");
    fs.writeFileSync(path.join(directory, "BB.json"), JSON.stringify({ id: "CC", host: "h", ...CREDENTIALS }));
    fs.writeFileSync(path.join(directory, "DD.json"), JSON.stringify({ id: "DD", host: "h", ca: "x" }));
    fs.writeFileSync(path.join(directory, "notes.txt"), "hello");
    fs.writeFileSync(path.join(directory, "EE.json"), JSON.stringify({ id: "EE", host: "h", ...CREDENTIALS }));

    assert.deepEqual(new CredentialStore(directory).list().map((record) => record.id), ["EE"]);
  });

  it("refuses ids that are not bridge serials", () => {
    const store = new CredentialStore(path.join(root, "bad"));
    assert.throws(() => store.save({ id: "../x", host: BRIDGE_HOST, ...CREDENTIALS }), /invalid bridge id/u);
    assert.equal(isBridgeId("067D50DC"), true);
    assert.equal(isBridgeId("067d50dc"), false);
    assert.equal(isBridgeId(""), false);
  });
});

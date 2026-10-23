import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";
import { discoverBridges, parseService } from "../dist/discovery.js";

class FakeBrowser extends EventEmitter {
  constructor() {
    super();
    this.updates = 0;
    this.stopped = false;
  }

  update() {
    this.updates += 1;
  }

  stop() {
    this.stopped = true;
  }
}

describe("parseService", () => {
  it("reads the bridge id from the SRV host and prefers IPv4", () => {
    assert.deepEqual(parseService({ host: "Lutron-067d50dc.local", addresses: ["fe80::1", "192.168.1.192"] }), { id: "067D50DC", host: "192.168.1.192" });
    assert.deepEqual(parseService({ host: "lutron-0a.local.", addresses: [], referer: { address: "10.0.0.2" } }), { id: "0A", host: "10.0.0.2" });
    assert.equal(parseService({ host: "Lutron-067d50dc.local", addresses: ["fe80::1"] }), undefined);
    assert.equal(parseService({ host: "printer.local", addresses: ["192.168.1.9"] }), undefined);
    assert.equal(parseService({ host: undefined, addresses: undefined }), undefined);
  });
});

describe("discoverBridges", () => {
  it("browses _lutron._tcp and returns each bridge once", async () => {
    const browser = new FakeBrowser();
    const calls = [];
    let destroyed = false;
    const client = {
      find: (options) => {
        calls.push(options);
        setImmediate(() => {
          browser.emit("up", { host: "Lutron-067d50dc.local", addresses: ["192.168.1.192"] });
          browser.emit("up", { host: "Lutron-067d50dc.local", addresses: ["192.168.1.193"] });
          browser.emit("up", { host: "printer.local", addresses: ["192.168.1.9"] });
        });
        return browser;
      },
      destroy: () => {
        destroyed = true;
      }
    };

    const bridges = await discoverBridges(20, () => client);
    assert.deepEqual(calls, [{ type: "lutron", protocol: "tcp" }]);
    assert.deepEqual(bridges, [{ id: "067D50DC", host: "192.168.1.193" }]);
    assert.equal(browser.stopped, true);
    assert.equal(destroyed, true);
  });

  it("cleans up when browsing fails", async () => {
    let destroyed = false;
    const client = {
      find: () => {
        throw new Error("socket in use");
      },
      destroy: () => {
        destroyed = true;
      }
    };

    await assert.rejects(discoverBridges(20, () => client), { message: "socket in use" });
    assert.equal(destroyed, true);
  });
});

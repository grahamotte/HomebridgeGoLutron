import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { describe as describeError, LeapClient, LeapError, statusCode } from "../dist/leap.js";
import { BRIDGE_HOST, CREDENTIALS, FakeBridge, settle, until } from "./fakes.mjs";

function createClient(bridge = new FakeBridge(), options = {}) {
  const unsolicited = [];
  const closes = [];
  const client = new LeapClient({
    host: BRIDGE_HOST,
    port: 8081,
    credentials: CREDENTIALS,
    verify: true,
    timeoutMs: 500,
    connect: bridge.connect,
    onUnsolicited: (message) => unsolicited.push(message),
    onClose: (error) => closes.push(error),
    ...options
  });
  return { bridge, client, closes, unsolicited };
}

describe("LeapClient", () => {
  it("connects with the paired certificates and verifies the bridge without a hostname check", async () => {
    const { bridge, client } = createClient();
    await client.open();

    const [options] = bridge.options;
    assert.equal(options.host, BRIDGE_HOST);
    assert.equal(options.port, 8081);
    assert.equal(options.ca, CREDENTIALS.ca);
    assert.equal(options.cert, CREDENTIALS.cert);
    assert.equal(options.key, CREDENTIALS.key);
    assert.equal(options.rejectUnauthorized, true);
    assert.equal(options.checkServerIdentity("bridge", {}), undefined);
    assert.equal(client.isOpen, true);
    await assert.rejects(client.open(), /already opened/u);
    client.close();
  });

  it("matches responses to requests by client tag", async () => {
    const { bridge, client } = createClient();
    await client.open();

    const [devices, ping] = await Promise.all([client.read("/device"), client.request("ReadRequest", "/server/1/status/ping")]);
    assert.equal(devices.Devices.length, 5);
    assert.deepEqual(ping.Body, { PingResponse: { LEAPVersion: 1.124 } });
    assert.notEqual(bridge.requests[0].message.Header.ClientTag, bridge.requests[1].message.Header.ClientTag);
    assert.match(bridge.sockets[0].writes[0], /\r\n$/u);
    client.close();
  });

  it("treats a response without a body as empty data instead of failing", async () => {
    const { client } = createClient();
    await client.open();

    const response = await client.request("ReadRequest", "/area/status");
    assert.equal(statusCode(response), 204);
    assert.equal(response.Body, undefined);
    assert.equal(await client.read("/area/status"), undefined);
    client.close();
  });

  it("rejects exception responses with the bridge's message and status", async () => {
    const { bridge, client } = createClient();
    bridge.failures.set("/device", "401 Unauthorized");
    await client.open();

    await assert.rejects(client.read("/nope"), (error) => {
      assert.ok(error instanceof LeapError);
      assert.equal(error.status, 400);
      assert.equal(error.message, "/nope failed: 400 BadRequest: This request is not supported");
      return true;
    });
    await assert.rejects(client.read("/device"), { status: 401, message: "/device failed: 401 Unauthorized: Nope" });
    assert.equal(client.isOpen, true);
    client.close();
  });

  it("routes subscription updates and untagged messages", async () => {
    const { bridge, client, unsolicited } = createClient();
    await client.open();
    const updates = [];

    const initial = await client.subscribe("/zone/status", (message) => updates.push(message));
    assert.equal(initial.Body.ZoneStatuses.length, 3);
    bridge.setLevel("/zone/1", 40);

    await until(() => updates.length === 1 && unsolicited.length === 1);
    assert.deepEqual(updates[0].Body.ZoneStatuses, [bridge.status("/zone/1")]);
    assert.equal(unsolicited[0].Header.Url, "/zone/1/status/level");
    client.close();
  });

  it("drops a subscription whose request failed", async () => {
    const { bridge, client, unsolicited } = createClient();
    bridge.failures.set("/zone/status", "500 InternalServerError");
    await client.open();
    const updates = [];

    await assert.rejects(client.subscribe("/zone/status", (message) => updates.push(message)), { status: 500 });
    const tag = bridge.requests[0].message.Header.ClientTag;
    bridge.sockets[0].send({ Header: { StatusCode: "200 OK", ClientTag: tag }, Body: {} });
    await until(() => unsolicited.length === 1);
    assert.deepEqual(updates, []);
    client.close();
  });

  it("reassembles split lines and skips malformed ones", async () => {
    const { bridge, client, unsolicited } = createClient();
    await client.open();
    const socket = bridge.sockets[0];

    socket.raw("not json\r\n{\"Header\":{\"Url\":\"/a\"}");
    socket.raw("}\r\n[]\r\nnull\r\n{\"Body\":1}\r\n\r\n{\"Header\":{\"Url\":\"/b\"}}\n");
    await until(() => unsolicited.length === 2);
    await settle();
    assert.deepEqual(unsolicited.map((message) => message.Header.Url), ["/a", "/b"]);
    client.close();
  });

  it("survives handlers that throw", async () => {
    const { bridge, client } = createClient(new FakeBridge(), {
      onUnsolicited: () => {
        throw new Error("handler failed");
      },
      onClose: () => {
        throw new Error("close handler failed");
      }
    });
    await client.open();
    await client.subscribe("/zone/status", () => {
      throw new Error("subscription failed");
    });

    bridge.setLevel("/zone/1", 10);
    await settle();
    assert.equal((await client.request("ReadRequest", "/server/1/status/ping")).Header.StatusCode, "200 OK");
    client.close();
    await settle();
    assert.equal(client.isOpen, false);
  });

  it("times out requests the bridge never answers", async () => {
    const { bridge, client } = createClient(new FakeBridge(), { timeoutMs: 20 });
    bridge.silent.add("/server/1/status/ping");
    await client.open();

    await assert.rejects(client.request("ReadRequest", "/server/1/status/ping"), { message: "/server/1/status/ping timed out" });
    assert.ok(await client.read("/device"));
    client.close();
  });

  it("rejects duplicate tags and requests before connecting", async () => {
    const { bridge, client } = createClient();
    await assert.rejects(client.read("/device"), { message: "not connected" });
    bridge.silent.add("/pair");
    await client.open();

    const first = client.exchange({ Header: { Url: "/pair", ClientTag: "same" } });
    await assert.rejects(client.exchange({ Header: { Url: "/pair", ClientTag: "same" } }), /already in flight/u);
    client.close();
    await assert.rejects(first, { message: "connection closed" });
  });

  it("fails in-flight requests and reports the close once", async () => {
    const { bridge, client, closes } = createClient();
    bridge.silent.add("/device");
    await client.open();

    const pending = client.read("/device");
    bridge.drop();
    await assert.rejects(pending, { message: "connection closed" });
    client.close();
    await settle();
    assert.equal(closes.length, 1);
    assert.equal(client.isOpen, false);
    await assert.rejects(client.read("/device"), { message: "not connected" });
  });

  it("reports connection failures", async () => {
    const bridge = new FakeBridge();
    bridge.refuse = 1;
    const { client, closes } = createClient(bridge);

    await assert.rejects(client.open(), { code: "ECONNREFUSED" });
    await until(() => closes.length === 1);
    assert.equal(closes[0].code, "ECONNREFUSED");
  });

  it("times out connections that never finish the handshake", async () => {
    const bridge = new FakeBridge();
    const { client, closes } = createClient(bridge, {
      timeoutMs: 10,
      connect: (options) => {
        const socket = bridge.connect(options);
        socket.emit = function (event, ...args) {
          return event === "secureConnect" ? false : Object.getPrototypeOf(this).emit.call(this, event, ...args);
        };
        return socket;
      }
    });

    await assert.rejects(client.open(), { message: `timed out connecting to ${BRIDGE_HOST}:8081` });
    await until(() => closes.length === 1);
    assert.equal(bridge.sockets[0].destroyed, true);
  });

  it("reports a socket factory that throws", async () => {
    const { client, closes } = createClient(new FakeBridge(), {
      connect: () => {
        throw new Error("bad certificate");
      }
    });

    await assert.rejects(client.open(), { message: "bad certificate" });
    assert.equal(closes[0].message, "bad certificate");
  });
});

describe("statusCode and describe", () => {
  it("parse status codes and error messages", () => {
    assert.equal(statusCode({ Header: { StatusCode: "204 NoContent" } }), 204);
    assert.equal(statusCode({ Header: {} }), undefined);
    assert.equal(describeError(new Error("boom")), "boom");
    assert.equal(describeError("plain"), "plain");
  });
});

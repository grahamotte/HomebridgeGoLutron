import assert from "node:assert/strict";
import { createPrivateKey, createPublicKey, verify } from "node:crypto";
import { describe, it } from "node:test";
import { ASSOCIATION_CA, ASSOCIATION_CERT, ASSOCIATION_KEY } from "../dist/association.js";
import { pair } from "../dist/pairing.js";
import { BRIDGE_HOST, FakeBridge, parseCsr, settle, until } from "./fakes.mjs";

describe("pair", () => {
  it("waits for the bridge button and returns signed credentials", async () => {
    const bridge = new FakeBridge();
    const pairing = pair(BRIDGE_HOST, { timeoutMs: 5000, requestTimeoutMs: 1000, connect: bridge.connect });
    await until(() => bridge.open.length === 1);
    await settle();
    assert.deepEqual(bridge.requests, []);

    bridge.pressButton();
    const credentials = await pairing;
    assert.deepEqual({ ca: credentials.ca, cert: credentials.cert }, { ca: "BRIDGE ROOT", cert: "SIGNED CERT" });

    const [options] = bridge.options;
    assert.deepEqual([options.host, options.port, options.rejectUnauthorized], [BRIDGE_HOST, 8083, false]);
    assert.deepEqual([options.ca, options.cert, options.key], [ASSOCIATION_CA, ASSOCIATION_CERT, ASSOCIATION_KEY]);

    const request = bridge.requests[0].message;
    assert.equal(request.CommuniqueType, undefined);
    assert.deepEqual(request.Header, { RequestType: "Execute", Url: "/pair", ClientTag: "get-cert" });
    assert.deepEqual({ ...request.Body.Parameters, CSR: undefined }, {
      CSR: undefined,
      DisplayName: "homebridge-go-lutron",
      DeviceUID: "000000000000",
      Role: "Admin"
    });

    const csr = parseCsr(bridge.signed);
    const publicKey = createPublicKey(createPrivateKey(credentials.key));
    assert.deepEqual(csr.spki.raw, publicKey.export({ type: "spki", format: "der" }));
    assert.equal(verify("sha256", csr.info.raw, publicKey, csr.signature), true);
    await until(() => bridge.open.length === 0);
  });

  it("gives up when nobody presses the button", async () => {
    const bridge = new FakeBridge();
    await assert.rejects(pair(BRIDGE_HOST, { timeoutMs: 30, requestTimeoutMs: 1000, connect: bridge.connect }), {
      message: "the bridge button was not pressed in time"
    });
    await until(() => bridge.open.length === 0);
    assert.deepEqual(bridge.requests, []);
  });

  it("fails when the bridge refuses to sign or drops the connection", async () => {
    const refused = new FakeBridge();
    const pairing = pair(BRIDGE_HOST, { timeoutMs: 5000, requestTimeoutMs: 1000, connect: refused.connect });
    await until(() => refused.open.length === 1);
    refused.open[0].send({ Header: { StatusCode: "200 OK" }, Body: { Status: { Permissions: ["PhysicalAccess"] } } });
    await assert.rejects(pairing, { status: 401 });

    const dropped = new FakeBridge();
    const lost = pair(BRIDGE_HOST, { timeoutMs: 5000, requestTimeoutMs: 1000, connect: dropped.connect });
    await until(() => dropped.open.length === 1);
    dropped.open[0].send({ Header: { StatusCode: "200 OK" }, Body: { Status: { Permissions: ["Public"] } } });
    dropped.drop();
    await assert.rejects(lost, { message: "connection closed" });

    const unreachable = new FakeBridge();
    unreachable.refuse = 1;
    await assert.rejects(pair(BRIDGE_HOST, { timeoutMs: 5000, requestTimeoutMs: 1000, connect: unreachable.connect }), { code: "ECONNREFUSED" });
  });

  it("rejects a signing response without certificates", async () => {
    const bridge = new FakeBridge();
    bridge.handlePairing = (socket, message) => socket.send({ Header: { StatusCode: "200 OK", ClientTag: message.Header.ClientTag }, Body: { SigningResult: {} } });
    const pairing = pair(BRIDGE_HOST, { timeoutMs: 5000, requestTimeoutMs: 1000, connect: bridge.connect });
    await until(() => bridge.open.length === 1);
    bridge.pressButton();
    await assert.rejects(pairing, { message: "the bridge did not return a signed certificate" });
  });
});

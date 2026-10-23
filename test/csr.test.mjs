import assert from "node:assert/strict";
import { generateKeyPairSync, verify } from "node:crypto";
import { describe, it } from "node:test";
import { createCsr } from "../dist/csr.js";
import { children, parseCsr } from "./fakes.mjs";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });

describe("createCsr", () => {
  it("builds a PEM certificate request signed by the private key", () => {
    const pem = createCsr(privateKey, publicKey, "homebridge-go-lutron");
    assert.match(pem, /^-----BEGIN CERTIFICATE REQUEST-----\n([A-Za-z0-9+/=]{1,64}\n)+-----END CERTIFICATE REQUEST-----\n$/u);

    const csr = parseCsr(pem);
    assert.equal(csr.commonName, "homebridge-go-lutron");
    assert.deepEqual([...csr.version.content], [0]);
    assert.equal(csr.attributes.tag, 0xa0);
    assert.equal(csr.attributes.content.length, 0);
    assert.deepEqual(csr.spki.raw, publicKey.export({ type: "spki", format: "der" }));
    assert.deepEqual(children(csr.algorithm)[0].raw, Buffer.from("06092a864886f70d01010b", "hex"));
    assert.equal(verify("sha256", csr.info.raw, publicKey, csr.signature), true);
  });

  it("encodes long and non-ASCII names", () => {
    const name = `Caséta ${"x".repeat(200)}`;
    const csr = parseCsr(createCsr(privateKey, publicKey, name));
    assert.equal(csr.commonName, name);
    assert.equal(verify("sha256", csr.info.raw, publicKey, csr.signature), true);
  });
});

import { sign, type KeyObject } from "node:crypto";

const COMMON_NAME = "2.5.4.3";
const SHA256_WITH_RSA = "1.2.840.113549.1.1.11";

export function createCsr(privateKey: KeyObject, publicKey: KeyObject, commonName: string): string {
  const subject = sequence(set(sequence(objectId(COMMON_NAME), tlv(0x0c, Buffer.from(commonName, "utf8")))));
  const spki = publicKey.export({ type: "spki", format: "der" });
  const info = sequence(tlv(0x02, Buffer.from([0])), subject, spki, tlv(0xa0, Buffer.alloc(0)));
  const signature = sign("sha256", info, privateKey);
  const request = sequence(
    info,
    sequence(objectId(SHA256_WITH_RSA), tlv(0x05, Buffer.alloc(0))),
    tlv(0x03, Buffer.concat([Buffer.from([0]), signature])),
  );
  const lines = request.toString("base64").match(/.{1,64}/gu) ?? [];
  return `-----BEGIN CERTIFICATE REQUEST-----\n${lines.join("\n")}\n-----END CERTIFICATE REQUEST-----\n`;
}

function sequence(...parts: Buffer[]): Buffer {
  return tlv(0x30, Buffer.concat(parts));
}

function set(...parts: Buffer[]): Buffer {
  return tlv(0x31, Buffer.concat(parts));
}

function objectId(id: string): Buffer {
  const [first, second, ...rest] = id.split(".").map(Number);
  const bytes = [first * 40 + second];
  for (const value of rest) {
    const encoded = [value & 0x7f];
    for (let remaining = value >>> 7; remaining > 0; remaining >>>= 7) {
      encoded.unshift((remaining & 0x7f) | 0x80);
    }

    bytes.push(...encoded);
  }

  return tlv(0x06, Buffer.from(bytes));
}

function tlv(tag: number, content: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), length(content.length), content]);
}

function length(value: number): Buffer {
  if (value < 0x80) {
    return Buffer.from([value]);
  }

  const bytes: number[] = [];
  for (let remaining = value; remaining > 0; remaining >>>= 8) {
    bytes.unshift(remaining & 0xff);
  }

  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

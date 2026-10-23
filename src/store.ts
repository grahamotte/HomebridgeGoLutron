import fs from "node:fs";
import path from "node:path";
import type { Credentials } from "./leap.js";

export interface BridgeRecord extends Credentials {
  readonly id: string;
  readonly host: string;
}

export class CredentialStore {
  constructor(readonly directory: string) {}

  list(): BridgeRecord[] {
    let names: string[];
    try {
      names = fs.readdirSync(this.directory);
    } catch {
      return [];
    }

    return names
      .filter((name) => /^[0-9A-F]+\.json$/u.test(name))
      .sort()
      .map((name) => this.read(path.join(this.directory, name)))
      .filter((record): record is BridgeRecord => record !== undefined);
  }

  save(record: BridgeRecord): void {
    if (!isBridgeId(record.id)) {
      throw new Error(`invalid bridge id ${record.id}`);
    }

    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const file = path.join(this.directory, `${record.id}.json`);
    const temporary = `${file}.${process.pid}.tmp`;
    const { id, host, ca, cert, key } = record;
    fs.writeFileSync(temporary, `${JSON.stringify({ id, host, ca, cert, key }, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, file);
  }

  private read(file: string): BridgeRecord | undefined {
    try {
      const record = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
      const { id, host, ca, cert, key } = record;
      if (typeof id !== "string" || !isBridgeId(id) || path.basename(file) !== `${id}.json`) {
        return undefined;
      }

      if (typeof host !== "string" || typeof ca !== "string" || typeof cert !== "string" || typeof key !== "string") {
        return undefined;
      }

      return { id, host, ca, cert, key };
    } catch {
      return undefined;
    }
  }
}

export function isBridgeId(value: string): boolean {
  return /^[0-9A-F]{1,16}$/u.test(value);
}

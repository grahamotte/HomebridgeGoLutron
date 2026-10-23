import { describe, LeapClient, LeapError, type Credentials, type LeapMessage, type SocketFactory } from "./leap.js";
import { DEFAULT_TIMING, LEAP_PORT, type BridgeTiming } from "./settings.js";
import type { BridgeRecord } from "./store.js";

export interface Shade {
  readonly serial: string;
  readonly zone: string;
  readonly name: string;
  readonly model: string;
  readonly type: string;
}

export interface BridgeLog {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
}

export interface BridgeHandlers {
  readonly shades: (shades: readonly Shade[]) => void;
  readonly level: (zone: string, level: number) => void;
  readonly online: (online: boolean) => void;
}

interface DeviceDefinition {
  readonly DeviceType?: unknown;
  readonly SerialNumber?: unknown;
  readonly ModelNumber?: unknown;
  readonly Name?: unknown;
  readonly FullyQualifiedName?: unknown;
  readonly LocalZones?: unknown;
  readonly AddressedState?: unknown;
  readonly IsThisDevice?: unknown;
}

interface ZoneStatus {
  readonly Level?: unknown;
  readonly Zone?: { readonly href?: unknown };
}

export class LutronBridge {
  private client?: LeapClient;
  private host: string;
  private stopped = true;
  private attempts = 0;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private pingTimer?: ReturnType<typeof setInterval>;
  private online = false;

  constructor(
    private readonly record: BridgeRecord,
    private readonly log: BridgeLog,
    private readonly handlers: BridgeHandlers,
    private readonly connect?: SocketFactory,
    private readonly timing: BridgeTiming = DEFAULT_TIMING,
  ) {
    this.host = record.host;
  }

  get id(): string {
    return this.record.id;
  }

  get currentHost(): string {
    return this.host;
  }

  get isOnline(): boolean {
    return this.online;
  }

  start(): void {
    if (!this.stopped) {
      return;
    }

    this.stopped = false;
    this.attempt();
  }

  stop(): void {
    this.stopped = true;
    this.clearTimers();
    const client = this.client;
    this.client = undefined;
    client?.close();
    this.setOnline(false);
  }

  setHost(host: string): void {
    if (host === this.host) {
      return;
    }

    this.log.info(`Bridge ${this.id} moved from ${this.host} to ${host}.`);
    this.host = host;
    if (!this.online && !this.stopped) {
      this.retryNow();
    }
  }

  async setLevel(zone: string, level: number): Promise<void> {
    const client = this.client;
    if (!client || !this.online) {
      throw new LeapError(`bridge ${this.id} is offline`);
    }

    await client.request("CreateRequest", `${zone}/commandprocessor`, {
      Command: { CommandType: "GoToLevel", Parameter: [{ Type: "Level", Value: clampLevel(level) }] }
    });
  }

  private attempt(): void {
    this.reconnectTimer = undefined;
    if (this.stopped) {
      return;
    }

    this.run().catch((error: unknown) => {
      this.log.warn(`Bridge ${this.id} at ${this.host}: ${describe(error)}`);
      this.client?.close();
    });
  }

  private async run(): Promise<void> {
    const client = new LeapClient({
      host: this.host,
      port: LEAP_PORT,
      credentials: this.record,
      verify: true,
      timeoutMs: this.timing.requestTimeoutMs,
      connect: this.connect,
      onUnsolicited: (message) => this.applyStatus(message),
      onClose: (error) => this.closed(client, error)
    });
    this.client = client;
    await client.open();
    const shades = parseShades(await client.read("/device"));
    const initial = await client.subscribe("/zone/status", (message) => this.applyStatus(message));
    if (this.client !== client) {
      return;
    }

    this.handlers.shades(shades);
    this.applyStatus(initial);
    this.attempts = 0;
    this.setOnline(true);
    this.log.info(`Connected to bridge ${this.id} at ${this.host} with ${shades.length} shade(s).`);
    this.pingTimer = setInterval(() => this.ping(client), this.timing.pingIntervalMs);
    this.pingTimer.unref?.();
  }

  private ping(client: LeapClient): void {
    client.request("ReadRequest", "/server/1/status/ping").catch((error: unknown) => {
      this.log.warn(`Bridge ${this.id} stopped answering: ${describe(error)}`);
      client.close();
    });
  }

  private closed(client: LeapClient, error?: Error): void {
    if (this.client !== client) {
      return;
    }

    this.client = undefined;
    this.clearTimers();
    if (this.online) {
      this.log.warn(`Lost connection to bridge ${this.id}: ${error ? error.message : "closed"}`);
    }

    this.setOnline(false);
    if (this.stopped) {
      return;
    }

    const delay = Math.min(this.timing.reconnectMaxMs, this.timing.reconnectMinMs * 2 ** this.attempts);
    this.attempts += 1;
    this.log.debug(`Reconnecting to bridge ${this.id} in ${delay} ms.`);
    this.reconnectTimer = setTimeout(() => this.attempt(), delay);
    this.reconnectTimer.unref?.();
  }

  private retryNow(): void {
    this.attempts = 0;
    if (this.client) {
      this.client.close();
      return;
    }

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.attempt();
    }
  }

  private applyStatus(message: LeapMessage): void {
    for (const status of zoneStatuses(message.Body)) {
      const zone = status.Zone?.href;
      const level = status.Level;
      if (typeof zone === "string" && typeof level === "number" && Number.isFinite(level)) {
        this.handlers.level(zone, clampLevel(level));
      }
    }
  }

  private setOnline(online: boolean): void {
    if (this.online === online) {
      return;
    }

    this.online = online;
    this.handlers.online(online);
  }

  private clearTimers(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = undefined;
    }

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
  }
}

export async function identify(host: string, credentials: Credentials, connect?: SocketFactory, timeoutMs = DEFAULT_TIMING.requestTimeoutMs): Promise<string> {
  const client = new LeapClient({ host, port: LEAP_PORT, credentials, verify: true, timeoutMs, connect });
  try {
    await client.open();
    const devices = devicesOf(await client.read("/device"));
    const serial = devices.find((device) => device.IsThisDevice === true)?.SerialNumber;
    if (typeof serial !== "number" || !Number.isSafeInteger(serial) || serial < 0) {
      throw new LeapError(`bridge at ${host} did not report its serial number`);
    }

    return serial.toString(16).toUpperCase().padStart(8, "0");
  } finally {
    client.close();
  }
}

export function parseShades(body: unknown): Shade[] {
  const shades: Shade[] = [];
  for (const device of devicesOf(body)) {
    const type = device.DeviceType;
    const zones = device.LocalZones;
    const zone = Array.isArray(zones) ? (zones[0] as { href?: unknown } | undefined)?.href : undefined;
    if (typeof type !== "string" || !isShadeType(type) || typeof zone !== "string" || device.AddressedState === "Unaddressed") {
      continue;
    }

    const serial = typeof device.SerialNumber === "number" || typeof device.SerialNumber === "string"
      ? String(device.SerialNumber)
      : zone;
    const names = Array.isArray(device.FullyQualifiedName)
      ? device.FullyQualifiedName.filter((part): part is string => typeof part === "string" && part.trim() !== "")
      : [];
    const name = names.length > 0 ? names.join(" ") : typeof device.Name === "string" && device.Name.trim() ? device.Name : "Shade";
    const model = typeof device.ModelNumber === "string" ? device.ModelNumber : type;
    shades.push({ serial, zone, name: name.trim(), model, type });
  }

  return shades;
}

export function isShadeType(type: string): boolean {
  return /Shade|Drape/u.test(type) && !/Tilt|Blind/u.test(type);
}

function devicesOf(body: unknown): DeviceDefinition[] {
  const devices = (body as { Devices?: unknown } | undefined)?.Devices;
  return Array.isArray(devices) ? devices.filter((device): device is DeviceDefinition => Boolean(device) && typeof device === "object") : [];
}

function zoneStatuses(body: unknown): ZoneStatus[] {
  const record = body as { ZoneStatus?: unknown; ZoneStatuses?: unknown } | undefined;
  const statuses = Array.isArray(record?.ZoneStatuses) ? record.ZoneStatuses : record?.ZoneStatus ? [record.ZoneStatus] : [];
  return statuses.filter((status): status is ZoneStatus => Boolean(status) && typeof status === "object");
}

function clampLevel(level: number): number {
  return Math.min(100, Math.max(0, Math.round(level)));
}

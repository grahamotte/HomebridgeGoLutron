import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GoLutronPlatform } from "../dist/platform.js";
import { CredentialStore } from "../dist/store.js";

export const BRIDGE_ID = "067D50DC";
export const BRIDGE_HOST = "192.168.1.192";
export const CREDENTIALS = { ca: "ROOT CA", cert: "CLIENT CERT", key: "CLIENT KEY" };
export const FAST_TIMING = { requestTimeoutMs: 500, pingIntervalMs: 60000, reconnectMinMs: 1, reconnectMaxMs: 8 };

export const DEVICES = [
  {
    Name: "Smart Bridge 2",
    DeviceType: "SmartBridge",
    href: "/device/1",
    SerialNumber: 108875996,
    FullyQualifiedName: ["Smart Bridge 2"],
    ModelNumber: "L-BDGPRO2-WH",
    AddressedState: "Addressed",
    IsThisDevice: true
  },
  {
    Name: "Shade 2",
    DeviceType: "TriathlonRollerShade",
    href: "/device/2",
    SerialNumber: 79430373,
    FullyQualifiedName: ["Living Room", "Shade 2"],
    ModelNumber: "QSFRJ-S2A13-XX",
    LocalZones: [{ href: "/zone/1" }],
    AddressedState: "Addressed"
  },
  {
    Name: "Shade 1",
    DeviceType: "TriathlonRollerShade",
    href: "/device/4",
    SerialNumber: 70492003,
    FullyQualifiedName: ["Master Bedroom", "Shade 1"],
    ModelNumber: "QSFRJ-S2A13-XX",
    LocalZones: [{ href: "/zone/3" }],
    AddressedState: "Addressed"
  },
  {
    Name: "Pico",
    DeviceType: "Pico3ButtonRaiseLower",
    href: "/device/12",
    SerialNumber: 81234567,
    FullyQualifiedName: ["Living Room", "Pico"],
    ModelNumber: "PJ2-3BRL-GXX-X01",
    AddressedState: "Addressed"
  },
  {
    Name: "Blind",
    DeviceType: "SerenaTiltOnlyWoodBlind",
    href: "/device/20",
    SerialNumber: 81234568,
    FullyQualifiedName: ["Office", "Blind"],
    LocalZones: [{ href: "/zone/20" }],
    AddressedState: "Addressed"
  }
];

export class FakeBridge {
  constructor() {
    this.devices = structuredClone(DEVICES);
    this.levels = new Map([["/zone/1", 100], ["/zone/3", 0], ["/zone/20", 50]]);
    this.sockets = [];
    this.options = [];
    this.requests = [];
    this.refuse = 0;
    this.silent = new Set();
    this.failures = new Map();
    this.signed = undefined;
    this.connect = (options) => {
      this.options.push(options);
      const socket = new FakeSocket(this, options);
      this.sockets.push(socket);
      return socket;
    };
  }

  get open() {
    return this.sockets.filter((socket) => !socket.destroyed);
  }

  handle(socket, message) {
    this.requests.push({ port: socket.options.port, host: socket.options.host, message });
    const { Header: header } = message;
    if (this.silent.has(header.Url)) {
      return;
    }

    if (socket.options.port === 8083) {
      this.handlePairing(socket, message);
      return;
    }

    const failure = this.failures.get(header.Url);
    if (failure) {
      socket.send({ CommuniqueType: "ExceptionResponse", Header: { ...reply(header), StatusCode: failure }, Body: { Message: "Nope" } });
      return;
    }

    const type = message.CommuniqueType;
    if (type === "ReadRequest" && header.Url === "/device") {
      socket.send({ CommuniqueType: "ReadResponse", Header: reply(header, "200 OK"), Body: { Devices: this.devices } });
    } else if (type === "ReadRequest" && header.Url === "/server/1/status/ping") {
      socket.send({ CommuniqueType: "ReadResponse", Header: reply(header, "200 OK"), Body: { PingResponse: { LEAPVersion: 1.124 } } });
    } else if (type === "ReadRequest" && header.Url === "/area/status") {
      socket.send({ CommuniqueType: "ReadResponse", Header: reply(header, "204 NoContent") });
    } else if (type === "SubscribeRequest" && header.Url === "/zone/status") {
      socket.subscription = header.ClientTag;
      socket.send({ CommuniqueType: "SubscribeResponse", Header: reply(header, "200 OK"), Body: { ZoneStatuses: this.statuses() } });
    } else if (type === "CreateRequest" && /^\/zone\/\d+\/commandprocessor$/u.test(header.Url)) {
      const zone = header.Url.replace("/commandprocessor", "");
      const level = message.Body.Command.Parameter[0].Value;
      socket.send({ CommuniqueType: "CreateResponse", Header: reply(header, "201 Created"), Body: { ZoneStatus: this.status(zone) } });
      this.setLevel(zone, level);
    } else {
      socket.send({ CommuniqueType: "ExceptionResponse", Header: reply(header, "400 BadRequest"), Body: { Message: "This request is not supported" } });
    }
  }

  handlePairing(socket, message) {
    const { Header: header } = message;
    if (header.Url !== "/pair" || header.RequestType !== "Execute") {
      return;
    }

    if (!socket.pressed) {
      socket.send({ Header: { StatusCode: "401 Unauthorized", ClientTag: header.ClientTag }, Body: { Exception: { Message: "You are not authorized to perform this request" } } });
      return;
    }

    this.signed = message.Body.Parameters.CSR;
    socket.send({
      Header: { StatusCode: "200 OK", ClientTag: header.ClientTag, ContentType: "signing-result;plurality=single" },
      Body: { SigningResult: { Certificate: "SIGNED CERT", RootCertificate: "BRIDGE ROOT" } }
    });
  }

  pressButton() {
    for (const socket of this.open.filter((candidate) => candidate.options.port === 8083)) {
      socket.pressed = true;
      socket.send({ Header: { StatusCode: "200 OK", ContentType: "status;plurality=single" }, Body: { Status: { Permissions: ["Public", "PhysicalAccess"] } } });
    }
  }

  setLevel(zone, level) {
    this.levels.set(zone, level);
    for (const socket of this.open.filter((candidate) => candidate.options.port === 8081)) {
      socket.send({ CommuniqueType: "ReadResponse", Header: { StatusCode: "200 OK", Url: `${zone}/status/level` }, Body: { ZoneStatus: this.status(zone) } });
      if (socket.subscription) {
        socket.send({ CommuniqueType: "ReadResponse", Header: { StatusCode: "200 OK", Url: "/zone/status", ClientTag: socket.subscription }, Body: { ZoneStatuses: [this.status(zone)] } });
      }
    }
  }

  drop() {
    for (const socket of this.open) {
      socket.destroy();
    }
  }

  status(zone) {
    return { href: `${zone}/status`, Level: this.levels.get(zone), Zone: { href: zone }, StatusAccuracy: "Good" };
  }

  statuses() {
    return [...this.levels.keys()].map((zone) => this.status(zone));
  }
}

export class FakeSocket extends EventEmitter {
  constructor(bridge, options) {
    super();
    this.bridge = bridge;
    this.options = options;
    this.destroyed = false;
    this.writes = [];
    this.pressed = false;
    setImmediate(() => {
      if (bridge.refuse > 0) {
        bridge.refuse -= 1;
        this.emit("error", Object.assign(new Error(`connect ECONNREFUSED ${options.host}:${options.port}`), { code: "ECONNREFUSED" }));
        this.destroy();
        return;
      }

      if (!this.destroyed) {
        this.emit("secureConnect");
      }
    });
  }

  write(data) {
    if (this.destroyed) {
      throw new Error("write after destroy");
    }

    this.writes.push(data);
    for (const line of data.split("\r\n").filter(Boolean)) {
      this.bridge.handle(this, JSON.parse(line));
    }

    return true;
  }

  send(message) {
    this.raw(`${JSON.stringify(message)}\r\n`);
  }

  raw(text) {
    setImmediate(() => {
      if (!this.destroyed) {
        this.emit("data", Buffer.from(text));
      }
    });
  }

  destroy() {
    if (this.destroyed) {
      return;
    }

    this.destroyed = true;
    setImmediate(() => this.emit("close"));
  }
}

export function reply(header, status) {
  return { ...(status ? { StatusCode: status } : {}), Url: header.Url, ClientTag: header.ClientTag };
}

export function createLog() {
  const messages = { debug: [], error: [], info: [], warn: [] };
  const logger = {
    debug: (...parts) => messages.debug.push(parts.join(" ")),
    error: (...parts) => messages.error.push(parts.join(" ")),
    info: (...parts) => messages.info.push(parts.join(" ")),
    warn: (...parts) => messages.warn.push(parts.join(" "))
  };
  return { messages, logger };
}

export async function until(predicate) {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }

    await new Promise((resolve) => setImmediate(resolve));
  }

  throw new Error("condition was never met");
}

export async function settle() {
  for (let index = 0; index < 20; index++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

export function readDer(buffer, offset = 0) {
  const tag = buffer[offset];
  let length = buffer[offset + 1];
  let header = 2;
  if (length & 0x80) {
    const bytes = length & 0x7f;
    length = 0;
    for (let index = 0; index < bytes; index++) {
      length = length * 256 + buffer[offset + 2 + index];
    }

    header += bytes;
  }

  const start = offset + header;
  return { tag, start, end: start + length, raw: buffer.subarray(offset, start + length), content: buffer.subarray(start, start + length) };
}

export function children(node) {
  const nodes = [];
  for (let offset = 0; offset < node.content.length;) {
    const child = readDer(node.content, offset);
    nodes.push(child);
    offset = child.end;
  }

  return nodes;
}

export function parseCsr(pem) {
  const der = Buffer.from(pem.replace(/-----[^-]+-----/gu, "").replace(/\s+/gu, ""), "base64");
  const [info, algorithm, signature] = children(readDer(der));
  const [version, subject, spki, attributes] = children(info);
  const commonName = children(children(children(subject)[0])[0])[1].content.toString("utf8");
  return { info, algorithm, signature: signature.content.subarray(1), version, spki, attributes, commonName };
}

export function createApi(storagePath) {
  const handlers = {};
  const api = {
    hap: {
      Characteristic: {
        CurrentPosition: { name: "CurrentPosition" },
        Manufacturer: { name: "Manufacturer" },
        Model: { name: "Model" },
        Name: { name: "Name" },
        PositionState: { name: "PositionState", DECREASING: 0, INCREASING: 1, STOPPED: 2 },
        SerialNumber: { name: "SerialNumber" },
        TargetPosition: { name: "TargetPosition" }
      },
      Service: {
        AccessoryInformation: "AccessoryInformation",
        WindowCovering: "WindowCovering"
      },
      uuid: {
        generate: (value) => `uuid:${value}`
      }
    },
    user: {
      storagePath: () => storagePath
    },
    on: (event, handler) => {
      handlers[event] = handler;
    },
    emit: (event) => handlers[event]?.(),
    platformAccessory: FakePlatformAccessory,
    registered: [],
    unregistered: [],
    updated: [],
    registerPlatformAccessories: (_plugin, _platform, accessories) => api.registered.push(...accessories),
    unregisterPlatformAccessories: (_plugin, _platform, accessories) => api.unregistered.push(...accessories),
    updatePlatformAccessories: (accessories) => api.updated.push(...accessories)
  };
  return api;
}

export class FakePlatformAccessory {
  constructor(displayName, uuid) {
    this.context = {};
    this.displayName = displayName;
    this.UUID = uuid;
    this.services = new Map();
    this.addService("AccessoryInformation");
  }

  addService(name) {
    const service = new FakeService();
    this.services.set(name, service);
    return service;
  }

  getService(name) {
    return this.services.get(name);
  }
}

class FakeService {
  constructor() {
    this.characteristics = new Map();
  }

  getCharacteristic(type) {
    if (!this.characteristics.has(type.name)) {
      this.characteristics.set(type.name, new FakeCharacteristic());
    }

    return this.characteristics.get(type.name);
  }

  setCharacteristic(type, value) {
    this.getCharacteristic(type).value = value;
    return this;
  }
}

class FakeCharacteristic {
  onGet(handler) {
    this.getHandler = handler;
    return this;
  }

  onSet(handler) {
    this.setHandler = handler;
    return this;
  }

  updateValue(value) {
    this.value = value;
    return this;
  }
}

const platformRoot = fs.mkdtempSync(path.join(os.tmpdir(), "go-lutron-platform-"));
process.on("exit", () => fs.rmSync(platformRoot, { recursive: true, force: true }));

export function createPlatform({ config = {}, fake = new FakeBridge(), discovered = [{ id: BRIDGE_ID, host: BRIDGE_HOST }], paired = true, ...options } = {}) {
  const storagePath = fs.mkdtempSync(path.join(platformRoot, "storage-"));
  const store = new CredentialStore(path.join(storagePath, "go-lutron"));
  if (paired) {
    store.save({ id: BRIDGE_ID, host: BRIDGE_HOST, ...CREDENTIALS });
  }

  const { messages, logger } = createLog();
  const api = createApi(storagePath);
  const discoveries = [];
  const platform = new GoLutronPlatform(logger, { platform: "GoLutron", ...config }, api, {
    connect: fake.connect,
    discover: async (timeoutMs) => {
      discoveries.push(timeoutMs);
      if (discovered instanceof Error) {
        throw discovered;
      }

      return typeof discovered === "function" ? discovered() : discovered;
    },
    timing: FAST_TIMING,
    pairingTimeoutMs: 5000,
    ...options
  });
  return { api, discoveries, fake, messages, platform, store, storagePath };
}

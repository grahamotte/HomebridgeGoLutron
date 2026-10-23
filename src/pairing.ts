import { generateKeyPair } from "node:crypto";
import { promisify } from "node:util";
import { ASSOCIATION_CA, ASSOCIATION_CERT, ASSOCIATION_KEY } from "./association.js";
import { createCsr } from "./csr.js";
import { LeapClient, LeapError, type Credentials, type LeapMessage, type SocketFactory } from "./leap.js";
import { PAIRING_PORT, PLUGIN_NAME } from "./settings.js";

export interface PairingOptions {
  readonly timeoutMs: number;
  readonly requestTimeoutMs: number;
  readonly connect?: SocketFactory;
}

interface SigningResult {
  readonly Certificate?: unknown;
  readonly RootCertificate?: unknown;
}

export async function pair(host: string, options: PairingOptions): Promise<Credentials> {
  const { privateKey, publicKey } = await promisify(generateKeyPair)("rsa", { modulusLength: 2048 });
  const csr = createCsr(privateKey, publicKey, PLUGIN_NAME);
  let pressed: () => void = () => undefined;
  let failed: (error: Error) => void = () => undefined;
  const button = new Promise<void>((resolve, reject) => {
    pressed = resolve;
    failed = reject;
  });
  button.catch(() => undefined);

  const client = new LeapClient({
    host,
    port: PAIRING_PORT,
    credentials: { ca: ASSOCIATION_CA, cert: ASSOCIATION_CERT, key: ASSOCIATION_KEY },
    verify: false,
    timeoutMs: options.requestTimeoutMs,
    connect: options.connect,
    onUnsolicited: (message) => {
      if (hasPhysicalAccess(message)) {
        pressed();
      }
    },
    onClose: (error) => failed(error ?? new LeapError("pairing connection closed"))
  });

  const timer = setTimeout(() => failed(new LeapError("the bridge button was not pressed in time")), options.timeoutMs);
  timer.unref?.();
  try {
    await client.open();
    await button;
    const response = await client.exchange({
      Header: { RequestType: "Execute", Url: "/pair", ClientTag: "get-cert" },
      Body: {
        CommandType: "CSR",
        Parameters: { CSR: csr, DisplayName: PLUGIN_NAME, DeviceUID: "000000000000", Role: "Admin" }
      }
    });
    const result = (response.Body as { SigningResult?: SigningResult } | undefined)?.SigningResult;
    if (typeof result?.Certificate !== "string" || typeof result.RootCertificate !== "string") {
      throw new LeapError("the bridge did not return a signed certificate");
    }

    return {
      ca: result.RootCertificate,
      cert: result.Certificate,
      key: privateKey.export({ type: "pkcs8", format: "pem" }).toString()
    };
  } finally {
    clearTimeout(timer);
    client.close();
  }
}

function hasPhysicalAccess(message: LeapMessage): boolean {
  const permissions = (message.Body as { Status?: { Permissions?: unknown } } | undefined)?.Status?.Permissions;
  return Array.isArray(permissions) && permissions.includes("PhysicalAccess");
}

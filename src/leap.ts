import tls from "node:tls";

export interface LeapHeader {
  readonly StatusCode?: string;
  readonly Url?: string;
  readonly ClientTag?: string;
  readonly MessageBodyType?: string;
  readonly RequestType?: string;
}

export interface LeapMessage {
  readonly CommuniqueType?: string;
  readonly Header: LeapHeader;
  readonly Body?: unknown;
}

export interface Credentials {
  readonly ca: string;
  readonly cert: string;
  readonly key: string;
}

export interface LeapSocket {
  on(event: "secureConnect" | "close", listener: () => void): unknown;
  on(event: "data", listener: (chunk: Buffer | string) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  write(data: string): unknown;
  destroy(): unknown;
}

export type SocketFactory = (options: tls.ConnectionOptions) => LeapSocket;

export interface LeapClientOptions {
  readonly host: string;
  readonly port: number;
  readonly credentials: Credentials;
  readonly verify: boolean;
  readonly timeoutMs: number;
  readonly connect?: SocketFactory;
  readonly onUnsolicited?: (message: LeapMessage) => void;
  readonly onClose?: (error?: Error) => void;
}

export class LeapError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "LeapError";
  }
}

interface Pending {
  readonly resolve: (message: LeapMessage) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

export class LeapClient {
  private socket?: LeapSocket;
  private buffer = "";
  private tag = 0;
  private closed = false;
  private closeError?: Error;
  private readonly pending = new Map<string, Pending>();
  private readonly subscriptions = new Map<string, (message: LeapMessage) => void>();

  constructor(private readonly options: LeapClientOptions) {}

  open(): Promise<void> {
    if (this.socket) {
      return Promise.reject(new LeapError("connection already opened"));
    }

    return new Promise((resolve, reject) => {
      let settled = false;
      const settle = (error?: Error) => {
        if (settled) {
          return;
        }

        settled = true;
        clearTimeout(timer);
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      };
      const timer = setTimeout(() => {
        settle(new LeapError(`timed out connecting to ${this.options.host}:${this.options.port}`));
        this.close();
      }, this.options.timeoutMs);
      timer.unref?.();

      const { ca, cert, key } = this.options.credentials;
      const connect = this.options.connect ?? tls.connect;
      try {
        this.socket = connect({
          host: this.options.host,
          port: this.options.port,
          ca,
          cert,
          key,
          rejectUnauthorized: this.options.verify,
          checkServerIdentity: () => undefined
        });
      } catch (error) {
        settle(asError(error));
        this.finish(asError(error));
        return;
      }

      this.socket.on("secureConnect", () => settle());
      this.socket.on("data", (chunk) => this.receive(chunk.toString()));
      this.socket.on("error", (error) => {
        this.closeError ??= error;
        settle(error);
        this.close();
      });
      this.socket.on("close", () => {
        const error = this.closeError ?? new LeapError("connection closed");
        settle(error);
        this.finish(error);
      });
    });
  }

  get isOpen(): boolean {
    return this.socket !== undefined && !this.closed;
  }

  request(type: string, url: string, body?: unknown): Promise<LeapMessage> {
    return this.exchange({ CommuniqueType: type, Header: { Url: url }, ...(body === undefined ? {} : { Body: body }) });
  }

  async read(url: string): Promise<unknown> {
    return (await this.request("ReadRequest", url)).Body;
  }

  async subscribe(url: string, handler: (message: LeapMessage) => void): Promise<LeapMessage> {
    const tag = this.nextTag();
    this.subscriptions.set(tag, handler);
    try {
      return await this.exchange({ CommuniqueType: "SubscribeRequest", Header: { Url: url, ClientTag: tag } });
    } catch (error) {
      this.subscriptions.delete(tag);
      throw error;
    }
  }

  exchange(message: LeapMessage): Promise<LeapMessage> {
    if (!this.socket || this.closed) {
      return Promise.reject(new LeapError("not connected"));
    }

    const tag = message.Header.ClientTag ?? this.nextTag();
    const url = message.Header.Url ?? "";
    if (this.pending.has(tag)) {
      return Promise.reject(new LeapError(`request ${tag} is already in flight`));
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(tag);
        reject(new LeapError(`${url} timed out`));
      }, this.options.timeoutMs);
      timer.unref?.();
      this.pending.set(tag, {
        timer,
        reject,
        resolve: (response) => {
          const status = statusCode(response);
          if (response.CommuniqueType === "ExceptionResponse" || (status !== undefined && status >= 400)) {
            reject(new LeapError(`${url} failed: ${describeFailure(response)}`, status));
          } else {
            resolve(response);
          }
        }
      });

      try {
        this.socket?.write(`${JSON.stringify({ ...message, Header: { ...message.Header, ClientTag: tag } })}\r\n`);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(tag);
        reject(asError(error));
      }
    });
  }

  close(): void {
    if (!this.socket || this.closed) {
      return;
    }

    try {
      this.socket.destroy();
    } catch (error) {
      this.finish(asError(error));
    }
  }

  private nextTag(): string {
    this.tag += 1;
    return `go-lutron-${this.tag}`;
  }

  private receive(data: string): void {
    this.buffer += data;
    const lines = this.buffer.split(/\r?\n/u);
    this.buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) {
        continue;
      }

      let message: LeapMessage;
      try {
        message = JSON.parse(line) as LeapMessage;
      } catch {
        continue;
      }

      if (!message || typeof message !== "object" || !message.Header || typeof message.Header !== "object") {
        continue;
      }

      this.dispatch(message);
    }
  }

  private dispatch(message: LeapMessage): void {
    const tag = message.Header.ClientTag;
    const pending = tag === undefined ? undefined : this.pending.get(tag);
    if (tag !== undefined && pending) {
      clearTimeout(pending.timer);
      this.pending.delete(tag);
      pending.resolve(message);
      return;
    }

    const subscription = tag === undefined ? undefined : this.subscriptions.get(tag);
    const handler = subscription ?? this.options.onUnsolicited;
    try {
      handler?.(message);
    } catch {
      return;
    }
  }

  private finish(error: Error): void {
    if (this.closed) {
      return;
    }

    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }

    this.pending.clear();
    this.subscriptions.clear();
    try {
      this.options.onClose?.(error);
    } catch {
      return;
    }
  }
}

export function statusCode(message: LeapMessage): number | undefined {
  const match = /^(\d{3})/u.exec(message.Header.StatusCode ?? "");
  return match ? Number(match[1]) : undefined;
}

export function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export function describe(error: unknown): string {
  return asError(error).message;
}

function describeFailure(message: LeapMessage): string {
  const body = message.Body as { Message?: unknown; Exception?: { Message?: unknown } } | undefined;
  const detail = typeof body?.Message === "string"
    ? body.Message
    : typeof body?.Exception?.Message === "string" ? body.Exception.Message : undefined;
  return [message.Header.StatusCode ?? "error", detail].filter(Boolean).join(": ");
}

// @effect-diagnostics nodeBuiltinImport:off -- These tests exercise the native Node HTTP adapter with real stream semantics.
import * as NodeEvents from "node:events";
import * as NodeHttp from "node:http";
import * as NodeStream from "node:stream";

import { expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { vi } from "vite-plus/test";

import {
  ClientDisconnectedError,
  configureServerTimeouts,
  handleNodeRequest,
  RequestBodyReadError,
  RequestBodyTooLargeError,
  requestFailureResponse,
  toFetchRequest,
  writeFetchResponse,
} from "./main.ts";

const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

const incoming = (headers: NodeHttp.IncomingMessage["headers"] = {}) => {
  const socket = new NodeEvents.EventEmitter();
  return Object.assign(new NodeStream.PassThrough(), {
    headers,
    method: "POST",
    socket,
    url: "/api/auth/sign-in/email",
  }) as unknown as NodeHttp.IncomingMessage &
    NodeStream.PassThrough & { readonly socket: NodeEvents.EventEmitter };
};

class TestResponse extends NodeEvents.EventEmitter {
  statusCode = 0;
  destroyed = false;
  writableEnded = false;
  headersSent = false;
  endCount = 0;
  body = "";
  readonly headers = new Map<string, string | number | ReadonlyArray<string>>();

  setHeader(name: string, value: string | number | ReadonlyArray<string>) {
    this.headers.set(name.toLowerCase(), value);
    return this;
  }

  end(body?: Uint8Array) {
    this.endCount += 1;
    this.headersSent = true;
    this.writableEnded = true;
    this.body = body === undefined ? "" : Buffer.from(body).toString("utf8");
    return this;
  }
}

const testResponse = () => new TestResponse() as TestResponse & NodeHttp.ServerResponse;

it("preserves multiple Set-Cookie values at the Node response boundary", async () => {
  const responseHeaders = new Headers({ "content-type": "text/plain" });
  responseHeaders.append("set-cookie", "session=one; HttpOnly; Secure; Path=/");
  responseHeaders.append("set-cookie", "csrf=two; HttpOnly; Secure; Path=/");
  const fetchResponse = new Response("ok", { status: 201, headers: responseHeaders });
  const writtenHeaders = new Map<string, string | number | ReadonlyArray<string>>();
  let writtenBody = "";
  const response = {
    statusCode: 0,
    setHeader(name: string, value: string | number | ReadonlyArray<string>) {
      writtenHeaders.set(name.toLowerCase(), value);
      return this;
    },
    end(body?: Uint8Array) {
      writtenBody = body === undefined ? "" : Buffer.from(body).toString("utf8");
      return this;
    },
  } as unknown as NodeHttp.ServerResponse;

  await writeFetchResponse(response, fetchResponse);

  expect(response.statusCode).toBe(201);
  expect(writtenHeaders.get("set-cookie")).toEqual([
    "session=one; HttpOnly; Secure; Path=/",
    "csrf=two; HttpOnly; Secure; Path=/",
  ]);
  expect(writtenBody).toBe("ok");
});

it("rejects chunked overflow before constructing a Request or retaining the canary", async () => {
  const request = incoming({ "transfer-encoding": "chunked" });
  let handlerCalls = 0;
  const converted = toFetchRequest(request, new URL("https://control.example.com"), 8).then(
    () => {
      handlerCalls += 1;
      return undefined;
    },
    (cause: unknown) => cause,
  );

  request.write("12345678");
  request.write("TOP_SECRET_AUTH_BODY");
  request.end();
  const failure = await converted;
  const response = requestFailureResponse(failure);

  expect(failure).toBeInstanceOf(RequestBodyTooLargeError);
  expect(handlerCalls).toBe(0);
  expect(response.status).toBe(413);
  expect(await response.json()).toEqual({ error: "request_body_too_large" });
  expect(await requestFailureResponse(failure).text()).not.toContain("TOP_SECRET_AUTH_BODY");
});

it("rejects declared overflow before reading and settles aborted bodies", async () => {
  const declared = incoming({ "content-length": "9" });
  declared.method = "GET";
  const declaredFailure = await toFetchRequest(
    declared,
    new URL("https://control.example.com"),
    8,
  ).catch((cause: unknown) => cause);
  expect(declaredFailure).toBeInstanceOf(RequestBodyTooLargeError);

  const aborted = incoming();
  const abortedResult = toFetchRequest(aborted, new URL("https://control.example.com"), 8).catch(
    (cause: unknown) => cause,
  );
  aborted.emit("aborted");
  expect(await abortedResult).toBeInstanceOf(RequestBodyReadError);
});

it("configures bounded Node request and header timeouts", () => {
  const server = NodeHttp.createServer();
  configureServerTimeouts(server, { requestTimeoutMs: 15_000, headersTimeoutMs: 10_000 });

  expect(server.requestTimeout).toBe(15_000);
  expect(server.headersTimeout).toBe(10_000);
});

it("completes a normal request and removes every lifecycle listener", async () => {
  const request = incoming();
  request.method = "GET";
  request.url = "/health";
  const response = testResponse();
  let fetchSignal: AbortSignal | undefined;

  const completed = handleNodeRequest(request, response, {
    baseUrl: new URL("https://control.example.com"),
    maxBodyBytes: 1_024,
    processingTimeoutMs: 1_000,
    handle: async (fetchRequest) => {
      fetchSignal = fetchRequest.signal;
      return new Response("ok", { status: 200 });
    },
  });
  request.end();
  await completed;

  expect(fetchSignal?.aborted).toBe(false);
  expect(response.statusCode).toBe(200);
  expect(response.body).toBe("ok");
  expect(response.endCount).toBe(1);
  expect(request.listenerCount("aborted")).toBe(0);
  expect(request.socket.listenerCount("close")).toBe(0);
  expect(response.listenerCount("close")).toBe(0);
});

it("returns one safe timeout response and ignores a late handler completion", async () => {
  vi.useFakeTimers();
  try {
    const request = incoming();
    const response = testResponse();
    let finishHandler: ((response: Response) => void) | undefined;
    let handlerStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      handlerStarted = resolve;
    });

    const completed = handleNodeRequest(request, response, {
      baseUrl: new URL("https://control.example.com"),
      maxBodyBytes: 1_024,
      processingTimeoutMs: 25,
      handle: () =>
        new Promise<Response>((resolve) => {
          finishHandler = resolve;
          handlerStarted?.();
        }),
    });
    request.end();
    await started;
    await vi.advanceTimersByTimeAsync(25);
    await completed;

    expect(response.statusCode).toBe(504);
    expect(decodeJson(response.body)).toEqual({ error: "request_processing_timeout" });
    expect(response.endCount).toBe(1);
    expect(vi.getTimerCount()).toBe(0);

    finishHandler?.(new Response("too late"));
    await Promise.resolve();
    expect(response.endCount).toBe(1);
    expect(request.listenerCount("aborted")).toBe(0);
    expect(request.socket.listenerCount("close")).toBe(0);
    expect(response.listenerCount("close")).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

it("does not double-write when a response body settles after the deadline", async () => {
  vi.useFakeTimers();
  try {
    const request = incoming();
    const response = testResponse();
    let finishBody: (() => void) | undefined;
    const delayedBody = new ReadableStream<Uint8Array>({
      start(controller) {
        finishBody = () => {
          controller.enqueue(Buffer.from("too late"));
          controller.close();
        };
      },
    });

    const completed = handleNodeRequest(request, response, {
      baseUrl: new URL("https://control.example.com"),
      maxBodyBytes: 1_024,
      processingTimeoutMs: 25,
      handle: async () => new Response(delayedBody),
    });
    request.end();
    await vi.advanceTimersByTimeAsync(25);
    await completed;

    expect(response.statusCode).toBe(504);
    expect(response.endCount).toBe(1);

    finishBody?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(response.endCount).toBe(1);
    expect(response.body).not.toContain("too late");
  } finally {
    vi.useRealTimers();
  }
});

it("aborts handler work and writes nothing after the client disconnects", async () => {
  const request = incoming();
  const response = testResponse();
  let fetchSignal: AbortSignal | undefined;
  let handlerStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    handlerStarted = resolve;
  });

  const completed = handleNodeRequest(request, response, {
    baseUrl: new URL("https://control.example.com"),
    maxBodyBytes: 1_024,
    processingTimeoutMs: 1_000,
    handle: (fetchRequest) => {
      fetchSignal = fetchRequest.signal;
      handlerStarted?.();
      return new Promise<Response>(() => undefined);
    },
  });
  request.end();
  await started;
  request.socket.emit("close");
  await completed;

  expect(fetchSignal?.aborted).toBe(true);
  expect(fetchSignal?.reason).toBeInstanceOf(ClientDisconnectedError);
  expect(response.endCount).toBe(0);
  expect(request.listenerCount("aborted")).toBe(0);
  expect(request.socket.listenerCount("close")).toBe(0);
  expect(response.listenerCount("close")).toBe(0);
});

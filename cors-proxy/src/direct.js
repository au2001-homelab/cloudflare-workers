/**
 * `fetch()` on Cloudflare's edge answers 403 with `error code: 1003`
 * when trying to reach a host named by address rather than by name.
 * So we connect with a raw socket, write HTTP into it and parse the answer.
 */

import { connect } from "cloudflare:sockets";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const CRLF = [13, 10];
const CRLFCRLF = [13, 10, 13, 10];

const MAX_HEAD = 32 * 1024;

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
  // This file doesn't support compression
  "accept-encoding",
]);

export function literal(hostname) {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) || hostname.includes(":");
}

function concat(left, right) {
  const joined = new Uint8Array(left.byteLength + right.byteLength);
  joined.set(left);
  joined.set(right, left.byteLength);
  return joined;
}

function indexOf(bytes, needle) {
  outer: for (let at = 0; at + needle.length <= bytes.byteLength; at++) {
    for (let i = 0; i < needle.length; i++)
      if (bytes[at + i] !== needle[i]) continue outer;

    return at;
  }

  return -1;
}

async function* bytes(reader, rest, length) {
  let seen = rest.byteLength;
  if (rest.byteLength) yield rest;

  for (;;) {
    const { done, value } = await reader.read();

    if (value?.byteLength) {
      seen += value.byteLength;
      yield value;
    }

    if (done) {
      if (length !== null && seen < length)
        throw new Error(
          `Upstream hung up with ${length - seen} of ${length} body bytes unsent`,
        );

      return;
    }
  }
}

async function* dechunk(source) {
  let buffer = new Uint8Array(0);
  let ended = false;

  async function more() {
    if (ended) return false;

    const { done, value } = await source.next();
    if (done) {
      ended = true;
      return false;
    }

    buffer = concat(buffer, value);
    return true;
  }

  const truncated = () =>
    new Error("Upstream hung up before the end of the chunked body");

  for (;;) {
    let at = indexOf(buffer, CRLF);

    while (at < 0) {
      if (!(await more())) throw truncated();
      at = indexOf(buffer, CRLF);
    }

    const size = parseInt(decoder.decode(buffer.subarray(0, at)), 16);
    buffer = buffer.subarray(at + 2);

    if (!Number.isInteger(size) || size < 0)
      throw new Error("Upstream sent a malformed chunk size");

    if (size === 0) return;

    for (let left = size; left > 0;) {
      while (buffer.byteLength === 0) if (!(await more())) throw truncated();

      const take = Math.min(left, buffer.byteLength);
      yield buffer.subarray(0, take);
      buffer = buffer.subarray(take);
      left -= take;
    }

    while (buffer.byteLength < 2) if (!(await more())) throw truncated();
    buffer = buffer.subarray(2);
  }
}

function stream(source, socket) {
  const hangUp = () => socket.close().catch(() => {});

  return new ReadableStream({
    async pull(controller) {
      try {
        const { done, value } = await source.next();
        if (!done) return controller.enqueue(value);

        controller.close();
      } catch (cause) {
        controller.error(cause);
      }

      await hangUp();
    },

    cancel: hangUp,
  });
}

export async function direct(request, url, signal) {
  const socket = connect(
    { hostname: url.hostname, port: Number(url.port) || 80 },
    { secureTransport: "off" },
  );

  signal?.addEventListener("abort", () => void socket.close().catch(() => {}), {
    once: true,
  });

  const body = request.body
    ? new Uint8Array(await request.arrayBuffer())
    : null;

  const head = [
    `${request.method} ${url.pathname}${url.search} HTTP/1.1`,
    `Host: ${url.host}`,
    "Connection: close",
    "Accept-Encoding: identity",
    ...[...request.headers]
      .filter(([name]) => !HOP_BY_HOP.has(name))
      .map(([name, value]) => `${name}: ${value}`),
    ...(body ? [`Content-Length: ${body.byteLength}`] : []),
    "",
    "",
  ].join("\r\n");

  const writer = socket.writable.getWriter();
  await writer.write(encoder.encode(head));
  if (body) await writer.write(body);
  writer.releaseLock();

  const reader = socket.readable.getReader();
  let buffer = new Uint8Array(0);
  let at = -1;

  while (at < 0) {
    const { done, value } = await reader.read();
    if (value?.byteLength) buffer = concat(buffer, value);

    at = indexOf(buffer, CRLFCRLF);
    if (at >= 0) break;

    if (done) throw new Error("Upstream hung up before answering");
    if (buffer.byteLength > MAX_HEAD)
      throw new Error("Upstream response head is too large");
  }

  const lines = decoder.decode(buffer.subarray(0, at)).split("\r\n");
  const status = /^HTTP\/1\.[01] (\d{3})(?: (.*))?$/.exec(lines.shift() ?? "");
  if (!status) throw new Error("Upstream did not answer with HTTP");

  const code = Number(status[1]);
  if (code < 200 || code > 599)
    throw new Error(`Upstream answered ${code}, which cannot be passed on`);

  const headers = new Headers();
  let chunked = false;

  for (const line of lines) {
    const colon = line.indexOf(":");
    if (colon < 1) continue;

    const name = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();

    if (name === "transfer-encoding") {
      chunked = /chunked/i.test(value);
      continue;
    }

    if (name === "connection" || name === "keep-alive") continue;

    try {
      headers.append(name, value);
    } catch {}
  }

  const options = { status: code, statusText: status[2] ?? "", headers };

  if (request.method === "HEAD" || code === 204 || code === 304) {
    await socket.close().catch(() => {});
    return new Response(null, options);
  }

  const counted = chunked ? null : headers.get("content-length");
  const declared = counted === null ? NaN : Number(counted);
  const length = Number.isInteger(declared) && declared >= 0 ? declared : null;

  const source = bytes(reader, buffer.subarray(at + 4), length);
  return new Response(
    stream(chunked ? dechunk(source) : source, socket),
    options,
  );
}

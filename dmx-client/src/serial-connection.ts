import { execFile, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import path from "node:path";
import type { UsbConnection } from "./enttec";

const worker = path.join(process.env.LBE_LIGHTING_RESOURCES ?? import.meta.dir, "serial-worker.mjs");

export interface UsbDevice {
  path: string;
  manufacturer?: string;
  serialNumber?: string;
  pnpId?: string;
  vendorId?: string;
  productId?: string;
}

export function listUsbDevices(): Promise<UsbDevice[]> {
  return new Promise((resolve, reject) => {
    execFile("node", [worker, "--list"], { timeout: 5000 }, (error, stdout) => {
      if (error) return reject(new Error(`USB enumeration needs Node on PATH: ${error.message}`));
      try { resolve(JSON.parse(stdout)); } catch (error) { reject(error); }
    });
  });
}

/** Isolate the native addon in Node while the show engine remains in Bun. */
export async function openSerial(path: string): Promise<UsbConnection> {
  const child = spawn("node", [worker, path], { stdio: ["pipe", "pipe", "pipe"] });
  let receive: (bytes: Uint8Array) => void = () => {};
  let reportFailure: (error: Error) => void = () => {};
  let failure: Error | null = null;
  let closing = false;
  let nextId = 0;
  let stderr = "";
  const pending = new Map<number, { resolve: () => void; reject: (error: Error) => void }>();
  let opened!: () => void;
  let rejectOpen!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => { opened = resolve; rejectOpen = reject; });
  const fail = (error: Error) => {
    if (failure) return;
    failure = error;
    rejectOpen(error);
    for (const request of pending.values()) request.reject(error);
    pending.clear();
    reportFailure(error);
    child.kill();
  };
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    try {
      const message = JSON.parse(line);
      if (message.type === "open") opened();
      else if (message.type === "data") receive(Buffer.from(message.data, "base64"));
      else if (message.type === "failure") fail(new Error(message.error));
      else if (message.type === "reply") {
        const request = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) request?.reject(new Error(message.error));
        else request?.resolve();
      }
    } catch (error) { fail(error instanceof Error ? error : new Error(String(error))); }
  });
  child.stderr.on("data", (chunk) => { stderr = (stderr + chunk.toString()).slice(-2000); });
  child.on("error", (error) => fail(new Error(`USB worker needs Node on PATH: ${error.message}`)));
  child.stdin.on("error", fail);
  child.on("exit", (code, signal) => {
    if (!closing) fail(new Error(`USB worker stopped (${signal ?? code}): ${stderr.trim()}`));
  });
  const timer = setTimeout(() => fail(new Error("ENTTEC USB open timed out")), 5000);
  try { await ready; } finally { clearTimeout(timer); }

  const request = (type: "write" | "close", data?: string) => new Promise<void>((resolve, reject) => {
    if (failure) return reject(failure);
    const id = ++nextId;
    const timer = setTimeout(() => fail(new Error(`ENTTEC USB ${type} timed out`)), 2000);
    pending.set(id, {
      resolve: () => { clearTimeout(timer); resolve(); },
      reject: (error) => { clearTimeout(timer); reject(error); },
    });
    child.stdin.write(`${JSON.stringify({ type, id, data })}\n`, (error) => { if (error) fail(error); });
  });
  return {
    path,
    onData(callback) { receive = callback; },
    onFailure(callback) { reportFailure = callback; if (failure) callback(failure); },
    write(bytes) { return request("write", Buffer.from(bytes).toString("base64")); },
    async close() {
      if (closing) return;
      closing = true;
      try { if (!failure) await request("close"); }
      finally { child.stdin.end(); lines.close(); child.kill(); }
    },
  };
}

// Run with Node, not Bun: serialport's native open() uses libuv APIs Bun does not implement.
// stdin/stdout are a private JSON-lines protocol. Only this process owns the USB handle.
import { SerialPort } from "serialport";
import { createInterface } from "node:readline";

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
if (process.argv[2] === "--list") {
  console.log(JSON.stringify(await SerialPort.list()));
} else {
  // The Pro's VCP baud does not set physical DMX speed (ENTTEC API v1.44, p. 1).
  // macOS nevertheless uses it for drain timing: 57600 costs ~109ms per frame;
  // 1M costs ~8ms, allowing 40fps while retaining bounded writes and final drain.
  const port = new SerialPort({ path: process.argv[2], baudRate: 1000000, autoOpen: false, lock: true });
  let closing = false;
  const close = async () => {
    closing = true;
    if (port.isOpen) await new Promise((resolve, reject) => port.close((error) => error ? reject(error) : resolve()));
  };
  port.on("data", (bytes) => send({ type: "data", data: bytes.toString("base64") }));
  port.on("error", (error) => send({ type: "failure", error: error.message }));
  port.on("close", () => {
    if (!closing) send({ type: "failure", error: "ENTTEC disconnected; reconnect it and restart the client" });
  });
  try {
    await new Promise((resolve, reject) => port.open((error) => error ? reject(error) : resolve()));
    send({ type: "open" });
    const input = createInterface({ input: process.stdin });
    // Serialize writes/drains and close, even if commands arrive in the same stdin chunk.
    let queue = Promise.resolve();
    input.on("line", (line) => {
      queue = queue.then(async () => {
        const command = JSON.parse(line);
        try {
          if (command.type === "write") {
            await new Promise((resolve, reject) => {
              port.write(Buffer.from(command.data, "base64"), (error) => {
                if (error) return reject(error);
                port.drain((error) => error ? reject(error) : resolve());
              });
            });
          } else if (command.type === "close") {
            await close();
          } else throw new Error("Unknown serial worker command");
          send({ type: "reply", id: command.id });
        } catch (error) {
          send({ type: "reply", id: command.id, error: error.message });
        }
      }).catch((error) => send({ type: "failure", error: error.message }));
    });
    input.on("close", () => { void queue.finally(close).finally(() => process.exit()); });
  } catch (error) {
    send({ type: "failure", error: error.message });
    process.exitCode = 1;
  }
}

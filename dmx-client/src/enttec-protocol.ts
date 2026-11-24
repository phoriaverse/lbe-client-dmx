/** ENTTEC's public USB Pro API, also supported by Mk2 DMX OUT 1 (API1). */
export function enttecMessage(label: number, payload: Uint8Array): Uint8Array {
  if (!Number.isInteger(label) || label < 0 || label > 255 || payload.length > 600) throw new Error("Invalid ENTTEC message");
  const packet = new Uint8Array(payload.length + 5);
  packet.set([0x7e, label, payload.length & 0xff, payload.length >> 8]);
  packet.set(payload, 4);
  packet[packet.length - 1] = 0xe7;
  return packet;
}

export function enttecDmx(data: Uint8Array): Uint8Array {
  if (data.length !== 512) throw new Error("ENTTEC output requires exactly 512 channel values");
  const payload = new Uint8Array(513); // byte 0 is the DMX start code, NOT channel 1
  payload.set(data, 1);
  return enttecMessage(6, payload);
}

/** Serial chunks need not line up with frames. Ignore garbage and malformed framing. */
export class EnttecDecoder {
  private bytes = new Uint8Array(0);
  push(chunk: Uint8Array): { label: number; payload: Uint8Array }[] {
    const joined = new Uint8Array(this.bytes.length + chunk.length);
    joined.set(this.bytes);
    joined.set(chunk, this.bytes.length);
    this.bytes = joined;
    const messages: { label: number; payload: Uint8Array }[] = [];
    while (this.bytes.length) {
      const start = this.bytes.indexOf(0x7e);
      if (start < 0) { this.bytes = new Uint8Array(0); break; }
      this.bytes = this.bytes.slice(start);
      if (this.bytes.length < 4) break;
      const length = this.bytes[2]! | (this.bytes[3]! << 8);
      if (length > 600) { this.bytes = this.bytes.slice(1); continue; }
      if (this.bytes.length < length + 5) break;
      if (this.bytes[length + 4] !== 0xe7) { this.bytes = this.bytes.slice(1); continue; }
      messages.push({ label: this.bytes[1]!, payload: this.bytes.slice(4, length + 4) });
      this.bytes = this.bytes.slice(length + 5);
    }
    return messages;
  }
}

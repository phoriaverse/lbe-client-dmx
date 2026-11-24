import { expect, test } from "bun:test";
import { EnttecUsb } from "../src/enttec";

// Opt-in regression for Bun's native serial open crash. Opens real USB and sends only blackout.
// Run with LBE_TEST_USB_DEVICE=/dev/tty.usbserial-... bun test test/usb-hardware.test.ts
const device = process.env.LBE_TEST_USB_DEVICE;
test.skipIf(!device)("real USB handshake, frame/drain and close work from the Bun client", async () => {
  const usb = await EnttecUsb.open(device, 1, 40);
  try {
    expect(usb.connected).toBe(true);
    expect(usb.packetsSent).toBe(1);
    expect(usb.error).toBeNull();
    // Catch a VCP drain delay that silently coalesces 40fps down to ~9fps on macOS.
    for (let frame = 0; frame < 40; frame++) {
      usb.sendUniverse("enttec-usb", 6454, 1, new Uint8Array(512));
      await Bun.sleep(25);
    }
    expect(usb.packetsSent).toBeGreaterThanOrEqual(35);
    expect(usb.failures).toBe(0);
  } finally { await usb.close(); }
  expect(usb.connected).toBe(false);
}, 10000);

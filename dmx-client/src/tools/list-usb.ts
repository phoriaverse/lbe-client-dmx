import { listUsbDevices } from "../enttec";

const devices = await listUsbDevices();
if (!devices.length) console.log("No serial devices found. Connect the ENTTEC and check its FTDI VCP driver.");
else console.table(devices.map(({ path, manufacturer, serialNumber, vendorId, productId }) => ({ path, manufacturer, serialNumber, vendorId, productId })));

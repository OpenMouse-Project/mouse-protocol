# Pulsar X2A v3 / shared 8K receiver follow-up

Ticket identity: VID `0x3710`, wired X2A v3 PID `0x3404`, shared 8K receiver
PID `0x5403`, Windows 11. The wired ID and the `0xffff:0x01` control-interface
restriction were already added in [PR #144](https://github.com/OpenMouse-Project/mouse-protocol/pull/144).

This follow-up corrects the receiver's 8K capability list, gives the wired
mouse its model name, and stops interpreting a failed/unrecognized polling
reply as 1000 Hz. The read-only polling decoder is unchanged; its physical
accuracy still needs a capture correlated with the vendor application's setting.
No polling write is added. The existing wired/1K capability list is preserved.
The generic receiver name does not identify the paired mouse.

The reported 8K capability agrees with [Pulsar's X2A v3 product page](https://jp.pulsar.gg/products/x2a-v3-gaming-mouse),
which requires the separately sold 8K dongle for 8K wireless operation. This
does not establish the format of a polling-rate write or mark either path as
hardware-verified by OpenMouse.

## What the reporter should test

1. In the current panel, connect over cable. Confirm X2A v3 and Wired. Change
   DPI from 700 to 800 (or another supported value), apply, confirm the read-back
   and observed mouse behavior, then restore the original setting.
2. Connect through the 8K receiver. Confirm Wireless and a generic dongle name.
   Repeat the DPI test; try debounce and Motion Sync separately and report
   their before/after values and any error. These setters already exist.
3. Set 1000, 2000, 4000 and 8000 Hz in Pulsar's application one at a time.
   Close that application before refreshing OpenMouse. For each value, download
   Diagnostics and record the UI readout. A missing/unknown reply should show a
   dash, not claim 1000 Hz. The polling buttons remain read-only.
4. Include the feature-report packets for the polling query
   (`08 85 03`, 64-byte report 0) at each vendor setting, so the existing
   decoding table can be checked against real hardware.

After granting the receiver in the browser picker, this prints only the Pulsar
device names and report descriptors; it does not rely on Chrome's `copy()` helper:

```js
console.log(JSON.stringify((await navigator.hid.getDevices())
  .filter(device => device.vendorId === 0x3710)
  .map(device => ({
    name: device.productName,
    pid: `0x${device.productId.toString(16)}`,
    collections: device.collections.map(collection => ({
      usagePage: `0x${collection.usagePage.toString(16)}`,
      usage: `0x${collection.usage.toString(16)}`,
      featureReports: collection.featureReports.map(report => ({
        id: report.reportId,
        bytes: report.items.reduce((bits, item) => bits + item.reportSize * item.reportCount, 0) / 8,
      })),
    })),
  })), null, 2));
```

An empty array means that browser has not retained a grant for a Pulsar device.
The ticket's linked screenshots and diagnostic JSON were not available in the
supplied transcript, so the unresolved hardware behavior cannot be inferred from
those attachments. No Bridge changes are needed for this follow-up.

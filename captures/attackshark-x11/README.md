# Attack Shark X11 fixtures

Reference material for the X11 path in `src/drivers/attackshark/hid.ts`.

Polled from one user's Windows machine (Firefox 157, OpenMouse webapp
`BETA · v2.0.c81` through OpenMouse Bridge, `ws://127.0.0.1:17846`) and posted
in [issue #161](https://github.com/OpenMouse-Project/mouse-protocol/issues/161).
The receiver is `0x1d57:0xfa60`; no serial string and no personal data are
included.

## What Bridge lists for the receiver

Seven collections are merged into one device, and every one of them reports no
feature report — the same rebuilt shape `captures/delux-m600-pro/windows-bridge.txt`
shows:

```
usage 0x1:6  feat[none]     usage 0x1:80 feat[none]
usage 0xc:1  feat[none]     usage 0xa:0  feat[none]
usage 0x1:2  feat[none]     usage 0xb:0  feat[none]
usage 0x1:6  feat[none]
```

The `0x0b` config collection therefore declares nothing, which is exactly the
`x11RebuiltConfigCollection` shape. No receiver message (`03 <model> 40 01
<pct>`) was captured in this session, so the status read returned
`settingsReady: false` and no battery.

## Why the X11 is enabled on this path

`X11_REBUILT_CONFIG_MODELS` accepts model id `0x55` on top of the
hardware-verified M600 Pro (`0x20`): the same receiver, protocol and rebuilt
transport, with the receiver's documented 56-byte DPI frame for `0xfa60`
(`x11UsesShortDpiReport` returns the long form). The write itself has not been
observed on X11 hardware yet — the reporter was asked to confirm DPI, polling
and battery on a build, per issue #161.

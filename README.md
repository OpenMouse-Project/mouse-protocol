# `@openmouse/protocol`

Transport-independent gaming mouse protocol codecs used by OpenMouse.

The package owns packet layouts, command constants, checksums, encoders,
decoders, protocol-specific value types, and device catalogs that are protocol
facts. It deliberately has no dependency on WebHID, browser APIs, timers, or
OpenMouse UI types, so browser, Node.js, and TypeScript projects can share it.

```ts
import { buildFinalmouseReport } from "@openmouse/protocol/finalmouse";
import { encodeRazerRequest } from "@openmouse/protocol/razer";
import { RAZER_PRODUCTS } from "@openmouse/protocol/razer-devices";
```

## Development

```sh
npm install
npm run check
```

The `prepare` script builds `dist` automatically when this package is installed
directly from Git. WebHID discovery, connection management, retries, and
conversion into application-facing mouse status remain in the OpenMouse app.

See [CONTRIBUTING.md](CONTRIBUTING.md) for protocol boundaries, hardware
evidence requirements, local OpenMouse integration, and the pull-request
checklist.

## Protocol entry points

| Brand | Import |
| --- | --- |
| ATK | `@openmouse/protocol/atk` |
| Endgame Gear OP1/XM2 8K | `@openmouse/protocol/endgame-gear-op1` |
| Endgame Gear wireless | `@openmouse/protocol/endgame-gear-we` |
| Finalmouse | `@openmouse/protocol/finalmouse` |
| Keychron | `@openmouse/protocol/keychron` |
| Lamzu | `@openmouse/protocol/lamzu` |
| Logitech | `@openmouse/protocol/logitech` |
| moddoMOUSE | `@openmouse/protocol/moddo` |
| Orbital | `@openmouse/protocol/orbital` |
| Pulsar | `@openmouse/protocol/pulsar` |
| Razer legacy/current | `@openmouse/protocol/razer` |
| Razer V4 | `@openmouse/protocol/razer-v4` |
| Teevolution | `@openmouse/protocol/teevolution` |
| VGN | `@openmouse/protocol/vgn` |
| WLMouse | `@openmouse/protocol/wlmouse` |

An exported protocol means OpenMouse implements that wire format. It does not
claim every mouse from that brand works. When a catalog provides a `verified`
field, use it to distinguish hardware-tested support from USB recognition.

# `@openmouse/protocol`

Transport-independent gaming mouse protocol codecs used by OpenMouse.

The package owns packet layouts, command constants, checksums, encoders,
decoders, protocol-specific value types, device catalogs, and the WebHID
drivers used by OpenMouse. Pure codec entry points do not depend on WebHID, so
browser, Node.js, and TypeScript projects can use them independently from the
optional driver layer.

```ts
import { buildFinalmouseReport } from "@openmouse/protocol/finalmouse";
import { encodeRazerRequest } from "@openmouse/protocol/razer";
import { RAZER_PRODUCTS } from "@openmouse/protocol/razer-devices";

import {
  createSupportedClient,
  SUPPORTED_HID_FILTERS,
} from "@openmouse/protocol/drivers";
```

## Development

```sh
npm install
npm run check
```

The `prepare` script builds `dist` automatically when this package is installed
directly from Git. Codec sources are grouped by brand under `src/`; WebHID
drivers, discovery filters, the driver registry, and shared status types live
under `src/drivers/`. OpenMouse retains application orchestration and UI code.

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

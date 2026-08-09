# Contributing to Mouse Protocol

Thank you for helping make gaming mouse hardware more open. This repository
contains the transport-independent protocol layer used by OpenMouse: packet
layouts, commands, checksums, encoders, decoders, protocol value types, and
device catalogs that describe wire-level capabilities.

## Before you start

For a new device or a substantial protocol change, open an issue or draft pull
request early. Include the mouse model, USB vendor and product IDs, connection
type, and what you have verified on real hardware. Early discussion helps avoid
duplicating reverse-engineering work and establishes where the transport and
protocol boundaries belong.

Only contribute material that you have permission to share. Do not commit
vendor binaries, proprietary source code, account information, device serial
numbers, or captures containing personal data.

## Development setup

Requirements:

- Node.js 20 or newer
- npm

Clone the repository and run:

```sh
npm install
npm run check
```

`npm run check` performs a strict TypeScript build and verifies the contents of
the npm package. Generated `dist/` files are not committed.

## What belongs here

Code belongs in this repository when it can work without knowing how bytes are
transported. Good examples include:

- report IDs, packet sizes, commands, status values, and offsets;
- checksums and packet framing;
- pure encoders and decoders;
- conversions between wire values and protocol-level values;
- product IDs and capabilities that determine which commands are valid.

Keep these concerns in the consuming application instead:

- WebHID discovery and permissions;
- opening devices and sending or receiving reports;
- retries, delays, queues, and connection recovery;
- application UI types, labels, notifications, or saved preferences.

Protocol functions should be deterministic wherever possible. Prefer functions
that accept bytes or plain values and return a new `Uint8Array`, object, or
primitive. Do not mutate caller-owned buffers unless the API explicitly says it
does so.

## Adding or changing a protocol

1. Add or update a focused module under the brand's `src/<brand>/` folder. Put
   genuinely shared wire framing under a protocol-family folder such as
   `src/compx/`, then re-export it through each applicable brand entry point.
2. Export new public APIs from a package subpath in `package.json`.
3. Add the module namespace to `src/index.ts` when it should be available from
   the package root.
4. Keep exported names vendor-specific when a generic name could collide. For
   example, prefer `razerSetDpiCommand` over `setDpiCommand`.
5. Build the package and integrate the packed API into OpenMouse.

Use `.js` extensions for relative imports in TypeScript source. The package uses
NodeNext module resolution and publishes ECMAScript modules.

Treat existing exports as a public API. Avoid renaming or changing their
meaning without explaining the migration and updating all known consumers.

## Evidence and hardware verification

Protocol changes should state where the information came from. Useful evidence
includes public documentation, links to compatible open-source drivers,
sanitized USB captures, and before/after observations from vendor software.
Clearly separate observed facts from hypotheses.

When a catalog has a `verified` field, set it to `true` only after that exact
product ID and connection path have been exercised on hardware. Recognizing a
USB ID or sharing a protocol family is not sufficient.

For write commands:

- begin with read-only discovery when possible;
- preserve unknown bytes during read-modify-write operations;
- validate ranges and packet lengths before encoding;
- verify writes by reading the value back;
- document whether a setting is volatile or stored in device memory;
- avoid speculative commands that could alter firmware or calibration data.

## Testing with OpenMouse

Behavioral protocol tests currently live beside their OpenMouse drivers. Check
out the `openmouse` and `mouse-protocol` repositories as siblings, then install
your local protocol build into OpenMouse without changing its manifest:

```sh
cd mouse-protocol
npm run build

cd ../openmouse
npm install --no-save --package-lock=false ../mouse-protocol
npm run check
```

Add or update focused tests in `openmouse/src/devices/<vendor>/`. Tests should
cover known captured packets, invalid or truncated replies, supported value
boundaries, and encode/decode round trips. A new product entry should also keep
OpenMouse's registry overlap tests passing.

Before submitting a protocol pull request, run both the package check and the
OpenMouse check against your local package.

## Pull requests

Keep a pull request focused on one protocol family or closely related change.
In its description, include:

- the device models, product IDs, firmware versions, and connection paths;
- what was tested on physical hardware;
- the evidence or public references supporting the packet format;
- any unknown fields or assumptions that remain;
- the matching OpenMouse pull request when application changes are required.

Before requesting review, confirm that:

- `npm run check` passes in this repository;
- OpenMouse builds and its full test suite passes with the local package;
- every new module is exported through the intended package subpath;
- no generated files, captures with identifiers, or unrelated changes are
  included.

Small, evidence-backed improvements are welcome even when a protocol is not yet
fully understood. Documenting an unknown accurately is better than assigning it
a guessed meaning.

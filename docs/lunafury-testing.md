# LunaFury support and testing

Packet definitions follow the public [LunaFury configurator](https://mouse.lunafury.games/)
and its `XviUpdater` implementation. Vendor scripts are not included.

## Devices

Runtime VID: `0x373e`. Bootloader identities are not supported here.

| Model | Cable PID | 8K receiver PID | DPI stages |
| --- | --- | --- | --- |
| LUNA33 | `0x0032` | `0x0033` | 1-6 |
| TYPE33 | `0x0054` | `0x0084` | 1-5 |

The shared Lamzu/CompX driver provides button polling, three onboard profiles,
DPI stage/count/X-Y controls, button mappings, sleep, 8K receiver lighting
and bottom-button power/DPI modes. Button polling is separate from USB polling.
Custom DPI colors are not exposed.

Bank operations are serialized. Writes verify readback and preserve dormant
DPI slots and reserved bytes. Complete DPI storage supports Games restoration;
it is not a saved or importable Games setting.

## Hardware verification

The owner verified LUNA33 firmware `0.0.26.0` over cable and 8K:

- Button polling, all three onboard profiles and DPI stage/count/X-Y controls.
- Mouse, scroll, DPI, media and keyboard mappings.
- Sleep/Never, reconnect readback and all four 8K receiver light modes.
  Cable connections do not expose receiver lighting.

TYPE33 and bottom-button behavior are not hardware-verified.
Games apply/restore has automated coverage only.

## Automated checks

Build, package checks and all 2,474 protocol tests pass, including both
exhaustive registry checks. The 162 Lamzu driver/codec tests also pass with
real timers. Coverage includes the four runtime PIDs, bank isolation, DPI storage,
write/read failures and retry recovery. Runtime audit reports no vulnerabilities;
development and release dependencies still have audit findings.

The paired app passes its build, 511 tests, bundle checks and audit with the local
protocol package. Games and manual Apply tests cover complete restoration,
untrusted status, write ordering and retained edits after failure.
Synthetic HID and Bridge callbacks do not replace hardware testing.

## Integration

Merge and publish the protocol before upgrading the app's exact npm dependency.
After pinning the published version, the app's `CI / check` job runs `npm ci`,
`npm run build`, `npm test`, `npm run size` and `npm audit --audit-level=high`
against registry-only dependencies. Local paired-package checks do not replace
this gate.
Both branches require upstream CI before merge.
See the [application setup](https://github.com/sekiranunn/openmouse/blob/codex/lunafury-onboard-controls/docs/lunafury-development.md).

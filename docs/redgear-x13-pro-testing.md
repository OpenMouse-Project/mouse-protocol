# X13 Pro hardware acceptance

Tested one owner-confirmed wired Redgear X13 Pro, USB 1B80:B412, Windows 11,
MECHREV Gaming Mouse / Jtech, on 2026-10-16. Firmware version is unknown.

| Feature | Observed acceptance |
|---|---|
| Identity / status | Exact interface 01 collection 03, feature 3, 40 native / 39 API bytes |
| DPI | Native and actual OpenMouse/Bridge 4000 -> 2400 -> 4000, full read-back |
| Polling | Native and actual OpenMouse/Bridge 1000 -> 500 -> 1000, full read-back |
| Static colour | Three native channel tests, owner observed red / blue-purple / green; exact read-back and restoration |
| Corrected RGB | Driver uses R,B,G; OpenMouse #00ff00 matched the observed green channel, then restored prior #00eaff |
| Buttons | Native and actual OpenMouse/Bridge Forward -> Back -> Forward; full report-4 hashes match targets/restoration |
| Primary click | Codec refuses to remove the only standard Left click assignment |
| Unknown / macro data | Entire report is preserved; unknown/macro records cannot be remapped |
| Physical reconnect | Owner unplugged five seconds and reconnected; report 3 matched pre-unplug, full report-4 hash unchanged |
| Avatar | Specific owner-requested transparent product rendering appears in the local app |
| Windows host controls | Native companion shows pointer/precision/scroll/page/double-click; documented APIs reapply existing values with identical read-back |
| Direct Edge WebHID | Opens but feature read fails; identity-only fallback disables settings |
| Transport | Official portable Bridge beta.15; isolated config, no saved profiles, updates/autostart off |

Twenty-one focused codec/client tests cover independent captures, framing/ranges,
queues, preservation, primary-click protection, unknown/macro protection, failures,
timeouts, mismatch lockout and disconnects. Full protocol check: 2504 passed.
App check: 383 passed. Source builds and native helper compilation pass.
CI uses mocked devices only; it does not claim physical USB access.

The reconnect test validates retention of the final restored settings. It does not
prove that every available value/action/effect has been exercised or that each
intermediate trial survives power loss. Only the observed cases above are claimed.

Vendor evidence came from approved original binaries under a write-denying API
guard. Simulated report-3 success let the vendor construct report 4 without any
USB writes. API arguments are not USB wire captures. Signed USBPcap 1.5.4.0 was
installed with approval, but the filter requires re-enumeration/restart and no wire
capture was obtained. No reboot or all-USB reset was performed. A guarded injected
UI copy crashed; later captures instrumented only the native HID helper. All vendor
research processes were stopped before physical trials. Only sanitized standard
records and full-report hashes are shared; user macros/raw report-4 data stay local.

Limitations: macros/M-Macro, six vendor host-profile tiles, additional animated
effects/brightness/speed and DPI indicator colour editing are not implemented.
Firmware/bootloader/DFU/calibration remain excluded. The overall verified flag
stays false; individual acceptance flags document working features precisely.

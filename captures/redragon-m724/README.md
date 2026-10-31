# Redragon M724 K1NG 1K (`04d9:fc7a`)

- `memory-dump.hex`: the settings memory `0x0000-0x04ff` read with `F2` before any test write; also the restore point.
- `writes.hex`: the write sequences tested on hardware, each with its observed effect.

Captured on Linux with a stdlib Python hidraw script (`HIDIOCSFEATURE` / `HIDIOCGFEATURE`) on interface MI_02. The memory map comes from static analysis of RDCfg.exe (sha256 `ddfab8823bec7c0c865325fc8c5f801a70f628391445c028deb43dc5f1dd7294`); see `docs/redragon-m724-testing.md`.

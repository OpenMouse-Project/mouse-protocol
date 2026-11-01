# MCHOSE L7 Pro+ captures

Feature-report traffic from MCHOSE's web driver against an L7 Pro+ (mouse
firmware 5.32.5.0, dongle firmware 5.7.6.0). One JSON array per action; `00`-`15`
are over the cable and `16`-`26` through the 2.4 GHz dongle.

Each event has `t` (ms), `kind` (`feature-out`, `feature-in` or `input`),
`reportId` and `hex`. Payload bytes are bit-inverted on the wire, as described
in `docs/mchose-protocol.md`. `feature-in` begins with the report id.

The profile 1 name in the `0x12 0x68` replies was replaced with `Profile 1`; the
factory names for profiles 2 and 3 are unchanged.
Used by `src/drivers/mchose/l7-pro-plus.test.ts`.

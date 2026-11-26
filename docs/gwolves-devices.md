# G-Wolves devices × exposed features

Every mouse OpenMouse recognizes, with the settings each driver exposes.
"R/W" = readable and writable; "R" = decoded into status, no writer yet.
"Vendor-only" lists what the official web driver (mouse.xyz,
`Config/env-models.json` AppVer 1.0.0.50) has and OpenMouse does not (yet).
VID is 0x33e4 throughout. Only the HTX Ultra pair, the HTX Mini 8K
receiver and the Fenrir pair (0x3508 / 0x3517) are hardware-verified; everything
else is recognition-grade.

## XVI:0 platform — GWolvesHidClient (`gwolves/hid`)

Base for every PID below: battery, firmware version, DPI stages
(50–26,000, driver cap — hardware goes to 32K/40K), polling 125–8000 Hz,
lift-off (Low/Medium/High labels; 5-step sensors capped to these three),
motion sync, debounce, sleep timeout, angle snapping, ripple control,
performance mode, button mapping (5 buttons; the key table's DPI slot stays
hidden like the vendor page). The wireless path for all of these is the
shared 0x3854 receiver; the wired PID identifies the mouse behind it
(MID 02–17, resolved live).

| Mouse | Wired PID | Max DPI (HW) | Buttons | OpenMouse state | Notes |
|---|---|---|---|---|---|
| HTX Ultra | 0x5618 | 26,000 | 5 | verified (wired + 0x3854 receiver) | — |
| HTS Plus Pro | 0x5219 | 40,000 | 5 magnetic | recognition-grade | trigger point, rapid trigger, calibration, live depth (wired only) |
| HTS Plus | 0x5418 / 0x5419 | 32,000 / 40,000 | 6 | recognition-grade | — |
| Lycan | 0x4718 / 0x4719 | 32,000 / 40,000 | 5 | recognition-grade | new model family |
| HTX Ultra (MID 07) | 0x5619 | 40,000 | 5 | recognition-grade | same name as verified 0x5618, newer revision |
| Fenrir Pro | 0x3619 | 40,000 | 6 | recognition-grade | wired only here; the 0x3617 receiver is xvi-new (below) |
| HTX Mini | 0x2719 | 40,000 | 6 | recognition-grade | — |
| WARG | 0x4219 | 40,000 | 5 | recognition-grade | new model family |
| HTX Mini Asym | 0x2619 | 40,000 | 6 | recognition-grade | new model family |
| Fenrir Asym | 0x3519 | 40,000 | 5 | recognition-grade | new model family |

Polling caps: 8000 Hz wired and wireless (shared 3854 receiver).

## XVI:1 old protocol — GWolvesXviHidClient (`gwolves/xvi-hid`)

Base: battery, firmware version, DPI stages (50–26,000), polling
(wired 1 kHz max; wireless by dongle — 8K: 8000, 4K: 4000, 1K: 1000),
lift-off (Low/High = 1/2 mm; the 30,000 DPI models add 0.7 mm, so
Low/Medium/High = 0.7/1/2 mm), sleep 30–600 s, debounce 0–80 ms, motion sync,
angle snapping, button mapping (5 buttons; HTS Plus / HTX / ACE models
expose a 6th DPI slot on the vendor page that this driver does not map
yet). No ripple control on any XVI model (matches the vendor page).

| Mouse | PIDs | Max DPI (HW) | Polling max | OpenMouse state |
|---|---|---|---|---|
| HTX Mini | 0x2708 / 0x2717 | 26,000 | 1000 wired / 8000 on 8K dongle | verified (0x2717 receiver) |
| VUK | 0x3908 / 0x3917 | 30,000 | 1000 wired / 8000 on 8K dongle | recognition-grade |
| HT-S2 | 0x7904 / 0x7913 | 26,000 | 1000 wired / 8000 on 8K dongle | recognition-grade |
| Fenir Max | 0x3708 / 0x3717 | 30,000 | 1000 wired / 8000 on 8K dongle | recognition-grade |
| HTS Ultra | 0x5308 / 0x5317 | 30,000 | 1000 wired / 8000 on 8K dongle | recognition-grade |
| HTR | 0x7704 / 0x7713 | 26,000 | 1000 wired / 8000 on 8K dongle | recognition-grade |
| HTR Pro | 0x7708 / 0x7717 | 26,000 | 1000 wired / 8000 on 8K dongle | recognition-grade |
| Fenrir | 0x3508 / 0x3517 | 30,000 | 1000 wired / 8000 on 8K dongle | verified (wired + 0x3517 receiver, firmware 1.0.39.0; sold as Fenrir Asym) |
| HT-S2 Pro | 0x7908 / 0x7917 | 30,000 | 1000 wired / 8000 on 8K dongle | recognition-grade |
| HSK Pro | 0x5808 / 0x5817 (+ 4K 0x5807) | 26,000 | 1000 wired / 8000 / 4000 on 4K | recognition-grade |
| HTS Plus | 0x5408 / 0x5417 (+ 4K 0x5407) | 26,000 | 1000 wired / 8000 / 4000 on 4K | recognition-grade |
| HTX | 0x5708 / 0x5717 (+ 4K 0x5707) | 26,000 | 1000 wired / 8000 / 4000 on 4K | recognition-grade |
| HSK Plus | 0x5908 / 0x5917 (+ 4K 0x5907) | 26,000 | 1000 wired / 8000 / 4000 on 4K | recognition-grade |
| HSK Lite | 0x7204 / 0x7203 | 26,000 | 1000 wired / 1000 (no 8K dongle) | recognition-grade |
| HSK Pro ACE | 0x5804 / 0x5803 (1K) | 26,000 | 1000 | recognition-grade |
| HTS Plus ACE | 0x5404 / 0x5403 (1K) | 26,000 | 1000 | recognition-grade |
| HTX ACE | 0x5704 / 0x5703 (1K) | 26,000 | 1000 | recognition-grade |
| HSK Plus ACE | 0x5904 / 0x5903 (1K) | 26,000 | 1000 | recognition-grade |

## XVI:1 new protocol — GWolvesXviNewHidClient (`gwolves/xvi-new-hid`)

Same 64-byte feature-report transport as XVI:1-old, but sensor commands
move to profile-addressed frames (`[2, len, class, cmd, profile, ...]`
with replies one slot later — decoded from the vendor bundle
`static/js/index-CQtWXKWS.js`, class `cm` with `isNewProtocol == "1"`).
Exposes firmware, battery, DPI stages (50–30,000) with the real on-device
stage table and active stage (fixed count), polling 125–8000 on
both paths, lift-off (Low/Medium/High = 0.7/1/2 mm), sleep, debounce,
motion sync, angle snapping, and plain-click/Disable remapping (decoded
from the vendor's action encoder; slots are 1-based for both reads and
writes — a 0-based write lands on the wrong button and reads back
unchanged, confirmed against live hardware on a Fenrir Pro 0x3617).
DPI/macros/media actions read back as Custom. Every setter re-reads and
throws on mismatch. Tracking / polling-info / angle-tune / hyper /
competitive / combine / DPI-XY toggles and RGB are not mapped yet.
Recognition-grade throughout — no xvi-new hardware has been tested.

| Mouse | Wired PID | Receiver PID | Max DPI | Polling max |
|---|---|---|---|---|
| HTM Plus | 0x3808 | 0x3817 (8K) | 30,000 | 8000 wired / 8000 on 8K dongle |
| HSK Pro 2.0 | 0x6808 | 0x6817 (8K) | 30,000 | 8000 wired / 8000 on 8K dongle |
| HTXU | 0x5608 | 0x5617 (8K) | 30,000 | 8000 wired / 8000 on 8K dongle |
| Fenrir Pro | 0x3608 | 0x3617 (8K) | 30,000 | 8000 wired / 8000 on 8K dongle |

## Vendor-only gaps (all platforms)

RGB lighting (only the four new-protocol models have it), sensor switch
(VUK), SPDT state, long-distance mode, sensor position/virtual position,
competitive-mode pages, angle-tune levels, macros beyond the mapped
buttons, DPI indicator, DPI-XY toggle, 8K-wired polling on new-protocol
models, and everything above the driver's 26K DPI cap.

## Not mapped

- **"TEST HTS Plus"** (wired 0x5428, wireless 0x3854): its own name marks
  it a dev/test entry, and its wireless id collides with the verified HTX
  Ultra receiver — deliberately skipped.

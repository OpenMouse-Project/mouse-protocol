# Hitscan application setting semantics

Static findings from captured `Hitscan Utility.exe`, SHA-256 `e96c658fe38eaeffe52494ace7eeb46adcbb820203c5f6acbdac98c70f7982f1`. Native image base is `0x140000000`. Evidence below is local LLVM disassembly plus shipped Qt metaobject strings and English XML; runtime behavior is not claimed. The companion `HID-CONFIG.md` supplies raw flash layout/checksums.

## Setting mapping

The application normalized structure starts at preferred global address `0x1403C50A0`. Its bytes match the normalized DLL layout.

| Feature | Normalized byte | Raw flash offset | Observed encoding and evidence |
| --- | --- | --- | --- |
| Polling rate | `0` | `0x00` | See complete table below; setter `0x14009F610` |
| DPI stage count | `1` | `0x02` | Setter `0x14009F4F0`; combined stage manipulation writes count = current-stage-index + 1 at `0x14009EFA9` |
| Current DPI stage | `2` | `0x04` | Zero-based index; combined writer at `0x14009EFA3` |
| LOD | `5` | `0x0A` | UI combo index + 1; `SensorLOD::on_LOD_currentIndexChanged` at `0x1400A4130` calls setter `0x14009F7F0`; Sensor duplicate at `0x14000F4C0`. Variant widget has explicit `mm1Button`/`mm2Button` |
| Debounce | `6` | `0xA9` | Integer milliseconds. Nine menu handlers write 0..8; labels are `0 ms`..`8 ms`, static file offsets `0x12DC90` onward. Handler sequence `0x1400AB660`, `AB6D0`, `AB740`, `AB7B0`, `AB820`, `AB890`, `AB900`, `AB970`, `AB9E0` calls setter `0x14009EEB0`. Other variants pass spinbox values directly via `0x1400AC3C0` |
| Motion sync | `7` | `0xAB` | Boolean 0/1; `MotionSync` Qt metaobject dispatch `0x1400E3520` -> `0x1400A1160` -> setter `0x14009F550`; duplicated Sensor handler `0x14000F590` |
| Angle snapping / straight line | `9` | `0xAF` | Boolean 0/1; named Sensor slot `on_StraightLine_clicked` routes `0x14000F690` -> setter `0x14009EB80`; setter stores `0x1403C50A9` at `0x14009EBC7` |
| Ripple control | `10` | `0xB1` | Boolean 0/1; named Sensor slot `on_RippeControl_clicked` routes `0x14000F670` -> setter `0x14009F670`; setter stores `0x1403C50AA` at `0x14009F6B7` |
| Auto sleep enable | `12` | `0xB5` | Boolean 0/1; named slot `on_Performance_clicked` routes `0x14000F650` -> setter `0x14009F730`, storing `0x1403C50AC`. Shipped English XML explicitly translates `Performance` as `Auto Sleep` |
| Auto sleep selection | `13` | `0xB7` | See raw value table below; `on_PerformanceOpen_currentIndexChanged`, handler `0x14000F5B0` -> setter `0x14009F790` |
| Sensor mode selection | `14` | `0xB9` | `on_ModelChoose_currentIndexChanged` at `0x14000F570` forwards index except index 2; boolean `on_ModeSelectCheck_toggled` at `0x14000F540` writes 0/1 via setter `0x14009F6D0`. XML describes LP, HP, corded modes, but the exact device-specific mapping needs UI population tracing |

These links are stronger than names alone: Qt's `Sensor` stringdata includes named slots and its static metacall at `0x1400DDDF0` routes each method index to the listed handler. For example, calls at `0x1400DDF3C`, `DDF4F`, `DDF60`, `DDF71`, and `DDF82` route Auto Sleep, sleep selection, ripple control, angle snapping, and Motion Sync respectively.

Remaining normalized bytes `3`, `4`, `8`, and `11` have setter functions but their application feature semantics are not yet established in this pass. Do not assign semantics from defaults alone.

## Polling enum

| Hz | Raw value |
| --- | --- |
| 125 | `0x08` |
| 250 | `0x04` |
| 500 | `0x02` |
| 1000 | `0x01` |
| 2000 | `0x10` |
| 4000 | `0x20` |
| 8000 | `0x40` |

Qt metaobject class `SensorRate` has methods `on_Button125HZ_clicked`, `on_Button250HZ_clicked`, `on_Button500HZ_clicked`, `on_Button1000HZ_clicked`, `on_Button2000HZ_clicked`, `on_Button4000HZ_clicked` in this order (file strings `0x364EA8` onward). Its static metacall `0x1400E43E0` selects handlers `0x1400B05E0`, `B0660`, `B06E0`, `B05A0`, `B0620`, `B06A0`; each calls `0x14009F610` with the table's constant. Class `SensorRateB` adds named 8000 Hz method, dispatched to `0x1400B3120`, which writes `0x40`. This establishes application encoding, not device support for every listed rate.

## Sleep values

`0x14000F5B0` maps dropdown indices to raw `0xB7` values:

| UI index | Raw value |
| --- | --- |
| 0 | 3 |
| 1 | 6 |
| 2 | 30 |
| 3 | 60 |
| 4 | 90 |
| 5 | 120 |
| 6 | 150 |
| 7 | 180 |
| 8 | 210 |
| other (fallback) | 240 |

Do not assume these are seconds. The English XML's `PerformanceOpen` translations enumerate `10 sec`, `30 sec`, `1 min`, `2 min`, `5 min`, `10 min`, `15 min`, `30 min`, `45 min`; this does not agree with a single obvious conversion from the code's numeric table. The numeric writer is established, while actual UI population/translation use and device timing need confirmation. Exposing raw values with explicit known/unknown mapping is preferable to inventing a duration formula.

## DPI encoding entry point

`0x14000EC70(stageIndex, requestedDpi)` writes DPI for a selected stage. The destination setter `0x14009EC40(stageIndex,xByte,yByte,flags)` stores three bytes at normalized `0x0F+6*stageIndex`, which become raw flash record `0x0C+4*stageIndex`.

The application can select between table-based sensor encoding and a linear path. It reads sensor/model-dependent table globals and existing stage flags; therefore a single formula must not be generalized to every sensor.

The clear linear path at `0x14000F04F` computes:

```
encoded = trunc(requestedDpi / (scale * 50)) - 1
```

`scale` (R14D) initially equals 1, with earlier model/table branches able to change it. If the sensor string equals `3395`, the code adds high bits into the flag byte:

```
high = encoded >> 8
flags |= ((high << 4) | high) << 2
```

Then `0x14000F088..0x14000F094` calls the setter with `(stageIndex, encoded, encoded, flags)`, which stores the low 8 bits of each X/Y argument and the low 8 bits of flags. For the uncomplicated scale=1, baseFlags=0 branch, this yields:

```
n = dpi / 50 - 1
xByte = yByte = n & 255
flags = ((n >> 8) * 0x44) & 255
raw = [xByte, yByte, flags, (0x55-xByte-yByte-flags)&255]
```

The flags extension is verified at `0x14000F075..0x14000F085`. Existing stage flag mask `0x22` also participates in selecting a 50/100 divisor near function start (`0x14000ECAD..0x14000ECD8`); the fallback linear path subsequently recomputes the encoded integer using its selected scale. The complete REA decompilation is now preserved in `native/0x14000ec70.c` and `.json`.

At `0x14000ED74..0x14000ED9C`, other table cases choose scale 4/baseFlags `0x33`, scale 2/baseFlags `0x11`, or scale 2/baseFlags `0x22`. These are not independent axis bits proven solely from these instructions; avoid assuming them interchangeable with the 3395 high-bit extension.

### Final shipped-model 3395 codec

The decoded shipped `usersetting/Config.ini` selects sensor `3395` for both MID 1 and MID 2 and gives each `DPIRange=50,4050,50,4100,26000,50,0x11`. In the complete `0x14000EC70` decompilation (REA Evidence `ev_dd5f76375898932cdc262e9fda6aa1d9908724bc6cab6d1ab78628d4132b903c`), mode `0x11` selects scale 2/baseFlags `0x11` only when the requested DPI exceeds the first range endpoint (4050); otherwise scale is 1 and baseFlags zero. The shipped sensor header has no `SENSOR_3395_DPI_*` table entries, so this model uses the linear fallback. The resulting equal-axis encoder is:

```
scale = dpi > 4050 ? 2 : 1
n = floor(dpi / (scale * 50)) - 1
lo = n & 255
flags = (scale == 2 ? 0x11 : 0) | ((n >> 8) * 0x44)
record = [lo, lo, flags, (0x55 - lo - lo - flags) & 255]
effectiveDpi = (n + 1) * scale * 50
```

Although the configuration advertises a 50-DPI step throughout, the app's code quantizes requests above 4050 to 100-DPI values. For example 4100 and 4150 both serialize as `[0x28,0x28,0x11,0xF4]` and decode canonically to 4100. At the high-bit boundary, 25600 -> `[FF,FF,11,46]`, 25700 -> `[00,00,55,00]`, and 26000 -> `[03,03,55,FA]`. This is recovered application behavior, not hardware-tested precision.

`src/hitscan/settings.ts` implements this encoder with an explicit `{record,effectiveDpi}` return value. It also exports the exact representable equal-axis value list (50..4050 by 50, then 4100..26000 by 100), a canonical decoder that rejects unknown/unequal-axis records, and the named polling-rate enum. Focused tests cover threshold transitions, quantization, high bits, checksums, invalid input, and every advertised exact value; TypeScript checking passes.

## Useful further decompilation targets

- `0x14000EC70..0x14000F0B1`: complete stage DPI encoding and per-sensor table handling.
- `0x1400324F0..0x140035C2F`: large DPI handler containing multiple `3395` references, likely multiple axis/stage update branches.
- `0x14002B4F0..0x14002B860`, `0x140030DE0..0x14003103A`: sensor table/capability handling with `3395` string references.
- `0x14000A9F0..0x14000CAAC`: Sensor UI refresh, including normalized settings consumption and per-sensor UI selection.

The identities above were recovered from PE exception ranges (`.pdata` at raw `0x3C3600`) and static RIP references. Main `.rdata` string RVAs equal raw file offsets plus `0xC00`. Qt stringdata header for `Sensor` is raw `0x35C550`; its `staticMetaObject` references a static metacall pointer at raw `0x3C1D58` for `SensorLOD` and corresponding per-widget objects in `.data`. These are build-specific analysis anchors, not runtime discovery heuristics.

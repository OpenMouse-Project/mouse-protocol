# AULA SC380 Pro

The 2.4 GHz receiver (`258a:0138`) uses feature report 9 on usage
`0xff02:0x02`. AULA's official SC380 PRO utility lists `258a:0136` for
the USB cable. Only the receiver is registered because it was the path tested
on hardware.

The [official driver download](https://www.aulastar.com/drive/list_28_10/)
contains the USB IDs, the six-byte model signature and the default PAW3311
DPI stages. Static inspection of the utility identified these commands, all
verified against a receiver on Windows:

| Command | Argument | Length | Purpose |
| --- | --- | --- | --- |
| `05` | `01` | 6 | Read the model signature `04 00 00 00 00 2e` |
| `07` | `00` | 1 | Read the mouse link (1 when linked) |
| `09` | `01` | 1 | Read battery percentage |
| `44` | `00` | 400 | Read settings |
| `04` | `00` | 400 | Write settings |

Native feature reports have an eight-byte header followed by data and
padding to 520 bytes. The outgoing checksum is the sum of bytes 2 onward,
modulo 256. The short replies echo the header checksum. The settings reply includes
its data in the checksum. The driver checks the reply command, argument,
length, settings checksum and model signature before writing.

Settings byte 2 stores the polling code in its low nibble (1–4 for 125,
250, 500 and 1000 Hz). Byte 3 stores the active stage in the upper nibble
(one-based) and the stage count in the lower nibble. The X and Y DPI tables
start at bytes 7 and 27. Each entry is a little-endian 16-bit value, with
`DPI = (value + 1) × 100`. The driver changes only the requested fields
and reads the settings back to verify them. Hardware checks changed the
polling rate, active stage and independent DPI axes and restored the
original settings. Persistence through a power cycle was not tested.

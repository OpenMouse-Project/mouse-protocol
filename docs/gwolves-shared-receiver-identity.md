# G-Wolves shared receiver identity

The Fenrir Pro ticket reports `HID\VID_33E4&PID_3854&REV_0502&MI_00` over
2.4 GHz with Bridge beta.14. PID `3854` is shared by multiple G-Wolves mice;
it does not identify an HTX Ultra by itself.

G-Wolves' live [mouse.fit configuration](https://mouse.fit/Config/env-models.json)
and [mouse.xyz configuration](https://mouse.xyz/Config/env-models.json), inspected
on 2026-10-08, list the report-8 (`XVI=0`) models' decimal `MID` values. Fenrir
Pro is MID 9 (wired PID `3619`, shared wireless PID `3854`). HTXU/HTX Ultra
uses MID 5 or 7; HTS Plus Pro uses MID 11 and is the magnetic model.

The existing report-8 driver already asks the receiver for its model during
magnetic-control detection. This fix uses the same cached reply for the name,
default display name, polling note and errors. It adds no handshake or settings
write and preserves the existing magnetic gate. Unknown or unavailable model
IDs show the generic receiver name rather than claiming an HTX Ultra.

This does not mark Fenrir hardware as verified or enable its older XVI-new
variant (`3608`/`3617`). That is a separate protocol from the ticket's shared
receiver path.

The pasted OMK1 profile decodes completely to:

```json
{"v":1,"brand":"G-Wolves","name":"G-Wolves HTX Ultra","dpi":400,"pollingRateHz":4000,"liftOffDistance":"Low"}
```

It contains no USB VID/PID and is not a hardware-identity report. The Hardware
Ids string is the useful transport evidence in this ticket.

After the new protocol version is adopted by the panel, the reporter should
reconnect the 2.4 GHz receiver, confirm Fenrir Pro in the header and a newly
exported profile, and confirm DPI/polling values still read normally. If an
old OMK1 key carries the wrong HTX Ultra name, export a fresh key after the fix;
the old key has no hardware identifiers with which to migrate that name.
If the generic receiver name remains, attach Diagnostics so the handshake reply can
be inspected. The physical receiver has not been tested in this change.

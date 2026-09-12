# Microsoft Intellimouse Series: Protocol and Windows Limitations

This document explains the internal USB HID protocol used by the Microsoft Classic Intellimouse and Microsoft Pro Intellimouse, and details the technical reasons why reading device status natively via WebHID is restricted on Windows.

## Protocol Overview

Both the Classic and Pro Intellimouse models use a unified command structure for interacting with the device's properties (DPI, Polling Rate, Lift-Off Distance, Lighting).

### Writing Data
Writes are performed by sending a **Feature Report** (Report ID `0x24`). The payload consists of:
1. **Property ID** (e.g., `0x96` for DPI Write, `0xB2` for Color Write)
2. **Length Byte** (Number of data bytes to follow)
3. **Data Payload**

### Reading Data
Reading data is a two-step asynchronous process:
1. **Request:** Send a Feature Report (Report ID `0x24`) with the Read Property ID (e.g., `0x97` for DPI Read, `0xB3` for Color Read) and a Length Byte of `0x01`.
2. **Response:** The mouse responds with the requested data on Report ID `0x27`. 

While writes work flawlessly across all operating systems via WebHID, reads present significant challenges exclusively on Windows due to strict OS and browser-level security policies.

---

## The Classic Intellimouse Limitation

The Classic Intellimouse binds to a standard **Consumer Control collection** (`0x0C:0x01`).

When a read request is dispatched, the Classic Intellimouse fulfills the response by streaming an **Input Report** back to the host. 

**The Windows Block:**
For security reasons (primarily to prevent malicious applications from intercepting media keys or acting as keyloggers), Windows completely blocks raw access to `inputreport` events originating from Consumer Control and Keyboard collections. 

Because the Classic Intellimouse resides on this restricted collection, the WebHID `inputreport` event is swallowed by the OS and never reaches the browser. 
* **Linux Behavior:** Linux does not enforce this restriction, so `inputreport` events arrive with the data intact, allowing perfect reads.

---

## The Pro Intellimouse Limitation

To avoid the Consumer Control restrictions, the Pro Intellimouse cleverly operates on a **Vendor-Specific collection** (`0xFF07:0x0212`). This successfully prevents the OS from blocking its input reports. However, it introduces a new, insurmountable limitation caused by a firmware quirk.

In the Pro's USB device descriptor, Report ID `0x27` is explicitly declared as an **Input Report** (not a Feature Report).

When a read request is dispatched, two things happen:
1. The mouse fires an `inputreport` event for `0x27`. However, this payload is strictly an **acknowledgment**. It echoes the Property ID and Length, but the actual data bytes are zeroed out (e.g., `97 02 00 00` instead of the actual DPI).
2. The **actual** settings data is exclusively loaded into the response buffer of a `GET_REPORT` USB control transfer.

**The Windows Block:**
To retrieve the actual data, we must request a `GET_REPORT` via WebHID's `receiveFeatureReport(0x27)` method. 
However, Chrome's WebHID implementation on Windows strictly validates requests against the device descriptor. Because the descriptor labels `0x27` as an Input Report, Chrome refuses to issue a Feature Report request for it, throwing a `NotSupportedError`.

* **Linux Behavior:** Chrome on Linux is more lenient regarding descriptor mismatches. It allows the `receiveFeatureReport(0x27)` call to proceed, successfully retrieving the actual data from the control pipe.

---

## The WebHID Workaround

Because these limitations stem from unchangeable device firmware and strict OS/Browser security implementations, a pure WebHID workaround for reading data on Windows is impossible.

To ensure a seamless user experience, the OpenMouse WebHID driver catches these Windows-specific read failures (either via timeouts for the Classic or caught exceptions for the Pro) and supplies default "dummy" data. This ensures the UI successfully loads and allows the user to continue writing/configuring their mouse.

## The Native Desktop App Workaround

While WebHID restricts access, native desktop applications (like the OpenMouse Desktop App) can bypass these restrictions using a loophole in the Windows HID API.

On Windows, the standard `ReadFile()` system call is blocked for System Mouse and Consumer Control collections. However, the `HidD_GetInputReport` API—which issues a raw USB Control Transfer (Endpoint 0) instead of reading from the interrupt pipeline—is **not** blocked by the OS.

Because both the Classic and Pro IntelliMouse firmware correctly respond to a Control Transfer request for their Input Reports, the OpenMouse Desktop app implements a custom `receiveInputReport()` method that leverages `HidD_GetInputReport`. By aggressively polling this method, the Desktop app successfully retrieves the true device status for both mice on Windows entirely in user-mode, without requiring administrator privileges or custom kernel drivers.
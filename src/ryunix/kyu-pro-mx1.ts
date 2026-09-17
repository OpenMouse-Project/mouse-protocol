export interface KyuProMx1Report {
  reportId: number;
  buttons?: number;
  x?: number;
  y?: number;
  batteryLevel?: number;
  isCharging?: boolean;
  dpiStage?: number;
  isActive?: boolean;
  pollingRateHz?: number;
  ledModeCode?: number;
}

/**
 * Pure decoder for the Kyu Pro MX1 model, supporting both motion and telemetry reports.
 */
export function decodeKyuProMx1Report(data: Uint8Array, reportId: number): KyuProMx1Report {
  if (reportId === 0x04) {
    // Depending on whether data[0] is the reportId or the active byte, 
    // let's look at the byte sequence: [04, active, dpi, polling, battery, charging, ledMode]
    // If data starts directly with the active flag (reportId stripped by browser event):
    const isActive = data[0] === 0x01;
    const dpiStage = data[1];
    const pollingByte = data[2];
    const batteryLevel = data[3];
    const isCharging = data[4] === 0x01;
    const ledModeCode = data[5];

    const pollingMap: Record<number, number> = {
      0x08: 125,
      0x04: 250,
      0x02: 500,
      0x01: 1000,
    };

    return {
      reportId: 0x04,
      isActive,
      dpiStage,
      pollingRateHz: pollingMap[pollingByte] ?? 1000,
      batteryLevel,
      isCharging,
      ledModeCode,
    };
  }

  // Standard mouse movement packet (Report ID 1)
  return {
    reportId: reportId,
    buttons: data[0],
    x: data[1] | (data[2] << 8),
    y: data[3] | (data[4] << 8),
  };
}
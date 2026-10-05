import type { MagneticCalibrationProgress } from "./mouse-types.ts";

/** What a driver offers when its mouse has magnetic buttons (see `MouseStatus.magneticButtons`). */
export interface MagneticButtonClient {
  /** Button 0 is the left click, 1 the right click. */
  setMagneticTriggerPoint(button: 0 | 1, point: number): Promise<number>;
  setMagneticRapidTrigger(button: 0 | 1, enabled: boolean, level: number): Promise<{ enabled: boolean; level: number }>;
  /** Null makes the release follow the trigger point. Absent when the mouse has no release travel. */
  setMagneticReleasePoint?(button: 0 | 1, point: number | null): Promise<number | null>;
  /** Absent when the mouse has no optical switch to fall back on. */
  setMagneticSwitchTypes?(types: readonly ["magnetic" | "optical", "magnetic" | "optical"]): Promise<void>;
  /** Absent when the mouse cannot be calibrated from here. Rejects with the reason on failure. */
  calibrateMagneticButtons?(onProgress: (progress: MagneticCalibrationProgress) => void, signal?: AbortSignal): Promise<void>;
  /** Live press depth, 0 to 100 per button, for mice that stream it. */
  onButtonDepth?(listener: (left: number, right: number) => void): () => void;
}

export function isMagneticButtonClient(client: unknown): client is MagneticButtonClient {
  const candidate = client as Partial<MagneticButtonClient> | null;
  return typeof candidate?.setMagneticTriggerPoint === "function"
    && typeof candidate.setMagneticRapidTrigger === "function";
}

/**
 * Optional UI policy from a driver (used by control.ts).
 * Drivers added in a PR should set only the flags they need so the shell
 * stays free of brand-specific branching.
 */
export interface MouseUiHints {
  /** Stable driver id, e.g. "egg-we". */
  family?: string;
  /** When false, core settings grid stays hidden. Default true. */
  settingsReady?: boolean;
  /**
   * DPI and polling in this status were read from the mouse rather than filled
   * in, so they are worth reporting even while `settingsReady` hides the grid.
   */
  valuesVerified?: boolean;
  /** Hide the Low LOD option. */
  hideLodLow?: boolean;
  /** Disable LOD controls while gamingSurfaceMode is "Off". */
  lodRequiresSurface?: boolean;
  /** Hide poll rates not listed in supportedPollingRates. */
  hideUnsupportedPollingRates?: boolean;
  /** Show the polling rate the mouse reports, but refuse to stage a change. */
  pollingReadOnly?: boolean;
  /** Hide Motion Sync / angle snap / ripple card. */
  hideProcessingCard?: boolean;
  /** Hide Motion Sync while leaving other processing controls available. */
  hideMotionSync?: boolean;
  /** Hide angle snapping while leaving other processing controls available. */
  hideAngleSnapping?: boolean;
  /** Hide ripple control while leaving other processing controls available. */
  hideRippleControl?: boolean;
  /** Hide the receiver signal-strength card when no command reports link quality. */
  hideSignalCard?: boolean;
  /** Hide auto-sleep when this protocol generation does not expose it. */
  hideSleepCard?: boolean;
  /**
   * Render the advanced settings section for a driver outside the brands that
   * open it by default. The section is the only place the signal, debounce,
   * sleep and processing cards live, so a driver that fills one of them stays
   * invisible without this. Set it only when a card in there will show.
   */
  showAdvancedSection?: boolean;
  /** Always show battery column (even wired with null %). */
  forceShowBattery?: boolean;
  /**
   * Extra sentence appended to the connected status line, for drivers whose
   * connection is deliberately limited (e.g. why settings are unavailable).
   */
  statusNote?: string;
  /** Override the polling-rate footnote. */
  pollingNote?: string;
  /** Sidebar name before first status read. */
  defaultDisplayName?: string;
  /**
   * Simple multi-stage DPI editor in the Sensitivity card (single-axis stages).
   * Distinct from Logitech onboard slots and Endgame CPI tiles. When set with
   * `dpiStages` on the status, the shared stage list is shown.
   */
  dpiStageEditor?: {
    /** Highest number of stages the mouse can enable. */
    maxStages: number;
    /** When false, stage count is fixed and the count picker is hidden. */
    countEditable?: boolean;
    minDpi: number;
    maxDpi: number;
    stepDpi: number;
  };
}

/**
 * A lighting zone a driver can write effects to. The mouse may not be able to
 * report its current effect back (Razer's effect commands are writes without a
 * matching read), in which case `writeOnly` marks that `mode` and friends come
 * from the driver's own last-write cache rather than the hardware.
 */
export interface MouseLighting {
  /** Label for the lit zone, e.g. "Logo". */
  zone: string;
  /** Effects the driver can write, in display order. */
  modes: readonly MouseLightingMode[];
  /** Effect currently selected; null before any value is known. */
  mode: MouseLightingMode | null;
  /** Base colour "#rrggbb". */
  color: string | null;
  /** Second colour for two-colour effects "#rrggbb". */
  color2: string | null;
  /** Effects that use the single colour picker. */
  colorModes: readonly MouseLightingMode[];
  /** Effects that use the second colour picker. */
  dualColorModes: readonly MouseLightingMode[];
  /** Effects that use the reactive speed picker. */
  reactiveModes: readonly MouseLightingMode[];
  /** Reactive speed levels the driver understands. */
  speeds: readonly number[];
  /** Reactive speed currently selected. */
  speed: number | null;
  /** Optional brightness percentage for zones that expose it. */
  brightness?: number | null;
  /** Brightness percentages the device accepts. */
  brightnessLevels?: readonly number[];
  /** True when the mouse cannot report the effect back (Razer effect writes). */
  writeOnly?: boolean;
  /** HID++ per-key/per-LED zone id when this is a directly painted RGB cell. */
  hardwareZoneId?: number;
  /** Lets the UI group individually painted cells into one physical surface. */
  group?: string;
}

export type MouseLightingMode =
  | "Off"
  | "Static"
  | "Cycling"
  | "Wave"
  | "Spectrum"
  | "Reactive"
  | "Breathing random"
  | "Breathing single"
  | "Breathing dual";

export interface MouseStatus {
  brand: "Logitech" | "Pulsar" | "Endgame Gear" | "WLMouse" | "G-Wolves" | "Lamzu" | "CRDRAKO" | "Attack Shark" | "Orbital" | "Razer" | "Teevolution" | "ATK" | "VGN" | "Finalmouse" | "Keychron" | "moddoMOUSE" | "Ninjutso" | "Zaunkoenig" | "Fantech" | "Wooting" | "WALLHACK" | "SteelSeries" | "Glorious";
  name: string;
  /** Driver-supplied UI policy (optional; keeps control.ts brand-agnostic). */
  ui?: MouseUiHints;
  batteryPercent: number | null;
  batteryVoltageMv?: number | null;
  batteryState: "Charging" | "Charging slowly" | "Almost full" | "Full" | "Discharging" | "Unknown";
  dpi: number;
  dpiY?: number;
  supportsSeparateDpiAxes?: boolean;
  /** Hall-effect primary-button tuning exposed by Logitech's 0x1B0C HID++ feature. */
  analogButtonTuning?: {
    maxActuation: number;
    maxRapidTrigger: number;
    maxHaptics: number;
    buttons: Array<{ actuation: number; rapidTrigger: number; haptics: number }>;
  };
  pollingRateHz: number;
  supportedPollingRates?: number[];
  activeProfile: number | null;
  deviceMode?: "Onboard" | "Host" | "Unknown";
  unitId?: string | null;
  modelId?: string | null;
  transportIds?: Record<string, string>;
  connectionType?: "Wired" | "Wireless";
  connectionDetail?: string;
  /** Zaunkoenig exposes the USB link mode as part of its packed configuration. */
  usbSpeed?: "Full" | "High";
  /** Physical button which sends the primary/left-click action. */
  primaryButton?: "Left" | "Right";
  dongleLedEnabled?: boolean | null;
  finalmouseDongleLedMode?: number | null;
  finalmouseTournamentScrollMode?: number | null;
  finalmouseTournamentScrollTimeoutMs?: number | null;
  signalStrength?: number | null;
  motionSync?: boolean | null;
  /** On-device DPI stages, where supported (Teevolution, Ninjutso, …). */
  dpiStages?: number[];
  /** Active DPI stage index into `dpiStages` (0-based). */
  activeDpiStage?: number;
  ninjutsoSystemMode?: "High Speed" | "Competitive" | "Ultra" | null;
  ninjutsoSystemModes?: Array<"High Speed" | "Competitive" | "Ultra">;
  ninjutsoHyperClick?: boolean | null;
  ninjutsoOpticalEngine?: "Standard" | "Burst" | null;
  ninjutsoSlamClick?: "Low" | "Medium" | "High" | null;
  debounceMs?: number | null;
  sleepTimeout?: number | null;
  angleSnapping?: boolean | null;
  rippleControl?: boolean | null;
  slamclickFilter?: boolean | null;
  motionJitterFilter?: boolean | null;
  leftSpdtMode?: "Off" | "GX Safe" | "GX Speed" | null;
  rightSpdtMode?: "Off" | "GX Safe" | "GX Speed" | null;
  eggCpiLevels?: number;
  eggCpiStages?: Array<{ x: number; y: number }>;
  eggPollingDivider?: number;
  eggMulticlickFilters?: number[];
  eggButtonMappings?: string[];
  /**
   * Every shipped Razer control's current state, keyed by control name — the
   * four cross-assignable `RazerButtonControl`s and the three two-state
   * `RazerToggleControl`s share one dict, since each family's renderer
   * iterates its own fixed control list and the two lists share no control
   * names. Undefined on a model that has not been confirmed to support the
   * class `0x02` write at all. A control whose reply the driver cannot decode
   * (a keyboard shortcut, Hypershift data, an index nothing here knows) is
   * omitted rather than guessed at.
   */
  razerButtonMappings?: Record<string, string>;
  /** Keychron Nape Pro user layer currently running on the device (1–8).
   * Matches firmware get/set. Undefined when the layer commands were not answered.
   */
  napeLayer?: number;
  /** How many Nape onboard layers VIA reported. Undefined when unread. */
  napeLayerCount?: number;
  performanceMode?: boolean | null;
  hyperMode?: boolean | null;
  /** Sensor pinned to its highest frame rate (WLmouse "Turbo Mode"). */
  turboMode?: boolean | null;
  /** Whether button chords can change mouse settings without the driver. */
  buttonCombination?: boolean | null;
  sensorMode?: "Eco" | "High" | "Ultra" | null;
  sensorModeStored?: 0 | 1 | null;
  sensorModeEditable?: boolean | null;
  performanceDuration?: number | null;
  angleTuning?: number | null;
  wheelAcceleration?: boolean | null;
  lowBatteryWarning?: number | null;
  remoteLedMode1?: number | null;
  remoteLedMode2?: number | null;
  dpiLedMode?: number | null;
  dpiLedBrightness?: number | null;
  dpiLedSpeed?: number | null;
  liftOffDistance: "Low" | "Medium" | "High" | null;
  /** Explicit LOD choices when a mouse does not support all three common levels. */
  supportedLiftOffDistances?: Array<NonNullable<MouseStatus["liftOffDistance"]>>;
  /**
   * Separate cut-off and re-engage heights, where a mouse offers them instead
   * of the single three-stop `liftOffDistance`. Only drivers that have verified
   * it on hardware populate this; everywhere else it stays undefined and the
   * control does not appear.
   *
   * `enabled` is which of the two the mouse is actually using, and may be null
   * when a driver cannot establish it.
   */
  asymmetricLiftOff?: {
    enabled: boolean | null;
    liftOff: number;
    landing: number;
    liftOffRange: { min: number; max: number };
    landingRange: { min: number; max: number };
  } | null;
  /** Logitech onboard profile format (HID++ 0x8100), which selects the layout. */
  onboardProfileFormat?: {
    id: number;
    name: string;
    base: string;
    supported: boolean;
    /** False when the layout comes from vendor code but was never confirmed on hardware. */
    verified: boolean;
    /** False until profile-content writes were applied and restored on hardware. */
    writable: boolean;
  } | null;
  /** Logitech 0x19B0 haptic strength, 0-100. Null when the device has no haptics. */
  /**
   * Logitech 0x2111 byte 0 — the wheel's ratchet mode, the same thing the
   * button behind the wheel toggles. Not SmartShift on/off.
   */
  wheelMode?: "Freespin" | "Ratchet" | null;
  /**
   * Logitech 0x2111 byte 1. 255 disables SmartShift; any lower value enables
   * it and sets how gentle a flick releases the ratchet.
   */
  smartShiftThreshold?: number | null;
  /** Logitech 0x2121 — high-resolution (smooth) scrolling. */
  hiResScroll?: boolean | null;
  invertScroll?: boolean | null;
  supportsInvertScroll?: boolean;
  /** Live read of whether the wheel is currently ratcheted. */
  wheelRatchetEngaged?: boolean | null;
  /** Logitech 0x2150 — the horizontal thumb wheel. */
  thumbWheelInverted?: boolean | null;
  supportsThumbWheelInvert?: boolean;
  /** Logitech 0x0007 — the editable name, distinct from the fixed device name. */
  friendlyName?: string | null;
  friendlyNameMaxLength?: number | null;
  /** Logitech 0x1815 — Easy-Switch slot count, or null without the feature. */
  hostCount?: number | null;
  /** Zero-based active slot; the button under the mouse counts from one. */
  currentHost?: number | null;
  /** One entry per slot, true when a computer is paired to it. */
  hostSlotsPaired?: boolean[] | null;
  hapticIntensity?: number | null;
  /** Logitech 0x19B0 byte 0 bit 0 — haptic feedback on or off. */
  hapticEnabled?: boolean | null;
  /** Logitech 0x19B0 byte 0 bit 1 — the device's own haptic battery saver. */
  hapticBatterySaving?: boolean | null;
  gamingSurfaceMode?: "On" | "Off" | "Auto" | null;
  lightforceSwitchMode?: "Hybrid" | "Optical" | null;
  /** Razer lighting zones. */
  lighting?: MouseLighting;
  /** Independently addressable lighting zones. `lighting` remains the first zone for compatibility. */
  lightingZones?: MouseLighting[];
  firmware: string[];
}

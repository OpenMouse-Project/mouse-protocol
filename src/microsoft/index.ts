export const MICROSOFT_VENDOR_ID = 0x045E;

export const MICROSOFT_PRODUCTS: ReadonlySet<number> = new Set([
  0x082A, // Pro Intellimouse
  0x0823, // Classic Intellimouse
]);

export const REPORT_ID_WRITE = 0x24;
export const REPORT_ID_READ = 0x27;

export const PROPERTY_DPI_WRITE = 0x96;
export const PROPERTY_DPI_READ = 0x97;

export const PROPERTY_COLOR_WRITE = 0xB2;
export const PROPERTY_COLOR_READ = 0xB3;

export const PROPERTY_POLLING_WRITE = 0x83;
export const PROPERTY_POLLING_READ = 0x84;

export const PROPERTY_DISTANCE_WRITE = 0xB8;
export const PROPERTY_DISTANCE_READ = 0xB6;

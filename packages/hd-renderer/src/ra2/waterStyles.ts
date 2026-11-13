export const WATER_STYLES = ['classic', 'enhanced', 'clear', 'faithful', 'muted', 'calm'] as const;
export type WaterStyle = (typeof WATER_STYLES)[number];
export function parseWaterStyle(value: string | null): WaterStyle {
  return WATER_STYLES.find((style) => style === value) ?? 'classic';
}

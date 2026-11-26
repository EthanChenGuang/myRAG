export type SettingValues = Readonly<Record<string, string | undefined | null>>;
export declare const HASHED_TEXT_NAMES: ReadonlySet<string>;
export declare function ragSettingsCanonical(
  values: SettingValues,
  names: Iterable<string>,
  isSecret?: (name: string) => boolean,
): string;
export declare function ragSettingsHash(
  values: SettingValues,
  names: Iterable<string>,
  isSecret?: (name: string) => boolean,
): string;
export declare function ragAffectingDiff(before: SettingValues, after: SettingValues, names: Iterable<string>): string[];

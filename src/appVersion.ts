import pkg from '../package.json';

/**
 * Live app version — read from the actual build config (package.json
 * `version`, mirrored in src-tauri/tauri.conf.json). Never hardcoded, so the
 * NavDrawer footer and About screen can never go stale (Spec §9.1 step 7,
 * §9.3).
 */
export const APP_VERSION: string =
  typeof pkg?.version === 'string' && pkg.version.length > 0 ? pkg.version : '0.0.0';

export const APP_NAME = 'KNOX Music';
export const APP_TAGLINE = 'Your music, your device, your control.';

import os from 'node:os';
import path from 'node:path';

/**
 * The user-level folder for the tool's own files (project registry, models): AI_SDLC_HELPER_CONFIG_DIR when set, else
 * %APPDATA%\ai-sdlc-helper on Windows, else $XDG_CONFIG_HOME/ai-sdlc-helper or ~/.config/ai-sdlc-helper.
 */
export function configDir(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  if (env.AI_SDLC_HELPER_CONFIG_DIR) return path.resolve(env.AI_SDLC_HELPER_CONFIG_DIR);
  const home = env.HOME || env.USERPROFILE || os.homedir();
  if (platform === 'win32') return path.win32.join(env.APPDATA || path.win32.join(home, 'AppData', 'Roaming'), 'ai-sdlc-helper');
  return path.posix.join(env.XDG_CONFIG_HOME || path.posix.join(home, '.config'), 'ai-sdlc-helper');
}

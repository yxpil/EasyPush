import { execFile } from 'node:child_process';

export type NetworkProfile = 'private' | 'public' | 'domain' | 'unknown';

export async function detectNetworkProfile(): Promise<NetworkProfile> {
  if (process.platform !== 'win32') return 'unknown';
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        'try { (Get-NetConnectionProfile | Select-Object -First 1).NetworkCategory } catch { }',
      ],
      { timeout: 3000, windowsHide: true },
      (error, stdout) => {
        if (error) return resolve('unknown');
        const value = stdout.trim().toLowerCase();
        if (value.includes('private')) resolve('private');
        else if (value.includes('public')) resolve('public');
        else if (value.includes('domain')) resolve('domain');
        else resolve('unknown');
      },
    );
  });
}

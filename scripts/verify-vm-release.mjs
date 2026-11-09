import { pathToFileURL } from 'node:url';

// Read-only checks. Never send credentials or request a retailer/purchase URL.
export async function verifyVmRelease(originValue, release, request = fetch) {
  const url = new URL(originValue);
  if (url.protocol !== 'https:' || url.origin !== originValue || !/^[a-f0-9]{40}-\d+-\d+$/.test(release)) throw new Error();
  const get = async (path) => {
    const response = await request(new URL(path, url), { redirect: 'error', signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error();
    return response;
  };
  for (const path of ['/', '/watchlist']) {
    const response = await get(path);
    if (!response.headers.get('content-type')?.includes('text/html') || !(await response.text()).includes('id="root"')) throw new Error();
  }
  const deployed = await (await get('/deployment.json')).json();
  if (deployed.release !== release) throw new Error();
  for (const [path, expected] of [['/api/health', 'ok'], ['/api/ready', 'ready']]) {
    const body = await (await get(path)).json();
    if (body.status !== expected || body.database !== 'connected') throw new Error();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await verifyVmRelease(...process.argv.slice(2));
    console.log('HTTPS frontend, exact release, API and database readiness passed.');
  } catch {
    console.error('Public release check failed. Inspect configuration privately; no response bodies or credentials are logged.');
    process.exitCode = 1;
  }
}

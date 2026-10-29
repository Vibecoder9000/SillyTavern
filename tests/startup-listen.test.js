import net from 'node:net';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from '@jest/globals';

const moduleUrl = new URL('../src/server-listen.js', import.meta.url).href;
const root = fileURLToPath(new URL('../', import.meta.url));

function probe(port, overrides = {}) {
    return spawnSync(process.execPath, ['--input-type=module', '-e', `
        import { ServerStartup } from ${JSON.stringify(moduleUrl)};
        const args = {
            enableIPv4: true, enableIPv6: false, ssl: false, listen: false,
            getIPv4ListenUrl: () => new URL('http://127.0.0.1:${port}'),
            getIPv6ListenUrl: () => new URL('http://[::1]:${port}'),
            ...${JSON.stringify(overrides)},
        };
        await new ServerStartup(undefined, args).start({ checkOnly: true });
        // A successful check must release the socket for the real server.
        const { createServer } = await import('node:net');
        const server = createServer();
        server.listen(${port}, '127.0.0.1', () => server.close());
    `], { cwd: root, encoding: 'utf8', timeout: 5000 });
}

describe('startup listener preflight', () => {
    test('releases an available port before initialization continues', async () => {
        const reservation = net.createServer();
        await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
        const port = reservation.address().port;
        await new Promise(resolve => reservation.close(resolve));
        const result = probe(port);
        expect(result.error).toBeUndefined();
        expect(result.status).toBe(0);
    });

    test('fails on an occupied configured port with an actionable error', async () => {
        const blocker = net.createServer();
        await new Promise(resolve => blocker.listen(0, '127.0.0.1', resolve));
        try {
            const result = probe(blocker.address().port);
            expect(result.status).toBe(1);
            expect(result.stderr).toContain('already in use');
            expect(result.stderr).toContain('Startup aborted');
        } finally {
            await new Promise(resolve => blocker.close(resolve));
        }
    });

    test('rejects configurations with both protocols disabled', () => {
        const result = probe(0, { enableIPv4: false });
        expect(result.status).toBe(1);
        expect(result.stderr).toContain('Both IPv6 and IPv4 are disabled');
    });

    test('rejects missing TLS credentials before application setup', () => {
        const result = probe(0, { ssl: true });
        expect(result.status).toBe(1);
        expect(result.stderr).toContain('SSL certificate path is required');
    });
});

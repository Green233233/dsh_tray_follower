// Loopback port helpers for the inspector injector.
//
// The inspector is always bound to 127.0.0.1 only. A preferred port is used when
// free (so users can attach manually / remember it), otherwise an ephemeral port
// is picked.

import net from 'node:net'

export function isPortFree(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      resolve(false)
      return
    }
    const server = net.createServer()
    server.once('error', () => resolve(false))
    server.once('listening', () => server.close(() => resolve(true)))
    try {
      server.listen(port, host)
    } catch (_error) {
      resolve(false)
    }
  })
}

/** Pick `preferred` when free, else an ephemeral free port. */
export async function pickFreePort(preferred, host = '127.0.0.1') {
  if (Number.isInteger(preferred) && preferred > 0 && preferred < 65536 && (await isPortFree(preferred, host))) {
    return preferred
  }
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, host, () => {
      const address = server.address()
      const port = address && typeof address === 'object' ? address.port : null
      server.close(() => {
        if (Number.isInteger(port) && port > 0) resolve(port)
        else reject(new Error('failed to allocate an ephemeral port'))
      })
    })
  })
}

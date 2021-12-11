import { resolve } from 'path'
import { nanoid } from 'nanoid'
import { RpcCall } from 'vitest'
import { install as installSourceMapSupport } from 'source-map-support'
import { distDir } from '../constants'
import { ResolvedConfig, RpcSend, WorkerContext } from '../types'
import { executeInViteNode, ExecuteOptions } from '../node/execute'

let _run: (files: string[], config: ResolvedConfig) => Promise<void>
const moduleCache: ExecuteOptions['moduleCache'] = new Map()

export async function init(ctx: WorkerContext) {
  if (_run)
    return _run

  const { config } = ctx

  _run = (await executeInViteNode({
    root: config.root,
    files: [
      resolve(distDir, 'runtime/entry.js'),
    ],
    fetch(id) {
      return process.__vitest_worker__.rpc('fetch', id)
    },
    inline: config.depsInline,
    external: config.depsExternal,
    interpretDefault: config.interpretDefault,
    moduleCache,
  }))[0].run

  installSourceMapSupport({
    environment: 'node',
    hookRequire: true,
    handleUncaughtExceptions: true,
    retrieveSourceMap: (id: string) => {
      const map = moduleCache.get(id)?.transformResult?.map
      if (map) {
        return {
          url: id,
          map: map as any,
        }
      }
      return null
    },
  })

  return _run
}

export default async function run(ctx: WorkerContext) {
  process.stdout.write('\0')

  const { config, port } = ctx
  const rpcPromiseMap = new Map<string, { resolve: ((...args: any) => any); reject: (...args: any) => any }>()

  process.__vitest_worker__ = {
    config,
    rpc: (method, ...args) => {
      return new Promise((resolve, reject) => {
        const id = nanoid()
        rpcPromiseMap.set(id, { resolve, reject })
        port.postMessage({ method, args, id })
      })
    },
    send(method, ...args) {
      port.postMessage({ method, args })
    },
  }

  port.addListener('message', async(data) => {
    const api = rpcPromiseMap.get(data.id)
    if (api) {
      if (data.error)
        api.reject(data.error)
      else
        api.resolve(data.result)
    }
  })

  const run = await init(ctx)

  if (ctx.invalidates)
    ctx.invalidates.forEach(i => moduleCache.delete(i))
  ctx.files.forEach(i => moduleCache.delete(i))

  return run(ctx.files, ctx.config)
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace NodeJS {
    interface Process {
      __vitest_worker__: {
        config: ResolvedConfig
        rpc: RpcCall
        send: RpcSend
      }
    }
  }
}
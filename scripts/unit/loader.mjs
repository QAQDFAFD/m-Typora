import { existsSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { fileURLToPath } from 'node:url'

registerHooks({
  resolve(specifier, context, nextResolve) {
    if ((specifier.startsWith('./') || specifier.startsWith('../')) && !/\.[a-z]+$/i.test(specifier) && context.parentURL) {
      const tsUrl = new URL(`${specifier}.ts`, context.parentURL)
      if (existsSync(fileURLToPath(tsUrl))) return nextResolve(tsUrl.href, context)
    }
    return nextResolve(specifier, context)
  }
})

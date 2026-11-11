import { Hono } from 'hono'
import type { HttpDeps } from '../app'
export function fillsRouter(_deps: HttpDeps): Hono {
  return new Hono()
}
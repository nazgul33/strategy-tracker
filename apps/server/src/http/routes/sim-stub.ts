import { Hono } from 'hono'
export function simStub(): Hono {
  return new Hono()
}
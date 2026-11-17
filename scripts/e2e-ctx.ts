/** Shared plumbing for the e2e step modules (scripts/e2e.ts drives them in order). */
export interface E2eCtx {
  ok: (cond: unknown, label: string) => void
  req: (method: string, path: string, body?: unknown, token?: string) => Response | Promise<Response>
  token: string
}

export const jsonOf = async (r: Response): Promise<any> => r.json()

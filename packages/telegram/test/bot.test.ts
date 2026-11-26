import { describe, test, expect, spyOn } from 'bun:test'
import { buildChoiceKeyboard, createBot } from '../src/bot'

const BOT_INFO = {
  id: 1,
  is_bot: true,
  first_name: 'b',
  username: 'b',
  can_join_groups: false,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
  has_topics_enabled: false,
  allows_users_to_create_topics: false,
  can_manage_bots: false,
  supports_join_request_queries: false,
} as const

function harness(
  onConfirm: (chatId: string, cbData: string, approved: boolean) => Promise<void> | void,
  failApi = false,
  onChoice: (chatId: string, cbData: string) => Promise<void> | void = () => {},
) {
  const order: string[] = []
  const calls: { method: string; payload: unknown }[] = []
  const bot = createBot({
    token: '1:x',
    allowedChatIds: ['111'],
    onPhoto() {},
    onConfirm: (chatId, cbData, approved) => {
      order.push('onConfirm')
      return onConfirm(chatId, cbData, approved)
    },
    onChoice: (chatId, cbData) => {
      order.push('onChoice')
      return onChoice(chatId, cbData)
    },
    onStatus() {},
    onOrders() {},
  })
  bot.botInfo = BOT_INFO
  bot.api.config.use(async (_prev, method, payload) => {
    order.push(method)
    calls.push({ method, payload })
    if (failApi) throw new Error('expired query')
    return { ok: true, result: true } as never
  })
  const press = (data: string, chatId = 111) =>
    bot.handleUpdate({
      update_id: 1,
      callback_query: {
        id: 'cb1',
        from: { id: 5, is_bot: false, first_name: 'u' },
        chat_instance: 'ci',
        data,
        message: { message_id: 3, date: 0, chat: { id: chatId, type: 'private', first_name: 'u' } },
      },
    } as never)
  return { press, order, calls }
}

describe('bot callback_query handler', () => {
  test("a pressed button calls onConfirm with the callback's chat id", async () => {
    const seen: [string, string, boolean][] = []
    const h = harness((chatId, cbData, approved) => void seen.push([chatId, cbData, approved]))
    await h.press('yes:9')
    await h.press('no:9')
    expect(seen).toEqual([
      ['111', 'yes:9', true],
      ['111', 'no:9', false],
    ])
  })

  test('the callback is answered before onConfirm runs', async () => {
    const h = harness(() => {})
    await h.press('yes:9')
    expect(h.order).toEqual(['answerCallbackQuery', 'onConfirm'])
    expect(h.calls[0]!.payload).toMatchObject({ callback_query_id: 'cb1' })
  })

  test('the callback is answered even when onConfirm throws', async () => {
    const h = harness(() => {
      throw new Error('boom')
    })
    await expect(h.press('yes:9')).rejects.toThrow()
    expect(h.calls.map((c) => c.method)).toEqual(['answerCallbackQuery'])
  })

  test('a failed answerCallbackQuery is logged and onConfirm still runs', async () => {
    const seen: string[] = []
    const h = harness((_c, cbData) => void seen.push(cbData), true)
    const errors = spyOn(console, 'error').mockImplementation(() => {})
    try {
      await h.press('yes:9')
      expect(seen).toEqual(['yes:9'])
      expect(errors).toHaveBeenCalled()
    } finally {
      errors.mockRestore()
    }
  })

  test('a handler error is logged and long polling keeps handling the next update', async () => {
    const seen: string[] = []
    const bot = createBot({
      token: '1:x',
      allowedChatIds: ['111'],
      onPhoto() {},
      onConfirm: (_chatId, cbData) => {
        seen.push(cbData)
        if (cbData === 'yes:1') throw new Error('boom')
      },
      onChoice() {},
      onStatus() {},
      onOrders() {},
    })
    bot.botInfo = BOT_INFO
    const update = (id: number, data: string) => ({
      update_id: id,
      callback_query: {
        id: `cb${id}`,
        from: { id: 5, is_bot: false, first_name: 'u' },
        chat_instance: 'ci',
        data,
        message: { message_id: 3, date: 0, chat: { id: 111, type: 'private', first_name: 'u' } },
      },
    })
    let polls = 0
    bot.api.config.use(async (_prev, method) => {
      if (method !== 'getUpdates') return { ok: true, result: true } as never
      polls++
      if (polls === 1) return { ok: true, result: [update(1, 'yes:1'), update(2, 'yes:2')] } as never
      await bot.stop()
      return { ok: true, result: [] } as never
    })
    const errors = spyOn(console, 'error').mockImplementation(() => {})
    try {
      await bot.start()
      expect(seen).toEqual(['yes:1', 'yes:2'])
      expect(errors.mock.calls).toEqual([['[bot] update failed:', 'Error: boom']])
    } finally {
      errors.mockRestore()
    }
  })

  test('a press in a chat that is not allowed does nothing', async () => {
    const seen: string[] = []
    const h = harness((_c, cbData) => void seen.push(cbData))
    await h.press('yes:9', 222)
    expect(seen).toEqual([])
    expect(h.calls).toEqual([])
  })
})

describe('bot strategy question buttons', () => {
  test('a cs: press reaches onChoice and not onConfirm, after the callback was answered', async () => {
    const confirmed: string[] = []
    const chosen: [string, string][] = []
    const h = harness((_c, cbData) => void confirmed.push(cbData), false, (chatId, cbData) => void chosen.push([chatId, cbData]))
    await h.press('cs:5:v')
    expect(chosen).toEqual([['111', 'cs:5:v']])
    expect(confirmed).toEqual([])
    expect(h.order).toEqual(['answerCallbackQuery', 'onChoice'])
  })

  test('yes: and no: presses still reach onConfirm with the same arguments and never onChoice', async () => {
    const confirmed: [string, string, boolean][] = []
    const chosen: string[] = []
    const h = harness((chatId, cbData, approved) => void confirmed.push([chatId, cbData, approved]), false, (_c, cbData) => void chosen.push(cbData))
    await h.press('yes:9')
    await h.press('no:9')
    expect(confirmed).toEqual([
      ['111', 'yes:9', true],
      ['111', 'no:9', false],
    ])
    expect(chosen).toEqual([])
  })

  test('data that only resembles the prefix still goes to onConfirm', async () => {
    const confirmed: string[] = []
    const chosen: string[] = []
    const h = harness((_c, cbData) => void confirmed.push(cbData), false, (_c, cbData) => void chosen.push(cbData))
    await h.press('cs5')
    await h.press('csv:1')
    expect(confirmed).toEqual(['cs5', 'csv:1'])
    expect(chosen).toEqual([])
  })

  test('the callback is answered even when onChoice throws', async () => {
    const h = harness(() => {}, false, () => {
      throw new Error('boom')
    })
    await expect(h.press('cs:5:v')).rejects.toThrow()
    expect(h.calls.map((c) => c.method)).toEqual(['answerCallbackQuery'])
  })

  test('a failed answerCallbackQuery is logged and onChoice still runs', async () => {
    const chosen: string[] = []
    const h = harness(() => {}, true, (_c, cbData) => void chosen.push(cbData))
    const errors = spyOn(console, 'error').mockImplementation(() => {})
    try {
      await h.press('cs:5:b')
      expect(chosen).toEqual(['cs:5:b'])
      expect(errors).toHaveBeenCalled()
    } finally {
      errors.mockRestore()
    }
  })

  test('a cs: press in a chat that is not allowed reaches nothing', async () => {
    const chosen: string[] = []
    const h = harness(() => {}, false, (_c, cbData) => void chosen.push(cbData))
    await h.press('cs:5:v', 222)
    expect(chosen).toEqual([])
    expect(h.calls).toEqual([])
  })

  test('buildChoiceKeyboard makes one row of three buttons', () => {
    expect(buildChoiceKeyboard('42', { mr: 'A', vr: 'B', both: 'C' })).toEqual({
      inline_keyboard: [[
        { text: 'A', callback_data: 'cs:42:m' },
        { text: 'B', callback_data: 'cs:42:v' },
        { text: 'C', callback_data: 'cs:42:b' },
      ]],
    })
  })

  test('every callback_data stays within 64 bytes for a ten-digit id', () => {
    for (const id of ['2147483647', '9999999999']) {
      for (const b of buildChoiceKeyboard(id, { mr: 'A', vr: 'B', both: 'C' }).inline_keyboard[0]!) {
        expect(Buffer.byteLength(b.callback_data, 'utf8')).toBeLessThanOrEqual(64)
      }
    }
  })
})

import { describe, test, expect, spyOn } from 'bun:test'
import { createBot } from '../src/bot'

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

function harness(onConfirm: (chatId: string, cbData: string, approved: boolean) => Promise<void> | void, failApi = false) {
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

  test('a press in a chat that is not allowed does nothing', async () => {
    const seen: string[] = []
    const h = harness((_c, cbData) => void seen.push(cbData))
    await h.press('yes:9', 222)
    expect(seen).toEqual([])
    expect(h.calls).toEqual([])
  })
})

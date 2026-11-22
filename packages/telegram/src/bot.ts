import { Bot } from 'grammy'

import { t } from './i18n'
import type { Lang } from './i18n'

export interface BotDeps {
  token: string
  allowedChatIds: string[]
  lang?: Lang
  onPhoto(chatId: string, image: { base64: string; mime: string }, caption?: string): Promise<void> | void
  onConfirm(chatId: string, cbData: string, approved: boolean): Promise<void> | void
  onStatus(chatId: string): Promise<void> | void
  onOrders(chatId: string): Promise<void> | void
}

export function createBot(deps: BotDeps): Bot {
  const bot = new Bot(deps.token)
  const lang = deps.lang ?? 'en'
  const allowed = new Set(deps.allowedChatIds)

  function gate(chatId: string): boolean {
    return allowed.has(chatId)
  }

  bot.command('start', async (ctx) => {
    const chatId = String(ctx.chat?.id ?? '')
    if (!gate(chatId)) return
    await ctx.reply(t('start', lang))
  })
  bot.command('status', async (ctx) => {
    const chatId = String(ctx.chat?.id ?? '')
    if (!gate(chatId)) return
    await deps.onStatus(chatId)
  })
  bot.command('orders', async (ctx) => {
    const chatId = String(ctx.chat?.id ?? '')
    if (!gate(chatId)) return
    await deps.onOrders(chatId)
  })
  bot.command('help', async (ctx) => {
    const chatId = String(ctx.chat?.id ?? '')
    if (!gate(chatId)) return
    await ctx.reply(t('help', lang))
  })

  bot.on('message:photo', async (ctx) => {
    const chatId = String(ctx.chat?.id ?? '')
    if (!gate(chatId)) return
    const photos = ctx.message?.photo
    if (!photos || photos.length === 0) return
    const photo = photos[photos.length - 1]
    const file = await ctx.api.getFile(photo.file_id)
    const url = `https://api.telegram.org/file/bot${deps.token}/${file.file_path}`
    const res = await fetch(url)
    const buf = await res.arrayBuffer()
    const base64 = Buffer.from(buf).toString('base64')
    // Bot API 9 dropped mime_type from File — photos always arrive as JPEG.
    const mime = (file as { mime_type?: string }).mime_type ?? 'image/jpeg'
    await deps.onPhoto(chatId, { base64, mime }, ctx.message?.caption)
  })

  bot.on('callback_query:data', async (ctx) => {
    const chatId = String(ctx.chat?.id ?? '')
    if (!gate(chatId)) return
    const data = ctx.callbackQuery?.data ?? ''
    try {
      await ctx.answerCallbackQuery()
    } catch (e) {
      console.error('[bot] answerCallbackQuery failed:', String(e))
    }
    await deps.onConfirm(chatId, data, data.startsWith('yes:'))
  })

  return bot
}

export function buildPendingKeyboard(id: string) {
  return {
    inline_keyboard: [[{ text: 'Yes', callback_data: `yes:${id}` }, { text: 'No', callback_data: `no:${id}` }]],
  }
}

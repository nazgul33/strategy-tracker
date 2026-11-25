// Telegram drops a message over 4096 characters; stay under it with margin.
const MAX_REPLY = 4000

/** Blocks joined by a blank line while they fit one message, else several messages split only between blocks. */
export function packBlocks(blocks: string[]): string[] {
  const messages: string[] = []
  let current = ''
  for (const block of blocks) {
    const joined = current === '' ? block : `${current}\n\n${block}`
    if (current !== '' && joined.length > MAX_REPLY) {
      messages.push(current)
      current = block
    } else {
      current = joined
    }
  }
  if (current !== '') messages.push(current)
  return messages
}

export async function sendBlocks(send: (chatId: string, text: string) => Promise<void>, chatId: string, blocks: string[]): Promise<void> {
  for (const text of packBlocks(blocks)) await send(chatId, text)
}

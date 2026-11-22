import type { CaptureDeps } from './capture';

export interface MessageApi {
  sendMessage(chatId: string, text: string, other?: Record<string, unknown>): Promise<unknown>;
}

// Typed against the capture `send` so the third argument (the inline keyboard) cannot be dropped again.
export function makeSend(getApi: () => MessageApi | null, log: (line: string) => void = console.log): CaptureDeps['send'] {
  return async (chatId, text, extra) => {
    const api = getApi();
    if (!api) {
      log(`[send:${chatId}] ${text.slice(0, 120)}`);
      return;
    }
    await api.sendMessage(chatId, text, extra);
  };
}

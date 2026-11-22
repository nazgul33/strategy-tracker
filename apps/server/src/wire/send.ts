import type { CaptureDeps } from './capture';

export interface MessageApi {
  sendMessage(chatId: string, text: string, other?: Record<string, unknown>): Promise<unknown>;
}

// The type alone does not stop the third argument (the inline keyboard) being dropped: a
// two-parameter function is still assignable. The `forwards the reply markup` test in
// send.test.ts guards it.
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

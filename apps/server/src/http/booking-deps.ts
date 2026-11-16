import type { BookingDeps } from '../domain/booking'
import { makeSiblingNotifier } from '../wire/sibling-notifier'
import type { HttpDeps } from './app'

// The BookingDeps for routes that book fills (manual fill, pending confirm). Built per
// request so the settings and send hook are read when the fill arrives.
export function fillBookingDeps(deps: HttpDeps): BookingDeps {
  return {
    repos: deps.repos,
    today: deps.today() as BookingDeps['today'],
    notifySiblingCancelled: makeSiblingNotifier({
      repos: deps.repos,
      allowedChatIds: deps.allowedChatIds,
      send: deps.send,
      lang: deps.defaultSettings.digestLang,
    }),
  }
}

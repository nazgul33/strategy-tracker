import type { BookingDeps, FillBookingDeps } from '../domain/booking'
import { makeBookingNotifier } from '../wire/booking-notifier'
import type { HttpDeps } from './app'

// The FillBookingDeps for routes that book fills (manual fill, pending confirm). Built per
// request so the settings and send hook are read when the fill arrives.
export function fillBookingDeps(deps: HttpDeps): FillBookingDeps {
  return {
    repos: deps.repos,
    today: deps.today() as BookingDeps['today'],
    notify: makeBookingNotifier({
      repos: deps.repos,
      allowedChatIds: deps.allowedChatIds,
      send: deps.send,
      lang: deps.defaultSettings.digestLang,
    }),
  }
}

import { describe, test, expect } from 'bun:test'
import { loadNoticePage } from '../src/domain/notice-feed'

// rows get ids 1..n in the order given (oldest first)
function feed(rows: Array<[runId: number | null, chatId: string, text: string]>) {
  const all = rows.map(([runId, chatId, text], i) => ({ id: i + 1, runId, chatId, text, sentAt: `t${i + 1}` }))
  const repo = {
    listBefore: async (before: number | null, limit: number) =>
      all.filter((r) => before === null || r.id < before).sort((a, b) => b.id - a.id).slice(0, limit),
  }
  return { repo, all }
}
const ids = (p: { entries: { id: number }[] }) => p.entries.map((e) => e.id)
const chats = (p: { entries: { chatIds: string[] }[] }) => p.entries.map((e) => e.chatIds)

describe('loadNoticePage', () => {
  test('an empty table is an empty last page', async () => {
    expect(await loadNoticePage(feed([]).repo, null, 20)).toEqual({ entries: [], nextBefore: null })
  })

  test('newest first, one entry per distinct message', async () => {
    const p = await loadNoticePage(feed([[5, 'a', 'x'], [5, 'a', 'y'], [null, 'a', 'z']]).repo, null, 20)
    expect(ids(p)).toEqual([3, 2, 1])
    expect(p.entries[0]).toEqual({ id: 3, runId: null, text: 'z', sentAt: 't3', chatIds: ['a'] })
  })

  test('per-chat rows of one broadcast collapse, anchored on the newest row', async () => {
    const p = await loadNoticePage(feed([[5, 'a', 'x'], [5, 'b', 'x']]).repo, null, 20)
    expect(p.entries).toEqual([{ id: 2, runId: 5, text: 'x', sentAt: 't2', chatIds: ['a', 'b'] }])
  })

  test('the same text for another run is another entry', async () => {
    expect(ids(await loadNoticePage(feed([[5, 'a', 'x'], [6, 'a', 'x']]).repo, null, 20))).toEqual([2, 1])
  })

  test('the same text repeated to the same chat is another entry', async () => {
    const p = await loadNoticePage(feed([[null, 'web', 'r'], [null, 'web', 'r']]).repo, null, 20)
    expect(ids(p)).toEqual([2, 1])
    expect(chats(p)).toEqual([['web'], ['web']])
  })

  test('the same text broadcast twice to two chats is two entries', async () => {
    const p = await loadNoticePage(feed([[null, 'a', 'r'], [null, 'b', 'r'], [null, 'a', 'r'], [null, 'b', 'r']]).repo, null, 20)
    expect(ids(p)).toEqual([4, 2])
    expect(chats(p)).toEqual([['a', 'b'], ['a', 'b']])
  })

  test('rows that are not adjacent do not collapse', async () => {
    expect(ids(await loadNoticePage(feed([[5, 'a', 'x'], [5, 'a', 'y'], [5, 'b', 'x']]).repo, null, 20))).toEqual([3, 2, 1])
  })

  test('pages never repeat or split a group', async () => {
    const rows: Array<[number | null, string, string]> = []
    for (let m = 1; m <= 5; m++) rows.push([null, 'a', `m${m}`], [null, 'b', `m${m}`])
    const { repo } = feed(rows)
    const p1 = await loadNoticePage(repo, null, 2)
    const p2 = await loadNoticePage(repo, p1.nextBefore, 2)
    const p3 = await loadNoticePage(repo, p2.nextBefore, 2)
    expect([ids(p1), ids(p2), ids(p3)]).toEqual([[10, 8], [6, 4], [2]])
    expect([p1.nextBefore, p2.nextBefore, p3.nextBefore]).toEqual([7, 3, null])
    for (const p of [p1, p2, p3]) for (const c of chats(p)) expect(c).toEqual(['a', 'b'])
  })

  test('a group wider than the page is still whole', async () => {
    const { repo } = feed([[null, 'a', 'm1'], [null, 'b', 'm1'], [null, 'c', 'm1'], [null, 'a', 'm2'], [null, 'b', 'm2'], [null, 'c', 'm2']])
    const p1 = await loadNoticePage(repo, null, 1)
    expect(ids(p1)).toEqual([6])
    expect(chats(p1)).toEqual([['a', 'b', 'c']])
    expect(p1.nextBefore).toBe(4)
    const p2 = await loadNoticePage(repo, 4, 1)
    expect(ids(p2)).toEqual([3])
    expect(p2.nextBefore).toBeNull()
  })

  test('exactly one full page has no next page', async () => {
    const p = await loadNoticePage(feed([[null, 'a', 'x'], [null, 'a', 'y']]).repo, null, 2)
    expect(ids(p)).toEqual([2, 1])
    expect(p.nextBefore).toBeNull()
  })

  test('rows written after page one do not shift page two', async () => {
    const { repo, all } = feed([[null, 'a', 'w'], [null, 'a', 'x'], [null, 'a', 'y'], [null, 'a', 'z']])
    const p1 = await loadNoticePage(repo, null, 2)
    all.push({ id: 5, runId: null, chatId: 'a', text: 'n5', sentAt: 't5' }, { id: 6, runId: null, chatId: 'a', text: 'n6', sentAt: 't6' })
    const p2 = await loadNoticePage(repo, p1.nextBefore, 2)
    expect(ids(p1)).toEqual([4, 3])
    expect(p1.nextBefore).toBe(3)
    expect(ids(p2)).toEqual([2, 1])
  })

  test('a group straddling a batch boundary is still one entry', async () => {
    // limit 1 reads 3 rows per batch: the 4-chat message (ids 5..2) spans two batches
    const { repo } = feed([[null, 'z', 'old'], [null, 'a', 'm'], [null, 'b', 'm'], [null, 'c', 'm'], [null, 'd', 'm']])
    const p1 = await loadNoticePage(repo, null, 1)
    expect(ids(p1)).toEqual([5])
    expect(chats(p1)).toEqual([['a', 'b', 'c', 'd']])
    expect(p1.nextBefore).toBe(2)
    const p2 = await loadNoticePage(repo, p1.nextBefore, 1)
    expect(ids(p2)).toEqual([1])
    expect(p2.nextBefore).toBeNull()
  })
})

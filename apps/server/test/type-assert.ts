export type Expect<T extends true> = T
export type IsNever<T> = [T] extends [never] ? true : false

// Full parameter count: optional parameters count too.
type FullCount<M> = NonNullable<M> extends (...args: infer P) => unknown ? Required<P>['length'] : never

type SameCount<A, B> = [FullCount<A>] extends [FullCount<B>] ? ([FullCount<B>] extends [FullCount<A>] ? true : false) : false

// `${repo}.${method}` for every repository and method present on both sides
// whose full parameter count differs; never when all match. A method that takes
// fewer parameters than the surface silently ignores an argument the caller passes.
export type ArityMismatches<Impl, Surface> = {
  [R in keyof Impl & keyof Surface & string]-?: {
    [M in keyof Impl[R] & keyof Surface[R] & string]-?: SameCount<Impl[R][M], Surface[R][M]> extends true ? never : `${R}.${M}`
  }[keyof Impl[R] & keyof Surface[R] & string]
}[keyof Impl & keyof Surface & string]

/**
 * Report whether an object member name is a Specification Extension: a name that begins with
 * `x-`. The prefix is case-sensitive, so `X-a` is an ordinary member name.
 */
export const isSpecificationExtension = (key: string): boolean => key.startsWith("x-");

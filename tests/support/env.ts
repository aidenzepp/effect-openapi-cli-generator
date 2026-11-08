/**
 * Sets the environment variable `name` to `value` and returns a function that restores the prior
 * state: it deletes the variable when it was unset and reassigns the prior value otherwise.
 * Assigning `undefined` to `process.env` would store the string "undefined", so restoring needs
 * the delete.
 */
export const setEnv = (name: string, value: string): (() => void) => {
  const prior = process.env[name];
  process.env[name] = value;

  return () => {
    if (prior === undefined) {
      Reflect.deleteProperty(process.env, name);
    } else {
      process.env[name] = prior;
    }
  };
};

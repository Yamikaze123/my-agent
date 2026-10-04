// A fixture lookup, Python execution, up to two coding retries, and a final
// summary can require five LLM steps. The processor below still forces a text
// response on the final step.
export const MAX_AGENT_STEPS = 5;

export function requiredEnvironmentVariable(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is not defined in environment variables.`);
  }
  return value;
}

const INITIAL_DAEMON_DEBUG_ENV_KEYS = ["FORGE_DEBUG_BACKGROUND_TASKS"] as const;

export const resolveDaemonProcessEnv = (
  env: NodeJS.ProcessEnv,
  initialEnv: NodeJS.ProcessEnv = env,
): NodeJS.ProcessEnv => {
  const nextEnv = { ...env };
  delete nextEnv.FORGE_PORT;
  delete nextEnv.FORGE_AUTH_TOKEN;
  delete nextEnv.FORGE_MODE;
  delete nextEnv.FORGE_NO_BROWSER;
  delete nextEnv.FORGE_HOST;

  for (const key of INITIAL_DAEMON_DEBUG_ENV_KEYS) {
    const currentValue = nextEnv[key];
    const initialValue = initialEnv[key];

    if (
      (currentValue === undefined || currentValue.length === 0) &&
      initialValue !== undefined &&
      initialValue.length > 0
    ) {
      nextEnv[key] = initialValue;
    }
  }

  return nextEnv;
};

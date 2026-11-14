export function applyBenchmarkPromptProfile(options) {
  if (!options || typeof options.appendSystemPrompt !== 'string' ||
      !/^BENCHMARK_PROMPT_PROFILE=clean$/m.test(options.appendSystemPrompt)) return false;
  options.contextFiles = [];
  options.skills = [];
  return true;
}
